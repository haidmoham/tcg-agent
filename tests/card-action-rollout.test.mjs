import test from 'node:test';
import assert from 'node:assert/strict';
import { admitCardActionPlan, cardActionFailure } from '../scripts/card-action-rollout.mjs';
import { supportsCardSelection, rankedPromptAnswers, weakOrdinaryDecision, cardActionDiagnostics } from '../integrations/local-worker/card-action-policy.mjs';
import { runAuditedEpisode } from '../integrations/local-worker/audit-runner.mjs';

const task = { id: 'case-1', seed: 1, split: 'evaluation', policySeat: 'human', seatOrder: [0, 1] };
const plan = { schema: 'native-card-action-rollout-plan/1', mode: 'qualification', workers: 4,
  maximumWallSeconds: 600, maximumGameSeconds: 360, maximumGameCommands: 500, tasks: [task] };
const creature = (instanceId, printingId) => ({ instanceId, printingId, hp: 100, damage: 0, providedEnergy: 0 });
const card = (instanceId, printingId) => ({ instanceId, printingId, category: 'pokemon' });
const view = () => ({ hand: [card('held', 'STAGE-1')], you: { active: creature('active', 'BASIC-1'), bench: [], discard: [] },
  opponent: { active: creature('other', 'OTHER-1'), bench: [], discard: [] }, prompts: [], actions: [], turnNumber: 3 });

test('rollout admission keeps learner on deck zero and whole games in one split', () => {
  assert.equal(admitCardActionPlan(plan), plan);
  assert.throws(() => admitCardActionPlan({ ...plan, tasks: [{ ...task, seatOrder: [1, 0] }] }));
  assert.throws(() => admitCardActionPlan({ ...plan, mode: 'evaluate', modelConfig: 'private.json', teacherMix: 0.1 }));
  assert.throws(() => admitCardActionPlan({ ...plan, workers: 5 }));
  const training = { ...plan, mode: 'bootstrap', tasks: [{ ...task, split: 'train' }, { ...task, id: 'case-2', split: 'validation' }] };
  assert.throws(() => admitCardActionPlan(training));
  training.tasks[1].seed = 2;
  assert.equal(admitCardActionPlan(training), training);
});

test('timeouts stay incomplete while independent correctness failures remain fatal near cancellation', () => {
  assert.equal(cardActionFailure({ code: 'NATIVE_EPISODE_TIME_BUDGET' }).status, 'capacity-timeout');
  assert.equal(cardActionFailure({ code: 'CARD_ACTION_CANCELLED' }, 'global-wall-budget').status, 'capacity-timeout');
  assert.equal(cardActionFailure({ message: 'card/action model closed' }, 'fatal-peer').status, 'cancelled');
  for (const cancellation of ['global-wall-budget', 'fatal-peer', 'operator-interrupted']) {
    for (const error of [{ message: 'native command rejected' }, { message: 'privacy mismatch' }, { code: 'NATIVE_EPISODE_COMMAND_BUDGET' }])
      assert.equal(cardActionFailure(error, cancellation).status, 'fatal');
  }
  assert.equal(Object.hasOwn(cardActionFailure({ code: 'NATIVE_EPISODE_TIME_BUDGET' }), 'modelWin'), false);
});

test('learned card ranking preserves full offered choices and structural cardinality constraints', () => {
  const state = view();
  state.prompts = [{ id: 'prompt', kind: 'cards', ordered: false, min: 1, max: 2, cancelable: false,
    groups: [{ id: 'one', min: 1, max: 1 }], choices: [
      { id: 'a', card: card('a', 'A'), group: 'one' }, { id: 'b', card: card('b', 'B'), group: 'one' },
      { id: 'c', card: card('c', 'C') }] }];
  assert.equal(supportsCardSelection(state), true);
  assert.deepEqual(rankedPromptAnswers(state, [1, 2, 0]).next().value, { promptId: 'prompt', choiceIds: ['b', 'c'] });
  assert.throws(() => [...rankedPromptAnswers(state, [1, 2])]);
  state.prompts[0] = { id: 'cost', kind: 'cards', ordered: false, min: 1, max: 2, groups: [], choices: [{ id: 'held', card: state.hand[0] }] };
  assert.deepEqual(rankedPromptAnswers(state, [0]).next().value.choiceIds, ['held']);
  state.prompts[0].ordered = true;
  assert.equal(supportsCardSelection(state), false);
  state.prompts[0] = { id: 'prize', kind: 'prizes', choices: [{ id: 'face-down' }] };
  assert.equal(supportsCardSelection(state), false);
});

test('line-building diagnostics count legal offers without turning them into rewards', () => {
  const state = view();
  state.actions = [{ id: 'evolve', kind: 'play', sourceCardId: 'held', targetId: 'active' },
    { id: 'recon', kind: 'ability', actionKey: 'recon-key' }, { id: 'dive', kind: 'attack', actionKey: 'dive-key' }];
  const diagnostics = cardActionDiagnostics([
    { kind: 'ordinary', behaviorSource: 'teacher', view: state, decision: { actionId: 'recon' } },
    { kind: 'ordinary', behaviorSource: 'model', view: state, decision: { actionId: 'dive' } },
  ], { evolutionPrintings: ['STAGE-1'], reconActionKey: 'recon-key', phantomDiveActionKey: 'dive-key' });
  assert.equal(diagnostics.evolutionOpportunities, 2);
  assert.equal(diagnostics.evolutionOpportunitiesPassedByAttackOrPass, 1);
  assert.equal(diagnostics.reconChosen, 1);
  assert.equal(diagnostics.firstPhantomDiveTurn, 3);
  assert.equal(Object.hasOwn(diagnostics, 'reward'), false);
  assert.deepEqual(weakOrdinaryDecision(state), { actionId: 'dive' });
});

test('group-invalid combinations consume the search budget before any answer is yielded', () => {
  const state = view();
  state.prompts = [{ id: 'large-group', kind: 'cards', ordered: false, min: 20, max: 20, cancelable: false,
    groups: [{ id: 'required', min: 2, max: 2 }], choices: Array.from({ length: 40 }, (_, index) => ({
      id: `choice-${index}`, card: card(`card-${index}`, `PRINTING-${index}`), ...(index >= 38 ? { group: 'required' } : {}) })) }];
  assert.throws(() => [...rankedPromptAnswers(state, Array.from({ length: 40 }, (_, index) => index))],
    error => error.code === 'DECISION_DOMAIN_BUDGET_EXCEEDED');
});

test('recorded native replay cannot invoke a learned prompt policy', async () => {
  await assert.rejects(runAuditedEpisode({}, { replay: {}, decidePrompt: () => [] }), /recorded replay cannot use a learned policy/);
});
