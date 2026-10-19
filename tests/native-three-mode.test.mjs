import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareNativeModes, referencesForThreeModeComparison, summarizeThreeModeSessions } from '../integrations/local-worker/three-mode-comparison.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = { buildConfiguration: 'Release', workerSha256: 'worker', executableSha256: 'runtime', manifestSha256: 'data', policySha256: 'policy', projectionCopyMode: 'native' };
const previous = { ...native, projectionCopyMode: 'projection-snapshot-v1' };
const candidate = { ...native, projectionCopyMode: 'projection-turn-v1' };
const cases = () => ['short', 'developed'].map((id, seed) => ({ id, journal: { header: { ...native, seed, deckHashes: ['a', 'b'] },
  frames: [{ snapshotHash: id, actorHashes: { human: 'one', opponent: 'two' }, emittedSeeds: [seed] }],
  commands: [{ seat: 'human', decision: { actionId: 'r0/action/0' } }] } }));

test('three-mode references preserve every frame and command while retargeting explicit modes', () => {
  const original = cases(), preserved = structuredClone(original);
  const result = referencesForThreeModeComparison(native, previous, candidate, original);
  assert.deepEqual(original, preserved);
  for (const [side, config] of Object.entries({ native, previous, candidate })) {
    assert.deepEqual(result[side], original.map(row => ({ ...row, journal: { ...row.journal,
      header: { ...row.journal.header, projectionCopyMode: config.projectionCopyMode } } })));
    assert.notEqual(result[side][0].journal, original[0].journal);
  }
  const foreign = cases(); foreign[1].journal.header.workerSha256 = 'foreign';
  assert.throws(() => referencesForThreeModeComparison(native, previous, candidate, foreign), /baseline pin/);
});

test('three-mode admission requires identical Release pins and three distinct explicit modes', async () => {
  for (const key of ['workerSha256', 'executableSha256', 'manifestSha256', 'policySha256']) {
    assert.throws(() => referencesForThreeModeComparison(native, { ...previous, [key]: 'different' }, candidate, cases()), new RegExp(key));
    assert.throws(() => referencesForThreeModeComparison(native, previous, { ...candidate, [key]: 'different' }, cases()), new RegExp(key));
  }
  for (const buildConfiguration of [undefined, 'Debug', 'release']) {
    assert.throws(() => referencesForThreeModeComparison({ ...native, buildConfiguration }, previous, candidate, cases()), /explicit Release/);
    assert.throws(() => referencesForThreeModeComparison(native, { ...previous, buildConfiguration }, candidate, cases()), /explicit Release/);
    assert.throws(() => referencesForThreeModeComparison(native, previous, { ...candidate, buildConfiguration }, cases()), /explicit Release/);
  }
  for (const projectionCopyMode of [undefined, 'native', previous.projectionCopyMode]) {
    assert.throws(() => referencesForThreeModeComparison(native, previous, { ...candidate, projectionCopyMode }, cases()), /distinct explicit/);
  }
  assert.throws(() => referencesForThreeModeComparison(previous, native, candidate, cases()), /starting with native/);
  assert.throws(() => referencesForThreeModeComparison(native, previous, { ...candidate, projectionCopyMode: 'unknown' }, cases()), /copy mode/);
  assert.throws(() => referencesForThreeModeComparison(native, previous, candidate, cases().slice(1)), /exactly two/);
  await assert.rejects(compareNativeModes({}, previous, candidate, cases()), /explicit Release/);
});

const workloads = [{ id: 'short', commands: 52, workloadSha256: 'a' }, { id: 'developed', commands: 123, workloadSha256: 'b' }];
const sessions = () => [1, 2, 3, 4, 5].flatMap(pair => ['native', 'previous', 'candidate'].map(side => ({
  pair, side, complete: true, errors: 0, truncations: 0, repeats: 1, warmups: 1, games: 2,
  workloads: structuredClone(workloads), runs: [{ id: 'short' }, { id: 'developed' }], warmupRuns: [{ id: 'short' }],
  timedMilliseconds: pair * ({ native: 100, previous: 50, candidate: 25 })[side], sessionMilliseconds: 600,
})));

test('both contrasts summarize the same five complete candidate sessions with the frozen endpoint', () => {
  const runs = sessions(), preserved = structuredClone(runs), result = summarizeThreeModeSessions(runs);
  assert.deepEqual(runs, preserved);
  assert.equal(result.incremental.speedup, 2); assert.equal(result.fullCampaign.speedup, 4);
  assert.equal(result.incremental.baseline.medianTimedMilliseconds, 150);
  assert.equal(result.fullCampaign.baseline.medianTimedMilliseconds, 300);
  assert.equal(result.incremental.candidate.medianTimedMilliseconds, 75);
  assert.deepEqual(result.incremental.candidate, result.fullCampaign.candidate);
  assert.equal(result.incremental.candidate.measuredGames, 10);
  assert.equal(result.incremental.candidate.warmupGames, 5);
  assert.equal(result.incremental.candidate.aggregateGamesPerSecond, 2000 / 75);
});

test('three-mode summaries reject missing, duplicate, failed and unequal-work sessions', () => {
  assert.throws(() => summarizeThreeModeSessions(sessions().slice(1)), /fifteen complete/);
  for (const patch of [{ pair: 2 }, { side: 'unknown' }, { workloads: [...workloads].reverse() }, { complete: false },
    { errors: 1 }, { truncations: 1 }, { warmups: 0 }, { repeats: 2 }, { games: 1 }, { runs: [] }, { warmupRuns: [] }, { timedMilliseconds: 0 }]) {
    const runs = sessions(); Object.assign(runs[0], patch);
    assert.throws(() => summarizeThreeModeSessions(runs), /complete identical|incomplete or unequal/);
  }
});

test('three-mode CLI rejects malformed arguments before creating output', () => {
  for (const tail of [[], ['../escape'], ['test', 'extra']]) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/compare-native-modes.mjs'), 'missing-native', 'missing-previous', 'missing-candidate', 'missing-cases', ...tail],
      { windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/); assert.equal(result.stdout, '');
  }
});

test('three-mode CLI preserves existing evidence without adding a failure file', t => {
  const runs = join(root, 'runs'), name = `test-three-mode-${randomUUID()}`, directory = resolve(runs, name);
  assert.equal(dirname(directory), runs);
  mkdirSync(runs, { recursive: true }); mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = Buffer.from('retained original evidence\n'); writeFileSync(join(directory, 'sentinel.json'), original);
  const result = spawnSync(process.execPath, [join(root, 'scripts/compare-native-modes.mjs'), 'missing-native', 'missing-previous', 'missing-candidate', 'missing-cases', name],
    { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.deepEqual(readdirSync(directory), ['sentinel.json']); assert.deepEqual(readFileSync(join(directory, 'sentinel.json')), original);
});
