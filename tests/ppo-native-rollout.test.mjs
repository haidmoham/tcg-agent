import test from 'node:test';
import assert from 'node:assert/strict';
import { PpoModelClient, validatePpoActions } from '../integrations/local-worker/ppo-model.mjs';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';
import { admitPpoRolloutPlan, collectPpoEpisode, encodePpoBootstrapState, PpoEpisodeBuffer } from '../scripts/ppo-native-rollout.mjs';

const task = { id: 'ppo-case-1', seed: 94501, policySeat: 'human', seatOrder: [0, 1] };
const side = deckCount => ({ active: null, bench: [], prizes: 6, deckCount, handCount: 0, discard: [] });
function rawView(revision, { turn = 'you', terminal = false, prompt = false, deckCount = 40 } = {}) {
  return { source: 'live-matchlogic', status: terminal ? 'finished' : 'playing', revision, turn, turnNumber: revision + 1,
    hand: [], you: side(deckCount), opponent: side(40), stadium: null,
    actions: terminal || prompt || turn !== 'you' ? [] : [{ id: 'native-pass', kind: 'pass' }, { id: 'native-concede', kind: 'concede' }],
    prompts: prompt ? [{ id: 'search', kind: 'cards', min: 1, max: 1, cancelable: false, ordered: false, groups: [],
      choices: ['A', 'B'].map(printingId => ({ id: printingId, card: { instanceId: printingId, printingId, category: 'pokemon' } })) }] : [] };
}
function frame(revision, options = {}) {
  return { revision, views: { human: rawView(revision, options), opponent: rawView(revision, { ...options, turn: options.turn === 'opponent' ? 'you' : 'opponent' }) },
    terminal: options.terminal ? { winner: 'human' } : null };
}
const encoded = () => ({ schema: 'native-card-action-features/1', state: Array(224).fill(0), candidates: [Array(191).fill(0), Array(191).fill(1)] });
function actor(samples = [{ actionIndex: 1, oldLogProb: -0.321, oldValue: 0.25 }]) {
  return { calls: [], valueStates: [],
    async act(records, options) { this.calls.push({ records, options }); return [samples[Math.min(this.calls.length - 1, samples.length - 1)]]; },
    async values(states) { this.valueStates.push(...states); return states.map(() => 0.7); } };
}
const selection = { async rankChoices() { return [1, 0]; } };
const summary = { completedNaturally: true, rejected: 0, auditMode: 'sampled-native-training/1', winnerSeat: 'human',
  privacyChecks: 2, opponentHandExchanges: 1, sampledRevisions: [0, 2] };

test('PPO collection rejects mixing, deterministic sampling and reserved evaluation seeds', () => {
  const plan = { schema: 'native-ppo-rollout-plan/1', ppoConfig: 'ppo.json', selectionConfig: 'selection.json', workers: 4,
    maximumWallSeconds: 600, maximumGameSeconds: 240, maximumGameCommands: 500, tasks: [task] };
  assert.equal(admitPpoRolloutPlan(plan), plan);
  for (const patch of [{ teacherMix: 0 }, { epsilon: 0.1 }, { temperature: 2 }, { deterministic: true }, { workers: 5 },
    { tasks: [{ ...task, seed: 94301 }] }, { tasks: [{ ...task, seed: 94404 }] },
    { tasks: [{ ...task, seatOrder: [1, 0] }] }]) assert.throws(() => admitPpoRolloutPlan({ ...plan, ...patch }));
});

test('PPO samples preserve candidate index and exact old probability/value without teacher overrides', async () => {
  const ppo = actor(); let executed;
  const result = await collectPpoEpisode({}, task, { ppo, selection, runEpisode: async (_config, hooks) => {
    const initial = frame(0), view = new PolicyView().project(initial.views.human);
    hooks.onFrame({ entry: { revision: 0, nativeSeedCalls: 0 }, frame: initial });
    executed = await hooks.decideOrdinary({ seat: 'human', view });
    await hooks.onAcceptedDecision({ seat: 'human', view, decision: executed });
    const terminal = frame(1, { terminal: true }); hooks.onFrame({ entry: { revision: 1, nativeSeedCalls: 0 }, frame: terminal });
    return { summary, journal: { commands: [executed] } };
  } });
  assert.equal(executed.actionId, 'r0/action/1');
  assert.deepEqual(ppo.calls[0].options, { deterministic: false });
  assert.equal(result.records[0].actionIndex, 1);
  assert.equal(result.records[0].oldLogProb, -0.321);
  assert.equal(result.records[0].oldValue, 0.25);
  assert.equal(result.records[0].reward, 1);
  assert.equal(result.records[0].nextValue, 0);
  assert.equal(result.records[0].terminated, true);
  assert.equal(result.records[0].segmentEnd, true);
});

test('terminal reward after frozen selection still belongs to the preceding ordinary action', async () => {
  const ppo = actor();
  const result = await collectPpoEpisode({}, task, { ppo, selection, runEpisode: async (_config, hooks) => {
    const projector = new PolicyView(), initial = frame(0), view = projector.project(initial.views.human);
    hooks.onFrame({ entry: { revision: 0, nativeSeedCalls: 0 }, frame: initial });
    const decision = await hooks.decideOrdinary({ seat: 'human', view });
    hooks.onAcceptedDecision({ seat: 'human', view, decision });
    const searchFrame = frame(1, { prompt: true }), search = projector.project(searchFrame.views.human);
    hooks.onFrame({ entry: { revision: 1 }, frame: searchFrame });
    const answers = await hooks.decidePrompt({ seat: 'human', view: search });
    const selected = answers.next().value;
    assert.deepEqual(selected.choiceIds, ['r1/prompt/0/choice/1']);
    hooks.onAcceptedDecision({ seat: 'human', view: search, decision: selected, promptPolicyUsed: true });
    hooks.onFrame({ entry: { revision: 2, nativeSeedCalls: 0 }, frame: frame(2, { terminal: true }) });
    return { summary, journal: {} };
  } });
  assert.equal(result.status, 'terminated');
  assert.equal(result.records.length, 1);
  assert.equal(result.selectionDecisions, 1);
  assert.equal(result.records[0].reward, 1);
  assert.equal(result.audit.privacyChecks, 2);
});

test('true truncation bootstraps the final actor-visible state before reset', async () => {
  const ppo = actor();
  const result = await collectPpoEpisode({}, task, { ppo, selection, runEpisode: async (_config, hooks) => {
    const initial = frame(0), view = new PolicyView().project(initial.views.human);
    hooks.onFrame({ entry: { revision: 0, nativeSeedCalls: 0 }, frame: initial });
    const decision = await hooks.decideOrdinary({ seat: 'human', view });
    hooks.onAcceptedDecision({ seat: 'human', view, decision });
    hooks.onFrame({ entry: { revision: 1 }, frame: frame(1, { turn: 'opponent', deckCount: 39 }) });
    throw Object.assign(new Error('budget'), { code: 'NATIVE_EPISODE_COMMAND_BUDGET' });
  } });
  assert.equal(result.status, 'truncated');
  assert.equal(result.records[0].nextValue, 0.7);
  assert.equal(result.records[0].terminated, false);
  assert.equal(result.records[0].truncated, true);
  assert.equal(result.records[0].reward, 0);
  assert.equal(result.records[0].segmentEnd, true);
  assert.equal(ppo.valueStates[0][0], 0);
  assert.equal(ppo.valueStates[0][3], 39 / 60);
  assert.equal(result.audit.privacyChecks, null);
  assert.equal(result.audit.auditSummaryAvailable, false);
});

test('uncertain in-flight cutoff excludes the entire episode instead of inventing zero bootstrap', async () => {
  const ppo = actor();
  const result = await collectPpoEpisode({}, task, { ppo, selection, runEpisode: async (_config, hooks) => {
    const projector = new PolicyView(), initial = frame(0), view = projector.project(initial.views.human);
    hooks.onFrame({ entry: { revision: 0 }, frame: initial });
    const decision = await hooks.decideOrdinary({ seat: 'human', view }); hooks.onAcceptedDecision({ seat: 'human', view, decision });
    const next = frame(1); hooks.onFrame({ entry: { revision: 1 }, frame: next });
    await hooks.decideOrdinary({ seat: 'human', view: projector.project(next.views.human) });
    throw Object.assign(new Error('budget'), { code: 'NATIVE_EPISODE_TIME_BUDGET' });
  } });
  assert.equal(result.status, 'excluded'); assert.equal(result.records.length, 0);
  assert.match(result.exclusionReason, /uncertain/);
  assert.equal(ppo.valueStates.length, 0);
});

test('correctness failures discard episode records and never become losses or truncations', async () => {
  const result = await collectPpoEpisode({}, task, { ppo: actor(), selection, runEpisode: async () => { throw new Error('native command rejected'); } });
  assert.equal(result.status, 'fatal'); assert.equal(result.rejected, 1);
  assert.equal(result.result, null); assert.equal(result.records.length, 0);
  assert.throws(() => validatePpoActions([encoded()], [{ actionIndex: 2, oldLogProb: -1, oldValue: 0 }]));
  assert.throws(() => validatePpoActions([encoded()], [{ actionIndex: 0, oldLogProb: NaN, oldValue: 0 }]));
});

test('ordinary transition order and next values remain contiguous at an episode boundary', () => {
  const buffer = new PpoEpisodeBuffer('episode/human');
  buffer.accept(encoded(), { actionIndex: 1, oldLogProb: -0.5, oldValue: 0.2 });
  buffer.accept(encoded(), { actionIndex: 0, oldLogProb: -0.7, oldValue: -0.4 });
  const rows = buffer.finish({ terminated: true, nextValue: 0, result: 'loss' });
  assert.deepEqual(rows.map(row => row.stepIndex), [0, 1]);
  assert.equal(rows[0].nextValue, rows[1].oldValue);
  assert.equal(rows[0].segmentEnd, false);
  assert.equal(rows[1].reward, -1);
  assert.throws(() => buffer.accept(encoded(), { actionIndex: 0, oldLogProb: -1, oldValue: 0 }));
});

test('evaluation client requests deterministic inference and bootstrap encoder restores the real turn bit', async () => {
  const client = Object.create(PpoModelClient.prototype); client.printingAliases = {};
  client.act = async (records, options) => { assert.equal(options.deterministic, true); return [{ actionIndex: 1, oldLogProb: -1, oldValue: 0 }]; };
  const view = new PolicyView().project(rawView(0));
  assert.equal((await client.decide({ view })).actionId, view.actions[1].id);
  const opponentView = new PolicyView().project(rawView(1, { turn: 'opponent' }));
  assert.equal(encodePpoBootstrapState(opponentView)[0], 0);
  assert.throws(() => encodePpoBootstrapState({ ...opponentView, status: 'finished' }));
});

test('per-episode reseeding is correlated and independent of lane scheduling', async () => {
  const client = Object.create(PpoModelClient.prototype); client.pending = new Map();
  const calls = []; client.request = async (op, value) => { calls.push({ op, ...value }); return { samplingSeed: value.seed }; };
  const seed = (94501 ^ 1729) >>> 0;
  assert.equal(await client.setSeed(seed), seed);
  assert.deepEqual(calls, [{ op: 'seed', seed }]);
  assert.equal(client.seed, seed);
  await assert.rejects(client.setSeed(-1));
  client.pending.set(1, {});
  await assert.rejects(client.setSeed(seed));
});
