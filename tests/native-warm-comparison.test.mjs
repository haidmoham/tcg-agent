import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareNativeWarm, referencesForWarmComparison, summarizeWarmSessions } from '../integrations/local-worker/warm-comparison.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = { buildConfiguration: 'Release', workerSha256: 'old', executableSha256: 'runtime', manifestSha256: 'data', policySha256: 'policy', projectionCopyMode: 'native' };
const candidate = { ...baseline, workerSha256: 'new', projectionCopyMode: 'projection-snapshot-v1' };
const cases = () => ['short', 'developed'].map((id, index) => ({ id, journal: { header: { ...baseline, seed: index, deckHashes: ['a', 'b'] },
  frames: [{ snapshotHash: id, actorHashes: { human: 'one', opponent: 'two' }, emittedSeeds: [index] }],
  commands: [{ seat: 'human', decision: { actionId: 'r0/action/0' } }] } }));

test('warm comparison retargets worker and copy pins while preserving both complete references', () => {
  const original = cases(), preserved = structuredClone(original);
  const expected = referencesForWarmComparison(baseline, candidate, original);
  assert.deepEqual(original, preserved);
  assert.deepEqual(expected, original.map(row => ({ ...row, journal: { ...row.journal,
    header: { ...row.journal.header, workerSha256: 'new', projectionCopyMode: 'projection-snapshot-v1' } } })));
  for (const key of ['executableSha256', 'manifestSha256', 'policySha256']) {
    assert.throws(() => referencesForWarmComparison(baseline, { ...candidate, [key]: 'changed' }, original), new RegExp(key));
  }
  const wrong = cases(); wrong[0].journal.header.workerSha256 = 'foreign';
  assert.throws(() => referencesForWarmComparison(baseline, candidate, wrong), /baseline pin/);
  assert.throws(() => referencesForWarmComparison(baseline, { ...candidate, projectionCopyMode: 'unknown' }, original), /copy mode/);
});

test('warm comparison requires explicit Release on both sides and exactly two fixed cases', () => {
  for (const buildConfiguration of [undefined, 'Debug', 'release']) {
    assert.throws(() => referencesForWarmComparison({ ...baseline, buildConfiguration }, candidate, cases()), /explicit Release/);
    assert.throws(() => referencesForWarmComparison(baseline, { ...candidate, buildConfiguration }, cases()), /explicit Release/);
  }
  assert.throws(() => referencesForWarmComparison(baseline, candidate, cases().slice(0, 1)), /exactly two/);
  assert.throws(() => referencesForWarmComparison(baseline, candidate, [...cases(), cases()[0]]), /exactly two/);
});

test('warm comparator rejects unbounded repetitions and invalid configurations without native execution', async () => {
  for (const pairs of [0, 2, 6, 3.5]) await assert.rejects(compareNativeWarm(baseline, candidate, cases(), { pairs }), /three through five/);
  await assert.rejects(compareNativeWarm({}, candidate, cases()), /explicit Release/);
  await assert.rejects(compareNativeWarm(baseline, candidate, cases()), /configuration/);
});

const workloads = [{ id: 'short', commands: 52, workloadSha256: 'a' }, { id: 'developed', commands: 123, workloadSha256: 'b' }];
const sessions = () => [1, 2, 3].flatMap(pair => (pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']).map(side => ({
  pair, side, complete: true, errors: 0, truncations: 0, repeats: 1, warmups: 1, games: 2,
  workloads: structuredClone(workloads), runs: [{ id: 'short' }, { id: 'developed' }], warmupRuns: [{ id: 'short' }],
  timedMilliseconds: pair * (side === 'baseline' ? 100 : 50), sessionMilliseconds: 500 + pair * 100,
})));

test('warm comparison summarizes the paired two-game endpoint using side medians', () => {
  const runs = sessions(), preserved = structuredClone(runs), summary = summarizeWarmSessions(runs, 3);
  assert.deepEqual(runs, preserved);
  assert.equal(summary.baseline.medianTimedMilliseconds, 200);
  assert.equal(summary.candidate.medianTimedMilliseconds, 100);
  assert.equal(summary.baseline.aggregateGamesPerSecond, 10);
  assert.equal(summary.candidate.aggregateGamesPerSecond, 20);
  assert.equal(summary.baseline.aggregateCommandsPerSecond, 875);
  assert.equal(summary.speedup, 2);
  assert.equal(summary.baseline.measuredGames, 6); assert.equal(summary.baseline.warmupGames, 3);
  assert.equal(summary.baseline.minTimedMilliseconds, 100); assert.equal(summary.baseline.maxTimedMilliseconds, 300);
});

test('warm summary refuses missing, duplicate, truncated and unequal-work sessions', () => {
  assert.throws(() => summarizeWarmSessions(sessions().slice(1), 3), /complete paired/);
  for (const patch of [{ pair: 2 }, { complete: false }, { errors: 1 }, { truncations: 1 }, { games: 1 }, { warmups: 0 },
    { repeats: 2 }, { timedMilliseconds: 0 }, { timedMilliseconds: NaN }, { warmupRuns: [] }, { runs: [] }, { workloads: [...workloads].reverse() }]) {
    const runs = sessions(); Object.assign(runs[0], patch);
    assert.throws(() => summarizeWarmSessions(runs, 3), /incomplete or unequal/);
  }
});

test('warm comparison CLI rejects malformed arguments before reading inputs or creating output', () => {
  for (const suffix of [['test', '2'], ['test', '3.5'], ['test', '6'], ['../escape', '3'], ['test', '3', 'extra']]) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/compare-native-warm.mjs'), 'missing-base', 'missing-candidate', 'missing-cases', ...suffix],
      { windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/); assert.equal(result.stdout, '');
  }
});

test('warm comparison CLI preserves existing run evidence without adding a failure file', t => {
  const runs = join(root, 'runs'), name = `test-warm-comparison-${randomUUID()}`, directory = resolve(runs, name);
  assert.equal(dirname(directory), runs);
  mkdirSync(runs, { recursive: true }); mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = Buffer.from('retained original evidence\n'); writeFileSync(join(directory, 'sentinel.json'), original);
  const result = spawnSync(process.execPath, [join(root, 'scripts/compare-native-warm.mjs'), 'missing-base', 'missing-candidate', 'missing-cases', name, '3'],
    { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.deepEqual(readdirSync(directory), ['sentinel.json']); assert.deepEqual(readFileSync(join(directory, 'sentinel.json')), original);
});
