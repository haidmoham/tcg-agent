import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import { referenceForCopyMode } from '../integrations/local-worker/copy-comparison.mjs';

function pinnedInputs(t) {
  const root = mkdtempSync(join(tmpdir(), 'tcg-turn-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundleRoot = join(root, 'bundle'); mkdirSync(bundleRoot);
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const names = ['MatchLogic.dll', 'CardDatabase.DataAccess.dll', 'Newtonsoft.Json.dll', 'TimeProvider.dll', 'cardData.json', 'gameData.json', 'decks.json', 'printing-joins.json'];
  for (const name of names) {
    const bytes = name === 'decks.json'
      ? JSON.stringify(Object.fromEntries(['realDeckRows', 'zoroarkDeckRows'].map(key => [key, { orderedSourceIDs: Array(60).fill('synthetic') }])))
      : 'synthetic input with no executable programs';
    writeFileSync(join(bundleRoot, name), bytes);
    if (name.endsWith('.dll')) writeFileSync(join(root, name), bytes);
  }
  writeFileSync(join(bundleRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 1, bundleId: 'synthetic', files: names.map(path => ({ path, sha256: hash(join(bundleRoot, path)) })) }));
  const worker = join(root, 'worker'); writeFileSync(worker, 'synthetic worker never launched');
  return { schema: 'local-worker-probe-v1', executable: process.execPath, executableSha256: hash(process.execPath), worker, workerSha256: hash(worker), bundleRoot, manifestSha256: hash(join(bundleRoot, 'manifest.json')) };
}

test('turn preflight is explicit and still requires intact private execution pins', t => {
  const config = pinnedInputs(t);
  assert.equal(verifyLocalInputs(config).copyMode, 'native');
  assert.equal(verifyLocalInputs({ ...config, projectionCopyMode: 'projection-snapshot-v1' }).copyMode, 'projection-snapshot-v1');
  assert.equal(verifyLocalInputs({ ...config, projectionCopyMode: 'projection-turn-v1' }).copyMode, 'projection-turn-v1');
  assert.throws(() => verifyLocalInputs({ ...config, projectionCopyMode: 'projection-turn-v2' }), /copy mode/);
  writeFileSync(join(config.bundleRoot, 'gameData.json'), 'changed rules');
  assert.throws(() => verifyLocalInputs({ ...config, projectionCopyMode: 'projection-turn-v1' }), /input mismatch/);
});

test('turn candidate preserves every observation, state and seed expectation from the prior mode', () => {
  const baseline = { workerSha256: 'snapshot-worker', projectionCopyMode: 'projection-snapshot-v1', executableSha256: 'runtime', manifestSha256: 'programs', policySha256: 'policy' };
  const reference = { header: { ...baseline, seed: 3141, deckHashes: ['one', 'two'] }, frames: [{ revision: 0, stateHash: 'state', actorHashes: { human: 'human', opponent: 'opponent' }, emittedSeeds: [7] }], commands: [{ seat: 'opponent', decision: { actionId: 'r0/action/2' } }] };
  const candidate = { ...baseline, workerSha256: 'turn-worker', projectionCopyMode: 'projection-turn-v1' };
  const adapted = referenceForCopyMode(reference, baseline, candidate);
  assert.deepEqual(adapted, { ...reference, header: { ...reference.header, workerSha256: candidate.workerSha256, projectionCopyMode: candidate.projectionCopyMode } });
  assert.equal(reference.header.workerSha256, 'snapshot-worker');
  for (const key of ['executableSha256', 'manifestSha256', 'policySha256']) {
    assert.throws(() => referenceForCopyMode(reference, baseline, { ...candidate, [key]: 'changed' }), /changes/);
  }
  assert.throws(() => referenceForCopyMode(reference, { ...baseline, projectionCopyMode: 'native' }, candidate), /baseline pin/);
});
