import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisedBridge } from '../integrations/official-client/supervisor.mjs';
import { ordinaryFixture, reportedLobbyFixture } from '../integrations/official-client/fixtures.mjs';
import { agentPult, auditAgentPult } from '../integrations/official-client/compatibility.mjs';

const model = { decide: async ({ view }) => ({ actionId: view.actions[0].id }) };
function session(options = {}) {
  let time = 10000, sequence = 0;
  const bridge = new SupervisedBridge({ window: ordinaryFixture().window, now: () => time, ...options });
  return { bridge, advance: (ms = 1) => { time += ms; },
    capture: () => ({ ...ordinaryFixture(time), id: `capture-${++sequence}` }) };
}

test('starts disarmed and exposes a human-readable, single-use dry-run intent', async () => {
  const s = session();
  assert.equal(s.bridge.status, 'disarmed');
  await assert.rejects(s.bridge.propose(s.capture(), model), /bridge-not-armed/);
  s.bridge.arm();
  const intent = await s.bridge.propose(s.capture(), model);
  assert.equal(intent.mode, 'dry-run');
  assert.equal(intent.actionKind, 'play');
  assert.match(intent.target.label, /Fire Energy.*Dragapult ex/);
  assert.deepEqual(intent.expected, { screen: 'playing', revision: 2 });
  s.advance();
  assert.equal(s.bridge.step(intent.id, s.capture()).execution, 'not-sent');
  assert.equal(s.bridge.status, 'awaiting-transition');
  assert.throws(() => s.bridge.step(intent.id, s.capture()), /no-current-proposal/);
  await assert.rejects(s.bridge.propose(s.capture(), model), /bridge-not-armed/);
  s.bridge.kill();
  assert.throws(() => s.bridge.arm(), /bridge-killed/);
});

test('requires a new capture, exact proposal, unchanged state and original proposal age', async () => {
  for (const [change, reason] of [
    [s => s.original, /fresh-capture-required/],
    [s => { const v = s.capture(); v.policyView.you.prizes = 5; return v; }, /state-changed/],
    [s => { s.advance(2001); return s.capture(); }, /stale-proposal/]
  ]) {
    const s = session(); s.bridge.arm(); s.original = s.capture();
    const intent = await s.bridge.propose(s.original, model);
    s.advance();
    assert.throws(() => s.bridge.step(intent.id, change(s)), reason);
    assert.equal(s.bridge.status, 'paused');
  }
  const s = session(); s.bridge.arm(); await s.bridge.propose(s.capture(), model); s.advance();
  assert.throws(() => s.bridge.step('foreign-proposal', s.capture()), /proposal-mismatch/);
});

test('unknown and mismatched observations stop before any model decision', async () => {
  const cases = [
    [v => { v.capturedAt -= 2001; }, /stale-observation/],
    [v => { v.capturedAt += 1; }, /stale-observation/],
    [v => { v.window.visible = false; }, /window-not-visible/],
    [v => { v.window.focused = true; }, /background-window-required/],
    [v => { delete v.window.focused; }, /background-window-required/],
    [v => { v.window.id = 2; }, /window-mismatch/],
    [v => { v.window.app = 'foreign'; }, /window-mismatch/],
    [v => { v.deckDisplayName = 'Generic Dragapult'; }, /deck-mismatch/],
    [v => { v.unknowns = ['hand']; }, /unknown-state/],
    [v => { v.source = 'simulator-authority'; }, /unsupported-source/],
    [v => { v.screen = 'lobby'; }, /unsupported-screen/],
    [v => { v.compatibility.cardsVerified = false; }, /compatibility-gap/],
    [v => { v.policyView = null; }, /invalid-policy-view/],
    [v => { v.mappings = []; }, /candidate-mapping-mismatch/],
    [v => { v.mappings[0].actionId = 'foreign'; }, /candidate-mapping-mismatch/],
    [v => { v.mappings[0].target.elementId = ''; }, /invalid-mapping/],
    [v => { v.policyView.turn = 'opponent'; }, /unsupported-policy-state/],
    [v => { v.policyView.prompts = [{ id: 'p', kind: 'confirm', min: 0, max: 1, cancelable: true, ordered: false, groups: [], choices: [] }]; }, /unsupported-prompt/]
  ];
  for (const [change, reason] of cases) {
    const s = session(); s.bridge.arm(); const v = s.capture(); change(v);
    let called = false;
    await assert.rejects(s.bridge.propose(v, { decide: async () => { called = true; return {}; } }), reason);
    assert.equal(called, false);
    assert.equal(s.bridge.status, 'paused');
  }
});

test('pause and kill invalidate late inference; illegal choices stop with a fixed error', async () => {
  for (const control of ['pause', 'kill']) {
    const s = session(); s.bridge.arm(); let resolve;
    const pending = s.bridge.propose(s.capture(), { decide: () => new Promise(accept => { resolve = accept; }) });
    await Promise.resolve();
    s.bridge[control](); resolve({ actionId: 'r1/action/0' });
    await assert.rejects(pending, /proposal-cancelled/);
    assert.equal(s.bridge.status, control === 'kill' ? 'killed' : 'paused');
  }
  const s = session(); s.bridge.arm();
  await assert.rejects(s.bridge.propose(s.capture(), { decide: async () => ({ actionId: 'foreign' }) }), /illegal-model-choice/);
  assert.equal(s.bridge.status, 'paused');
});

test('only expected fixture transitions release the wait; rates and timeouts stop', async () => {
  const s = session(); s.bridge.arm();
  let intent = await s.bridge.propose(s.capture(), model); s.advance(); s.bridge.step(intent.id, s.capture());
  s.advance();
  const next = s.capture(); next.policyView.revision = 2; next.mappings[0].expected.revision = 3;
  assert.equal(s.bridge.observe(next).status, 'armed');
  assert.equal(s.bridge.decisionCounts.fixtureTransitions, 1);
  assert.equal(s.bridge.decisionCounts.policyDecisions, 0);
  intent = await s.bridge.propose({ ...next, id: 'next-proposal' }, model);
  s.advance();
  assert.throws(() => s.bridge.step(intent.id, { ...next, id: 'next-fresh', capturedAt: next.capturedAt + 1 }), /action-rate-limited/);
  assert.equal(s.bridge.status, 'paused');

  for (const mutation of ['timeout', 'mismatch', 'prompt']) {
    const t = session(); t.bridge.arm();
    const p = await t.bridge.propose(t.capture(), model); t.advance(); t.bridge.step(p.id, t.capture());
    if (mutation === 'timeout') { t.advance(5000); assert.equal(t.bridge.status, 'paused'); }
    else {
      t.advance(); const v = t.capture();
      if (mutation === 'prompt') v.policyView.prompts = [{ id: 'p', kind: 'unsupported', min: 0, max: 0, cancelable: false, ordered: false, groups: [], choices: [] }];
      assert.throws(() => t.bridge.observe(v), mutation === 'prompt' ? /unsupported-prompt/ : /transition-mismatch/);
      assert.equal(t.bridge.status, 'paused');
    }
    assert.equal(t.bridge.decisionCounts.driverFailures, 1);
    assert.equal(t.bridge.decisionCounts.policyDecisions, 0);
    t.bridge.kill();
  }
});

test('player whitelist excludes private extra fields; logs exclude cards and model errors', async () => {
  const s = session(); s.bridge.arm(); const v = s.capture();
  v.policyView.opponent.hand = ['PRIVATE-HAND']; v.policyView.opponent.deck = ['PRIVATE-ORDER'];
  v.policyView.accounts = 'PRIVATE-ACCOUNT';
  await s.bridge.propose(v, { decide: async ({ view }) => {
    const serialized = JSON.stringify(view);
    assert.doesNotMatch(serialized, /PRIVATE/);
    assert.ok(Object.isFrozen(view));
    return { actionId: view.actions[0].id };
  } });
  assert.doesNotMatch(JSON.stringify(s.bridge.audit), /PRIVATE|Fire|Dragapult|fixture-energy/);
  s.bridge.pause(); s.bridge.arm();
  await assert.rejects(s.bridge.propose(s.capture(), { decide: async () => { throw new Error('PRIVATE-ERROR'); } }), /model-failed/);
  assert.doesNotMatch(JSON.stringify(s.bridge.audit), /PRIVATE/);
});

test('declines revision regression, constructor senders, and unverified reported lobby', async () => {
  assert.throws(() => new SupervisedBridge({ window: ordinaryFixture().window, send: () => {} }), /invalid-config/);
  const s = session(); s.bridge.arm(); const v = s.capture(); v.policyView.revision = 2; v.mappings[0].expected.revision = 3;
  await s.bridge.propose(v, model); s.bridge.pause(); s.bridge.arm();
  await assert.rejects(s.bridge.propose(s.capture(), model), /stale-revision/);
  s.bridge.arm();
  await assert.rejects(s.bridge.propose(reportedLobbyFixture(), model), /unknown-state/);
});

test('manifest retains exact 60-card historical list and fails closed without evidence', () => {
  assert.equal(agentPult.displayName, 'AgentPult');
  assert.equal(agentPult.cards.filter(c => c.category === 'pokemon').reduce((s, c) => s + c.count, 0), 19);
  assert.equal(agentPult.cards.filter(c => c.category === 'trainer').reduce((s, c) => s + c.count, 0), 32);
  assert.equal(agentPult.cards.filter(c => c.category === 'energy').reduce((s, c) => s + c.count, 0), 9);
  assert.equal(auditAgentPult().readyForClientInference, false);
  assert.ok(auditAgentPult().cards.every(c => c.gameplayVerified === false));
});
