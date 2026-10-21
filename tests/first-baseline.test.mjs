import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AgentBundle } from '../integrations/local-worker/agent-bundle.mjs';
import { runNativeGame } from '../environment/native-game.mjs';
import { firstBaseline } from '../agents/first-baseline.mjs';
import { hashFile, readJson, recordedSources, foundationFiles, verifyFrozenRuntime } from '../environment/frozen-runtime.mjs';

const catalog = { printingAliases: {}, cardIds: {}, cards: [{}] };
const view = (revision = 0) => ({ revision, turnNumber: 0, status: 'playing', turn: 'you',
  hand: [], you: { active: null, bench: [], discard: [] }, opponent: { active: null, bench: [], discard: [] },
  actions: [{ id: `r${revision}/action/0`, kind: 'pass' }], prompts: [] });
const bundle = (extra = {}) => new AgentBundle({ catalog, encode: v => ({ candidates: v.prompts[0]?.choices ?? v.actions }),
  ordinary: { async act() { return [{ actionIndex: 0, oldLogProb: 0, oldValue: 2 }]; } },
  selection: { async rankChoices() { return [1, 0]; } }, supportsCardSelection: () => true,
  rankedPromptAnswers: function* (v) { yield { promptId: v.prompts[0].id, choiceIds: ['b'] }; },
  historyMode: 'complete-game', pins: firstBaseline, ...extra });

test('reference singleton uses current native mask; optional selections keep lazy ranked fallback', async () => {
  const v = view(); v.prompts = [{ id: 'p', min: 1, max: 1, ordered: false, choices: [{ id: 'a' }, { id: 'b' }] }];
  let seen;
  const agent = bundle({ ordinary: { async act([encoded], options) {
    seen = encoded; assert.equal(options.deterministic, true); return [{ actionIndex: 1 }];
  } } });
  const enriched = agent.observe(v);
  const proposal = await agent.propose(enriched, { validate: async d => d.choiceIds[0] === 'b' });
  assert.deepEqual(seen.legalMask, [false, true]); assert.equal(seen.selectionCardinality, 1);
  assert.deepEqual(proposal.decisions, [{ promptId: 'p', choiceIds: ['b'] }]);
  await assert.rejects(agent.propose(enriched, { validate: async () => false }), /no native-valid/);
  v.prompts[0].min = 0;
  const ranked = await agent.propose(v); assert.equal(ranked.source, 'selection');
  assert.deepEqual([...ranked.decisions], [{ promptId: 'p', choiceIds: ['b'] }]);
});

test('history records only accepted actions, resets on turn change and rejects missing complete history', () => {
  const agent = bundle(), v = view(); v.hand = [{ instanceId: 'e', category: 'energy' }];
  v.actions = [{ id: 'a', kind: 'play', sourceCardId: 'e' }];
  assert.equal(agent.observe(v).decisionContext.usage.energyPlayed.value, false);
  agent.accepted(v, { actionId: 'a' });
  assert.equal(agent.observe({ ...v, revision: 1 }).decisionContext.usage.energyPlayed.value, true);
  assert.equal(agent.observe({ ...v, revision: 2, turnNumber: 1 }).decisionContext.originAction, null);
  assert.throws(() => agent.observe({ ...v, revision: 4 }), /lost a visible revision/);
  assert.throws(() => bundle().observe({ ...v, revision: 4 }), /start at game creation/);
  assert.equal(bundle({ historyMode: 'observed-only' }).observe({ ...v, revision: 4 }).decisionContext.usage.retreated.known, false);
});

function raw(revision, terminal = false) {
  const side = { active: null, bench: [], discard: [], prizes: 6, deckCount: 53, handCount: 7 };
  const v = { source: 'live-matchlogic', revision, turnNumber: 0, status: terminal ? 'finished' : 'playing',
    turn: 'you', result: null, you: side, opponent: side, hand: [], actions: terminal ? [] : [{ id: 'native-pass', kind: 'pass' }], prompts: [],
    energyFacts: { schema: 'model6-energy/1', creatures: [], attachmentOptions: [] } };
  return { revision, views: { human: v, opponent: { ...v, turn: 'opponent' } }, terminal: terminal ? { winner: 'human' } : null };
}

test('native game observes both seats before proposing, commits after acceptance and preserves runner outcome', async () => {
  const observations = [], decisions = [];
  const result = await runNativeGame({}, { agents: { human: bundle(), opponent: bundle() },
    onObservation: x => observations.push([x.seat, x.view.revision]), onDecision: x => decisions.push(x),
    runEpisode: async (_native, hooks) => {
      await hooks.onFrame({ frame: raw(0) });
      const decision = await hooks.decideOrdinary({ seat: 'human', view: view() });
      assert.equal(decisions.length, 0);
      await hooks.onAcceptedDecision({ seat: 'human', decision });
      await hooks.onFrame({ frame: raw(1, true) });
      return { summary: { winnerSeat: 'human' }, journal: { commands: [decision] } };
    } });
  assert.deepEqual(observations, [['human', 0], ['opponent', 0], ['human', 1], ['opponent', 1]]);
  assert.equal(decisions[0].source, 'ordinary'); assert.equal(result.summary.winnerSeat, 'human');
  assert.deepEqual(result.routes.human, { ordinary: 1 });
});

test('frozen lock resolves exact historical bytes and catches source/private drift', () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const spec = readJson(path.join(repo, 'repro/model7-outcome-001/run-spec.json'));
  const lock = readJson(path.join(repo, 'environment/first-baseline-v1.lock.json'));
  assert.deepEqual(Object.fromEntries(recordedSources(repo, spec).map(r => [r.file, r.sha256])), lock.recordedSources);
  for (const name of foundationFiles) assert.equal(hashFile(path.join(repo, name)), lock.foundationSources[name], name);
  const temp = fs.mkdtempSync(path.join(tmpdir(), 'first-baseline-'));
  try {
    fs.mkdirSync(path.join(temp, 'environment'));
    const source = path.join(temp, 'source.mjs'), privateFile = path.join(temp, 'private-input');
    fs.writeFileSync(source, 'original'); fs.writeFileSync(privateFile, 'private');
    const smallLock = { version: 'test/1', recordedSources: { 'source.mjs': hashFile(source) }, foundationSources: {} };
    const lockPath = path.join(temp, 'environment/first-baseline-v1.lock.json'); fs.writeFileSync(lockPath, JSON.stringify(smallLock));
    const config = { schema: 'first-baseline-environment/1', environmentVersion: 'test/1', runtimeRoot: temp,
      lockSha256: hashFile(lockPath), filePins: { [privateFile]: hashFile(privateFile) } };
    verifyFrozenRuntime(config); fs.writeFileSync(privateFile, 'changed');
    assert.throws(() => verifyFrozenRuntime(config), /private prerequisite changed/);
    fs.writeFileSync(source, 'changed'); assert.throws(() => verifyFrozenRuntime(config), /runtime changed/);
  } finally { fs.rmSync(temp, { recursive: true }); }
});

test('native game retains lazy ranked candidates through validation fallback without inventing a sample', async () => {
  const ranker = bundle({ rankedPromptAnswers: function* (v) {
    for (const choice of v.prompts[0].choices) yield { promptId: v.prompts[0].id, choiceIds: [choice.id] };
  } });
  let acceptedEvent;
  const result = await runNativeGame({}, { agents: { human: ranker, opponent: bundle() },
    onDecision: e => { acceptedEvent = e; },
    runEpisode: async (_native, hooks) => {
      const frame = raw(0);
      frame.views.human.actions = [];
      frame.views.human.prompts = [{ id: 'native-prompt', kind: 'cards', min: 0, max: 1, ordered: false, cancelable: false,
        groups: [], choices: [{ id: 'native-a' }, { id: 'native-b' }] }];
      await hooks.onFrame({ frame });
      const choices = await hooks.decidePrompt({ seat: 'human', view: view(), validate: async () => true });
      assert.equal(typeof choices.next, 'function');
      const rejectedByNative = choices.next().value, accepted = choices.next().value;
      assert.notDeepEqual(rejectedByNative, accepted);
      await hooks.onAcceptedDecision({ seat: 'human', decision: accepted });
      return { summary: { completedNaturally: true } };
    } });
  assert.equal(acceptedEvent.source, 'selection');
  assert.equal(acceptedEvent.sample, undefined); assert.equal(acceptedEvent.encoded, undefined);
  assert.deepEqual(result.routes.human, { selection: 1 });
});
