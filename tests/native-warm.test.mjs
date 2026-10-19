import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LocalWorker } from '../integrations/local-worker/probe.mjs';
import { benchmarkNativeWarm, proveNativeWarm, validateWarmCases } from '../integrations/local-worker/warm-benchmark.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const selected = [Array(60).fill('synthetic-a'), Array(60).fill('synthetic-b')];
const config = { workerSha256: '1'.repeat(64), executableSha256: '2'.repeat(64), manifestSha256: '3'.repeat(64), policySha256: '4'.repeat(64), projectionCopyMode: 'projection-snapshot-v1' };
const journal = seed => ({ header: { ...config, schema: 'local-semantic-replay-v1', normalization: 'runtime-identity-minus-lastCheckedState/3', seed,
  deckHashes: selected.map(digest) }, commands: [{ seat: 'human', decision: { actionId: 'r0/action/0' } }], frames: [{ revision: 0 }, { revision: 1 }] });
const cases = () => [{ id: 'short', journal: journal(3141) }, { id: 'developed', journal: journal(1729) }];

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tcg-native-warm-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function syntheticWorker(t) {
  const directory = temporaryDirectory(t), path = join(directory, 'synthetic-worker.mjs'), log = join(directory, 'requests.jsonl');
  writeFileSync(path, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: request.method }) + '\\n');
  if (request.method === 'stall') continue;
  const reply = { ...request, payload: { epoch: request.epoch, matchId: request.matchId, method: request.method, pid: process.pid } };
  if (request.payload.wrongIdentity) reply.requestId = 'uncorrelated';
  process.stdout.write(JSON.stringify(reply) + '\\n');
}
`);
  const worker = new LocalWorker({ executable: process.execPath, worker: path, bundleRoot: directory, manifestSha256: 'synthetic' });
  t.after(() => worker.close());
  return { worker, log };
}

test('warm workloads preserve pinned deck order and distinguish representative traces', () => {
  const workloads = cases(); workloads[0].journal.header.deckHashes.reverse();
  const result = validateWarmCases(config, workloads, selected);
  assert.equal(result[0].decks[0], selected[1]);
  assert.equal(result[0].decks[1], selected[0]);
  assert.notEqual(result[0].workloadSha256, result[1].workloadSha256);
  assert.deepEqual(workloads[0].journal.header.deckHashes, [...selected.map(digest)].reverse());
});

test('warm workload admission rejects duplicate cases, incomplete traces and foreign decks', () => {
  assert.throws(() => validateWarmCases(config, cases().slice(0, 1), selected), /two or three/);
  assert.throws(() => validateWarmCases(config, [cases()[0], { ...cases()[1], id: 'short' }], selected), /identities/);
  assert.throws(() => validateWarmCases(config, [cases()[0], { id: 'duplicate', journal: journal(3141) }], selected), /distinct representative/);
  const incomplete = cases(); incomplete[0].journal.frames.pop();
  assert.throws(() => validateWarmCases(config, incomplete, selected), /complete verified/);
  const foreign = cases(); foreign[0].journal.header.deckHashes[0] = '5'.repeat(64);
  assert.throws(() => validateWarmCases(config, foreign, selected), /exact pinned decks/);
  const invalidId = cases(); invalidId[0].id = '../escape';
  assert.throws(() => validateWarmCases(config, invalidId, selected), /identities/);
});

test('warm workload admission rejects changed executable, program, policy, worker and copy pins', () => {
  for (const key of ['workerSha256', 'executableSha256', 'manifestSha256', 'policySha256']) {
    assert.throws(() => validateWarmCases({ ...config, [key]: '0'.repeat(64) }, cases(), selected), new RegExp(key));
  }
  assert.throws(() => validateWarmCases({ ...config, projectionCopyMode: 'native' }, cases(), selected), /copy mode/);
  const outdated = cases(); outdated[0].journal.header.normalization = 'runtime-identity-minus-lastCheckedState/2';
  assert.throws(() => validateWarmCases(config, outdated, selected), /complete verified/);
  const invalidSeed = cases(); invalidSeed[0].journal.header.seed = 0x100000000;
  assert.throws(() => validateWarmCases(config, invalidSeed, selected), /complete verified/);
});

test('warm entrypoints reject invalid configuration and budgets before execution', async () => {
  await assert.rejects(benchmarkNativeWarm({}, cases()), /configuration/);
  await assert.rejects(proveNativeWarm({}, cases()), /configuration/);
  const invalidMode = { schema: 'local-worker-probe-v1', projectionCopyMode: 'unknown' };
  await assert.rejects(benchmarkNativeWarm(invalidMode, cases()), /copy mode/);
  await assert.rejects(benchmarkNativeWarm(config, cases(), { repeats: 6 }), /repetitions/);
  await assert.rejects(benchmarkNativeWarm(config, cases(), { warmups: 0 }), /warm-up/);
  await assert.rejects(benchmarkNativeWarm(config, cases(), { maxSeconds: 181 }), /bounded/);
  await assert.rejects(proveNativeWarm(config, cases(), { totalSeconds: 901 }), /bounded/);
});

test('nextMatch replaces both identities while retaining the same worker process', async t => {
  const { worker } = syntheticWorker(t);
  const before = await worker.request('echo', {});
  const first = await worker.nextMatch({});
  const second = await worker.nextMatch({});
  assert.equal(first.method, 'offline-next');
  assert.equal(first.pid, before.pid); assert.equal(second.pid, before.pid);
  assert.notEqual(first.epoch, before.epoch); assert.notEqual(first.matchId, before.matchId);
  assert.notEqual(second.epoch, first.epoch); assert.notEqual(second.matchId, first.matchId);
});

test('nextMatch rejects a pending request without changing its identities', async t => {
  const { worker } = syntheticWorker(t);
  await worker.request('echo', {});
  const before = { epoch: worker.epoch, matchId: worker.matchId };
  const pending = worker.request('stall', {});
  const rejection = assert.rejects(pending, /test shutdown/);
  await assert.rejects(worker.nextMatch({}), /pending/);
  assert.deepEqual({ epoch: worker.epoch, matchId: worker.matchId }, before);
  worker.close(new Error('test shutdown'));
  await rejection;
});

test('an uncertain nextMatch reply closes the session and never retries the reset', async t => {
  const { worker, log } = syntheticWorker(t);
  await worker.request('echo', {});
  await assert.rejects(worker.nextMatch({ wrongIdentity: true }), /uncorrelated/);
  const before = { epoch: worker.epoch, matchId: worker.matchId };
  await assert.rejects(worker.nextMatch({}), /closed/);
  assert.deepEqual({ epoch: worker.epoch, matchId: worker.matchId }, before);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.method === 'offline-next').length, 1);
});

test('warm CLI rejects unknown modes without reading inputs or starting a worker', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/benchmark-native-warm.mjs'), 'unknown', 'missing-config', 'test', 'missing-cases'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.stdout, '');
});

test('warm CLI preserves an existing run directory and its original contents', t => {
  const directory = temporaryDirectory(t), configPath = join(directory, 'config.json'), journalPath = join(directory, 'journal.json'), manifestPath = join(directory, 'cases.json');
  writeFileSync(configPath, '{}'); writeFileSync(journalPath, JSON.stringify(journal(3141)));
  writeFileSync(manifestPath, JSON.stringify({ schema: 'native-warm-cases-v1', cases: [{ id: 'short', journalPath }, { id: 'developed', journalPath }] }));
  const name = `test-warm-existing-${randomUUID()}`, runs = join(root, 'runs'), existing = join(runs, name);
  mkdirSync(runs, { recursive: true }); mkdirSync(existing);
  t.after(() => rmSync(existing, { recursive: true, force: true }));
  const original = Buffer.from('original retained evidence\n');
  writeFileSync(join(existing, 'sentinel.json'), original);
  const result = spawnSync(process.execPath, [join(root, 'scripts/benchmark-native-warm.mjs'), 'benchmark', configPath, name, manifestPath], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(readdirSync(existing), ['sentinel.json']);
  assert.deepEqual(readFileSync(join(existing, 'sentinel.json')), original);
  assert.equal(result.stdout, '');
});
