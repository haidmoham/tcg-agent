import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticState, staticProgramIds, seedAt, verifySeedTranscript } from '../integrations/local-worker/semantic-state.mjs';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const staticId = '33333333-3333-4333-8333-333333333333';
test('semantic replay retains identity relations while normalizing generated values and the documented cache', () => {
  const first = new SemanticState(new Set([staticId]));
  const second = new SemanticState(new Set([staticId]));
  assert.equal(first.hash({ entityID: a, parent: a, damage: 20, lastCheckedState: 12, action: staticId }), second.hash({ entityID: b, parent: b, damage: 20, lastCheckedState: 99, action: staticId }));
  assert.notEqual(new SemanticState().hash({ id: a, target: a }), new SemanticState().hash({ id: a, target: b }));
});
test('semantic comparison does not erase game values, order or immutable program identities', () => {
  assert.notEqual(new SemanticState().hash({ prizes: [1, 2] }), new SemanticState().hash({ prizes: [2, 1] }));
  const known = staticProgramIds({ action: staticId, another: a });
  assert.notEqual(new SemanticState(known).hash({ action: staticId }), new SemanticState(known).hash({ action: a }));
  assert.notEqual(new SemanticState().hash({ damage: 10 }), new SemanticState().hash({ damage: 20 }));
});
test('native seed transcript matches a versioned per-game sequence and rejects tampering', () => {
  const values = Array.from({ length: 20 }, (_, index) => seedAt(1729, index + 1));
  verifySeedTranscript(1729, values);
  assert.notDeepEqual(values, Array.from({ length: 20 }, (_, index) => seedAt(1730, index + 1)));
  values[7] ^= 1;
  assert.throws(() => verifySeedTranscript(1729, values), /diverged/);
});

test('known runtime identities embedded in native metadata retain their relations', () => {
  assert.equal(new SemanticState().hash({ metadata: `[];[${a}];`, card: { entityID: a } }), new SemanticState().hash({ metadata: `[];[${b}];`, card: { entityID: b } }));
  assert.notEqual(new SemanticState().hash({ unknown: `unregistered ${a}` }), new SemanticState().hash({ unknown: `unregistered ${b}` }));
  assert.notEqual(new SemanticState(new Set([a, b])).hash({ metadata: `[${a}]`, card: { entityID: a } }), new SemanticState(new Set([a, b])).hash({ metadata: `[${b}]`, card: { entityID: b } }));
});

test('serialized history snapshots use the same cache exclusion and preserve gameplay', () => {
  const snapshot = (id, cache, damage) => ({ history: JSON.stringify({ entityID: id, lastCheckedState: cache, attached: [{ parent: id, lastCheckedState: cache + 1 }], damage }) });
  assert.equal(new SemanticState().hash(snapshot(a, 10, 20)), new SemanticState().hash(snapshot(b, 90, 20)));
  assert.notEqual(new SemanticState().hash(snapshot(a, 10, 20)), new SemanticState().hash(snapshot(b, 90, 30)));
});
