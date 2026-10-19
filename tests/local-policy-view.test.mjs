import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';

function fixture(prefix = 'raw') {
  const card = id => ({ instanceId: `${prefix}-${id}`, printingId: 'SET-1', category: 'pokemon', name: 'native label', secret: 'hidden' });
  const creature = (id, owner) => ({ ...card(id), owner, definitionId: 'set_1', hp: 120, damage: 10,
    providedEnergy: 1, providedEnergyTypes: ['fire'], currentRetreat: 1, printedRetreat: 1,
    conditions: [], publicCards: { energy: [], tools: [], evolutions: [] }, nativeState: { hidden: true } });
  const side = owner => ({ accountId: `${prefix}-account`, name: 'private', active: creature(owner, owner), bench: [],
    prizes: 6, deckCount: 40, handCount: 5, discard: [], clockSeconds: 999 });
  return { source: 'live-matchlogic', status: 'playing', revision: 4, turn: 'you', turnNumber: 3,
    result: null, hand: [card('hand')], you: side('you'), opponent: side('opponent'),
    seed: 100, snapshot: { private: true }, id: `${prefix}-match`, log: [{ message: 'private' }],
    cardDetails: [{ text: 'private native description' }], events: [{ private: true }],
    actions: [{ id: `${prefix}-play`, kind: 'play', sourceCardId: `${prefix}-hand`,
      targetId: `${prefix}-you`, label: 'private description', actionKey: 'set_1/123' }],
    prompts: [{ id: `${prefix}-prompt`, kind: 'cards', min: 1, max: 1, cancelable: false, ordered: false,
      title: 'private title', detail: 'private detail', groups: [{ id: `${prefix}-group`, label: 'private', min: 1, max: 1 }],
      choices: [{ id: `${prefix}-choice`, card: card('hand'), instanceId: `${prefix}-hand`,
        group: `${prefix}-group`, label: 'private', actionKey: 'hidden_card/123' }] }] };
}

test('equivalent visible information produces identical input despite raw UUIDs and private metadata', () => {
  const first = fixture('first'), second = fixture('second');
  second.seed = 9876; second.snapshot = { private: 'different world' };
  assert.deepEqual(new PolicyView().project(first), new PolicyView().project(second));
  const dto = new PolicyView().project(first);
  const serialized = JSON.stringify(dto);
  for (const forbidden of ['first-', 'private', 'hidden_card', 'native label', '"seed"', '"snapshot"', '"accountId"', '"log"', '"events"', '"cardDetails"'])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(dto.hand[0].instanceId, dto.actions[0].sourceCardId);
  assert.equal(dto.you.active.instanceId, dto.actions[0].targetId);
  assert.equal(dto.hand[0].instanceId, dto.prompts[0].choices[0].card.instanceId);
});

test('actor DTO is detached and recursively frozen without freezing the worker reply', () => {
  const raw = fixture(); const dto = new PolicyView().project(raw);
  assert.throws(() => dto.hand.push({}), TypeError);
  assert.throws(() => { dto.you.active.damage = 100; }, TypeError);
  assert.throws(() => { dto.prompts[0].groups[0].min = 0; }, TypeError);
  raw.hand[0].printingId = 'OTHER-9'; raw.you.active.providedEnergyTypes.push('water');
  assert.equal(dto.hand[0].printingId, 'SET-1');
  assert.deepEqual(dto.you.active.providedEnergyTypes, ['fire']);
});

test('resolution returns current native action, prompt and choice IDs without leaking them to the actor', () => {
  const projector = new PolicyView(); const dto = projector.project(fixture());
  assert.deepEqual(projector.resolve({ actionId: dto.actions[0].id }), { actionId: 'raw-play' });
  const prompt = dto.prompts[0], choice = prompt.choices[0];
  assert.deepEqual(projector.resolve({ promptId: prompt.id, choiceIds: [choice.id] }),
    { promptId: 'raw-prompt', choiceIds: ['raw-choice'] });
  assert.deepEqual(projector.resolve({ promptId: prompt.id, choiceIds: [], amounts: [{ choiceId: choice.id, count: 2 }] }),
    { promptId: 'raw-prompt', choiceIds: [], amounts: [{ choiceId: 'raw-choice', count: 2 }] });
});

test('old revision and foreign offers cannot resolve against current authority', () => {
  const projector = new PolicyView(); const old = projector.project(fixture());
  const raw = fixture(); raw.revision++;
  const current = projector.project(raw);
  assert.throws(() => projector.resolve({ actionId: old.actions[0].id }), /stale or foreign/);
  assert.throws(() => projector.resolve({ promptId: old.prompts[0].id, choiceIds: [] }), /stale or foreign/);
  assert.throws(() => projector.resolve({ actionId: 'raw-play' }), /stale or foreign/);
  assert.throws(() => projector.resolve({ promptId: current.prompts[0].id, choiceIds: ['r5/prompt/9/choice/0'] }), /stale or foreign/);
  assert.throws(() => projector.resolve({ actionId: current.actions[0].id, seed: 1 }), /unknown decision field/);
  assert.throws(() => projector.project(fixture()), /backwards/);
  assert.throws(() => projector.resolve({ actionId: current.actions[0].id }), /no current offers/);
});

test('visible physical identity remains stable across zone moves and newly revealed cards', () => {
  const projector = new PolicyView(); const raw = fixture();
  const first = projector.project(raw); const handAlias = first.hand[0].instanceId;
  raw.revision++; raw.you.discard = raw.hand; raw.hand = []; raw.actions = []; raw.prompts = [];
  assert.equal(projector.project(raw).you.discard[0].instanceId, handAlias);
  raw.revision++; raw.hand = [{ instanceId: 'new-visible-id', printingId: 'SET-2', category: 'trainer' }];
  assert.equal(projector.project(raw).hand[0].instanceId, 'card-4');
});

test('hidden identities in bare choices do not become physical aliases or semantic attack keys', () => {
  const raw = fixture();
  raw.prompts[0].choices = [{ id: 'hidden-choice', label: 'secret card', instanceId: 'unknown-hidden-card', actionKey: 'secret/123' }];
  const dto = new PolicyView().project(raw);
  assert.deepEqual(dto.prompts[0].choices, [{ id: 'r4/prompt/0/choice/0' }]);
});

test('an action cannot mint a physical alias from a hidden origin', () => {
  for (const field of ['sourceCardId', 'actorId', 'targetId']) {
    const raw = fixture(); raw.actions[0][field] = 'unknown-hidden-card';
    assert.throws(() => new PolicyView().project(raw), /action references unseen card/);
  }
  const raw = fixture(); raw.actions[0].actionKey = 'hidden_source/123';
  assert.equal(new PolicyView().project(raw).actions[0].actionKey, undefined);
});

test('allocation and ordering constraints survive while native labels are omitted', () => {
  const raw = fixture(); const prompt = raw.prompts[0];
  Object.assign(prompt, { kind: 'allocation', allocationMode: 'final', allocationUnit: 10, ordered: true, requiresPreview: true });
  Object.assign(prompt.choices[0], { minAmount: 0, maxAmount: 9, initialAmount: 3 });
  const projected = new PolicyView().project(raw).prompts[0];
  assert.equal(projected.allocationMode, 'final'); assert.equal(projected.allocationUnit, 10);
  assert.equal(projected.requiresPreview, true); assert.equal(projected.ordered, true);
  assert.equal(projected.choices[0].initialAmount, 3);
  assert.equal(projected.choices[0].group, projected.groups[0].id);
  assert.equal(projected.title, undefined);
});

test('native nullable optional action and prompt fields are omitted', () => {
  const raw = fixture();
  Object.assign(raw.actions[0], { targetId: null, attackName: null, actionKey: null });
  Object.assign(raw.prompts[0], { allocationMode: null, allocationUnit: null, revealedCards: null });
  const dto = new PolicyView().project(raw);
  assert.equal(dto.actions[0].targetId, undefined);
  assert.equal(dto.actions[0].attackName, undefined);
  assert.equal(dto.prompts[0].allocationMode, undefined);
});

test('malformed, ambiguous or duplicate authority fails closed', () => {
  const mutations = [
    raw => { raw.actions[0].kind = 'new-kind'; },
    raw => { raw.prompts[0].choices.push(raw.prompts[0].choices[0]); },
    raw => { raw.prompts[0].choices[0].group = 'foreign'; },
    raw => { raw.prompts[0].choices[0].instanceId = 'inconsistent'; },
    raw => { raw.prompts[0].min = 2; },
    raw => { raw.you.active.owner = 'opponent'; },
  ];
  for (const mutate of mutations) { const raw = fixture(); mutate(raw); assert.throws(() => new PolicyView().project(raw)); }
  const projector = new PolicyView(); const dto = projector.project(fixture()); const prompt = dto.prompts[0];
  assert.throws(() => projector.resolve({ promptId: prompt.id, choiceIds: [prompt.choices[0].id, prompt.choices[0].id] }), /duplicate/);
  assert.throws(() => projector.resolve({ actionId: dto.actions[0].id, promptId: prompt.id }), /stale or foreign/);
});

test('terminal output preserves no account-bearing result or executable offers', () => {
  const raw = fixture(); raw.status = 'finished'; raw.result = { winnerAccountId: 'private-account' };
  const projector = new PolicyView(); const dto = projector.project(raw);
  assert.equal(dto.result, null); assert.deepEqual(dto.actions, []); assert.deepEqual(dto.prompts, []);
  assert.throws(() => projector.resolve({ actionId: 'r4/action/0' }), /stale or foreign/);
});
