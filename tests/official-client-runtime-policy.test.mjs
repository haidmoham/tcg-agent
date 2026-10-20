import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRuntimeMatch, chooseSetupAction, chooseTextPrompt } from '../integrations/official-client/runtime-policy.mjs';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';
import { encodeOrdinaryDecision } from '../integrations/local-worker/learning-features.mjs';

const card = { instanceId: 'visible-1', source: 'fixture-dreepy', category: 'pokemon', name: 'Dreepy', hp: 70, damage: 20, energy: '{R}{P}', currentRetreat: 1, conditions: [] };
const sources = new Map([[card.source, { cardSourceID: card.source, cardName: 'Dreepy', retreatCost: 1 }]]);
const side = { active: [card], bench: [], discard: [], stadium: [], hand: [], handCount: 0, deckCount: 47, prizes: 6 };
function observation() { return structuredClone({ match: { state: 2, operationProcessing: false, menu: null, isMyTurn: true,
  turnNumber: 2, you: side, opponent: { ...side, active: [], hand: null, handCount: 5 }, actions: [{ id: 'pass-1', kind: 'pass', label: 'End turn' }] } }); }

test('rendered match maps to the unchanged 32/27 model contract and excludes arbitrary fields', () => {
  const input = observation(); input.match.opponent.hiddenHand = ['forbidden'];
  const raw = projectRuntimeMatch(input, sources, 1);
  const view = new PolicyView().project(raw);
  const features = encodeOrdinaryDecision(view);
  assert.equal(features.state.length, 32);
  assert.equal(features.candidates[0].length, 27);
  assert.equal(view.you.active.providedEnergy, 2);
  assert.equal(view.you.active.damage, 20);
  assert.ok(!JSON.stringify(view).includes('forbidden'));
});

test('unknown card sources, animation, menus and malformed public counters fail closed', () => {
  for (const change of [v => v.match.operationProcessing = true, v => v.match.menu = 'UnknownMenu',
    v => v.match.you.active[0].source = 'unknown', v => v.match.you.deckCount = -1,
    v => v.match.you.active[0].energy = 'unknown-format', v => delete v.match.you.active[0].conditions]) {
    const input = observation(); change(input);
    assert.throws(() => projectRuntimeMatch(input, sources, 1));
  }
});

test('setup choices are attributed game policy and select only admitted semantic actions', () => {
  const raw = projectRuntimeMatch(observation(), sources, 1); raw.status = 'setup'; raw.you.active = null;
  raw.actions = [{ id: 'bench', kind: 'play', label: 'Place Dreepy bench' }, { id: 'active', kind: 'play', label: 'Place Dreepy active' }];
  assert.equal(chooseSetupAction(raw).actionId, 'active');
  assert.equal(chooseSetupAction(raw).attribution.kind, 'helper');
  raw.actions = []; assert.throws(() => chooseSetupAction(raw), /no-admitted-action/);
});

test('text helper is attributed and rejects unfamiliar prompts instead of guessing', () => {
  const prompt = { kind: 'text', choices: [{ id: 'no', label: 'option2_no' }, { id: 'yes', label: 'option1_yes' }] };
  assert.equal(chooseTextPrompt(prompt).choiceId, 'yes');
  assert.equal(chooseTextPrompt(prompt).attribution.reason, 'prompt');
  prompt.choices[0].label = 'unmapped-choice';
  assert.throws(() => chooseTextPrompt(prompt), /unknown-text-helper-options/);
});
