import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceForCopyMode } from '../integrations/local-worker/copy-comparison.mjs';

test('copy comparison changes only explicitly allowed execution pins, preserving every expected frame and command', () => {
  const baseline = { workerSha256: 'old', executableSha256: 'runtime', manifestSha256: 'data', policySha256: 'policy' };
  const reference = { header: { ...baseline, seed: 42, deckHashes: ['a', 'b'] }, frames: [{ stateHash: 'state', actorHashes: ['one', 'two'], emittedSeeds: [1, 2] }], commands: [{ seat: 'human', decision: { actionId: 'r0/action/0' } }] };
  const candidate = { ...baseline, workerSha256: 'new', projectionCopyMode: 'projection-snapshot-v1' };
  const expected = referenceForCopyMode(reference, baseline, candidate);
  assert.deepEqual(expected.frames, reference.frames); assert.deepEqual(expected.commands, reference.commands);
  assert.equal(expected.header.workerSha256, 'new'); assert.equal(reference.header.workerSha256, 'old');
  for (const key of ['executableSha256', 'manifestSha256', 'policySha256']) assert.throws(() => referenceForCopyMode(reference, baseline, { ...candidate, [key]: 'changed' }));
  assert.throws(() => referenceForCopyMode(reference, baseline, { ...candidate, projectionCopyMode: 'unknown' }));
  assert.throws(() => referenceForCopyMode({ ...reference, header: { ...reference.header, workerSha256: 'wrong' } }, baseline, candidate));
});
