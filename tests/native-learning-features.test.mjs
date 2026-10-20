import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';
import { encodeOrdinaryDecision, indexedOrdinaryDecision, ordinaryFeatureContract } from '../integrations/local-worker/learning-features.mjs';
import { learningTasks, evaluationTasks } from '../integrations/local-worker/learning-rollout.mjs';

function fixture(prefix = 'first') {
  const card = (id, category = 'pokemon') => ({ instanceId: prefix + id, printingId: 'SET-1', category });
  const creature = owner => ({ ...card(owner), owner, definitionId: 'set_1', hp: 120, damage: 10,
    providedEnergy: 2, currentRetreat: 1, printedRetreat: 1, conditions: [], publicCards: { energy: [], tools: [], evolutions: [] } });
  const side = owner => ({ active: creature(owner), bench: [], prizes: 6, deckCount: 40, handCount: 5, discard: [] });
  return { source: 'live-matchlogic', status: 'playing', revision: 4, turn: 'you', turnNumber: 3,
    result: null, hand: [card('hand', 'energy')], you: side('you'), opponent: side('opponent'), stadium: null,
    seed: 100, hiddenHand: ['secret'], actions: [{ id: prefix + 'play', kind: 'play', sourceCardId: prefix + 'hand', targetId: prefix + 'you' },
      { id: prefix + 'attack', kind: 'attack', actorId: prefix + 'you', targetId: prefix + 'opponent' }], prompts: [] };
}

test('actor-only numeric contract excludes identities, seeds and unknown private fields', () => {
  const first = new PolicyView().project(fixture()), raw = fixture('second');
  raw.seed = 99999; raw.hiddenHand = ['different secret']; raw.matchState = { hidden: true };
  const second = new PolicyView().project(raw);
  const encoded = encodeOrdinaryDecision(first, { actionId: first.actions[1].id });
  assert.deepEqual(encoded, encodeOrdinaryDecision(second, { actionId: second.actions[1].id }));
  assert.equal(encoded.state.length, ordinaryFeatureContract.stateDimensions);
  assert.equal(encoded.candidates[0].length, ordinaryFeatureContract.candidateDimensions);
  assert.equal(encoded.label, 1);
  assert.equal([...encoded.state, ...encoded.candidates.flat()].every(Number.isFinite), true);
  assert.deepEqual(Object.keys(encoded), ['state', 'candidates', 'label']);
});

test('candidate order follows legal offers, independently of the teacher label', () => {
  const view = new PolicyView().project(fixture());
  const first = encodeOrdinaryDecision(view, { actionId: view.actions[0].id });
  const second = encodeOrdinaryDecision(view, { actionId: view.actions[1].id });
  assert.deepEqual(first.candidates, second.candidates);
  assert.deepEqual(indexedOrdinaryDecision(view, 1), { actionId: view.actions[1].id });
  assert.throws(() => indexedOrdinaryDecision(view, 2), /legal candidate mask/);
  assert.throws(() => encodeOrdinaryDecision(view, { actionId: 'foreign' }), /outside legal/);
});

test('prompts and off-turn observations cannot become ordinary training records', () => {
  const view = new PolicyView().project(fixture());
  assert.throws(() => encodeOrdinaryDecision({ ...view, turn: 'opponent' }), /ordinary native/);
  assert.throws(() => encodeOrdinaryDecision({ ...view, prompts: [{}] }), /ordinary native/);
  assert.throws(() => encodeOrdinaryDecision({ ...view, actions: [{ id: 'x', kind: 'play', sourceCardId: 'unseen' }] }), /unsupported visible/);
});

test('fresh workload identities are reproducible and balance deck seats', () => {
  const tasks = learningTasks();
  assert.deepEqual(tasks.map(value => value.seed), [90001, 90002, 90003, 90004]);
  assert.deepEqual(tasks.map(value => value.seatOrder), [[0, 1], [1, 0], [0, 1], [1, 0]]);
  assert.throws(() => learningTasks([1, 1, 2, 3]));
});

test('evaluation flips actual policy seats while preserving the learner deck', () => {
  const tasks = evaluationTasks();
  assert.deepEqual(tasks.map(task => task.ordinaryPolicySeat), ['human', 'opponent']);
  assert.deepEqual(tasks.map(task => task.seed), [90005, 90006]);
  for (const task of [...tasks, ...evaluationTasks('evaluate-opponent')])
    assert.equal(task.seatOrder[task.ordinaryPolicySeat === 'human' ? 0 : 1], 0);
  assert.deepEqual(evaluationTasks('evaluate-opponent'), [{ id: 'seed-90007', seed: 90007, seatOrder: [1, 0], ordinaryPolicySeat: 'opponent' }]);
  assert.throws(() => evaluationTasks('unknown'));
});
