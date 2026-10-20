import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';
import { semanticPokemonAction, resolvePokemonAction, semanticActionHash, ActionExecutionLedger } from '../integrations/pokemon-action.mjs';
import { SupervisedBridge } from '../integrations/official-client/supervisor.mjs';
import { ordinaryFixture } from '../integrations/official-client/fixtures.mjs';

const modelOrigin = { kind: 'model', id: 'frozen-model2' };
function projection(rawId = 'fixture-attach') {
  const raw = ordinaryFixture().policyView;
  raw.actions[0].id = rawId;
  const projector = new PolicyView();
  const view = projector.project(raw);
  return { projector, view };
}

test('one semantic candidate round-trips through three adapter action identities without UI knowledge', () => {
  let reference;
  for (const adapter of ['native-simulator', 'local-ui', 'official-client']) {
    const { view, projector } = projection(`${adapter}/private-action`);
    const semantic = semanticPokemonAction(view, { actionId: view.actions[0].id }, modelOrigin);
    assert.deepEqual(resolvePokemonAction(semantic, view, projector), { actionId: `${adapter}/private-action` });
    assert.equal(semantic.action.sourceCardId, view.hand[0].instanceId);
    assert.equal(semantic.action.targetId, view.you.active.instanceId);
    assert.ok(Object.isFrozen(semantic.action));
    assert.doesNotMatch(JSON.stringify(semantic), /private-action|window|screenshot|coordinate|focus|transport/);
    if (reference) assert.deepEqual(semantic, reference);
    reference = semantic;
  }
});

test('stale revisions, changed targets, foreign choices and UI fields cannot be resolved', () => {
  const { view, projector } = projection();
  const semantic = semanticPokemonAction(view, { actionId: view.actions[0].id }, modelOrigin);
  assert.throws(() => resolvePokemonAction(semantic, { ...view, revision: 2 }, projector), /stale-semantic/);
  const changed = { ...view, actions: [{ ...view.actions[0], targetId: 'card-999' }] };
  assert.throws(() => resolvePokemonAction(semantic, changed, projector), /changed-semantic/);
  assert.throws(() => semanticPokemonAction(view, { actionId: 'foreign' }, modelOrigin), /illegal-semantic/);
  assert.throws(() => semanticPokemonAction(view, { actionId: view.actions[0].id, x: 10 }, modelOrigin), /unsupported-semantic/);
  assert.throws(() => resolvePokemonAction({ ...semantic, window: 123 }, view, projector), /stale-semantic/);
});

test('model receives only the existing game view; driver mappings and helper attribution stay outside it', async () => {
  for (const origin of [modelOrigin, { kind: 'helper', id: 'explicit-fallback-policy', reason: 'ordinary-fallback' }]) {
    const input = ordinaryFixture();
    input.mappings[0].target.elementId = 'PRIVATE-UI-CONTROL';
    const bridge = new SupervisedBridge({ window: input.window, now: () => 10000 });
    bridge.arm();
    const intent = await bridge.propose(input, { decide: async context => {
      assert.deepEqual(Object.keys(context), ['view']);
      assert.doesNotMatch(JSON.stringify(context), /PRIVATE-UI-CONTROL|capturedAt|window|mappings|focused/);
      return { actionId: context.view.actions[0].id };
    } }, origin);
    assert.deepEqual(intent.semanticAction.attribution, origin);
    assert.equal(intent.target.elementId, 'PRIVATE-UI-CONTROL');
    assert.doesNotMatch(JSON.stringify(intent.semanticAction), /PRIVATE-UI-CONTROL/);
    assert.equal(bridge.decisionCounts.policyDecisions, 0);
    assert.equal(bridge.decisionAudit[0].policyKind, origin.kind);
    bridge.kill();
  }
});

test('impossible mappings and stale captures stop before policy inference', async () => {
  for (const alter of [input => { input.mappings = []; }, input => { input.capturedAt = 1; }]) {
    const input = ordinaryFixture(); alter(input);
    const bridge = new SupervisedBridge({ window: input.window, now: () => 10000 });
    let decisions = 0;
    bridge.arm();
    await assert.rejects(bridge.propose(input, { decide: async () => { decisions++; return {}; } }));
    assert.equal(decisions, 0);
    assert.equal(bridge.decisionCounts.policyDecisions, 0);
    assert.equal(bridge.decisionCounts.recommendations, 0);
  }
});

test('driver failure and fixtures never count as policy decisions or eligible training', () => {
  const { view } = projection();
  const semantic = semanticPokemonAction(view, { actionId: view.actions[0].id }, modelOrigin);
  const ledger = new ActionExecutionLedger();
  ledger.propose('attempt-1', semantic);
  assert.deepEqual(ledger.complete('attempt-1', { kind: 'driver-failure', error: 'PRIVATE-TRANSPORT-ERROR' }), { trainingEligible: false });
  ledger.propose('attempt-2', semantic);
  assert.deepEqual(ledger.complete('attempt-2', { kind: 'fixture-transition' }), { trainingEligible: false });
  assert.equal(ledger.counts.policyDecisions, 0);
  assert.equal(ledger.counts.driverFailures, 1);
  assert.equal(ledger.counts.fixtureTransitions, 1);
  assert.doesNotMatch(JSON.stringify(ledger.audit), /PRIVATE|Dragapult|Fire|card-/);
  assert.throws(() => ledger.complete('attempt-1', { kind: 'verified-game-action' }), /invalid-ledger/);
  ledger.propose('attempt-3', semantic);
  assert.throws(() => ledger.complete('attempt-3', { kind: 'verified-game-action' }), /proof-required/);
  const proof = { adapter: 'native-simulator', semanticHash: semanticActionHash(semantic), fromRevision: 1, toRevision: 2 };
  assert.deepEqual(ledger.complete('attempt-3', { kind: 'verified-game-action', proof }), { trainingEligible: true });
  assert.equal(ledger.counts.policyDecisions, 1);
});

test('helper attribution is mandatory and survives separate outcome accounting', () => {
  const { view } = projection();
  const choice = { actionId: view.actions[0].id };
  assert.throws(() => semanticPokemonAction(view, choice, { kind: 'helper', id: 'fallback' }), /attribution/);
  const helper = semanticPokemonAction(view, choice, { kind: 'helper', id: 'fallback-policy', reason: 'ordinary-fallback' });
  const ledger = new ActionExecutionLedger();
  ledger.propose('helper-1', helper);
  const proof = { adapter: 'native-simulator', semanticHash: semanticActionHash(helper), fromRevision: 1, toRevision: 2 };
  assert.deepEqual(ledger.complete('helper-1', { kind: 'verified-game-action', proof }), { trainingEligible: false });
  assert.equal(ledger.counts.policyDecisions, 0);
  assert.equal(ledger.counts.helperDecisions, 1);
  assert.equal(ledger.audit[1].reason, 'ordinary-fallback');
});
