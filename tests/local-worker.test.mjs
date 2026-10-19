import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalWorker, verifyLocalInputs } from '../integrations/local-worker/probe.mjs';

const workerSource = `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.method === 'stall') continue;
  if (request.method === 'null') { process.stdout.write('null\\n'); continue; }
  console.error('synthetic private diagnostic must not be protocol data');
  const reply = { ...request, payload: { value: request.payload.value } };
  if (request.method === 'wrong-id') reply.requestId = 'wrong';
  process.stdout.write(JSON.stringify(reply) + '\\n');
}`;

function fixture(t, timeoutMs = 2000) {
  const root = mkdtempSync(join(tmpdir(), 'tcg-local-worker-'));
  const path = join(root, 'synthetic-worker.mjs'); writeFileSync(path, workerSource);
  const worker = new LocalWorker({ executable: process.execPath, worker: path, bundleRoot: root, manifestSha256: createHash('sha256').update('synthetic').digest('hex') }, { timeoutMs });
  t.after(() => { worker.close(); rmSync(root, { recursive: true, force: true }); });
  return worker;
}

test('local transport returns correlated replies and drains private diagnostics', async t => {
  const worker = fixture(t);
  assert.deepEqual(await worker.request('echo', { value: 7 }), { value: 7 });
  assert.deepEqual(await worker.request('echo', { value: 8 }), { value: 8 });
});

test('uncorrelated worker reply closes the owned worker', async t => {
  const worker = fixture(t);
  await assert.rejects(worker.request('wrong-id', { value: 7 }), /uncorrelated/);
  await assert.rejects(worker.request('echo', {}), /closed/);
});

test('a JSON null reply rejects the request instead of crashing the callback', async t => {
  const worker = fixture(t);
  await assert.rejects(worker.request('null', {}), /uncorrelated/);
});

test('timeout is uncertain and never automatically retries a mutation', async t => {
  const worker = fixture(t, 50);
  await assert.rejects(worker.request('stall', {}), /reply uncertain/);
  await assert.rejects(worker.request('echo', {}), /closed/);
});

test('concurrent requests are rejected before another command is sent', async t => {
  const worker = fixture(t);
  const first = worker.request('echo', { value: 1 });
  await assert.rejects(worker.request('echo', { value: 2 }), /pending/);
  assert.deepEqual(await first, { value: 1 });
});

function pinnedFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tcg-local-pins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const worker = join(root, 'worker.mjs'); writeFileSync(worker, workerSource);
  const bundleRoot = join(root, 'bundle'); mkdirSync(bundleRoot);
  const names = ['MatchLogic.dll', 'CardDatabase.DataAccess.dll', 'Newtonsoft.Json.dll', 'TimeProvider.dll', 'cardData.json', 'gameData.json', 'decks.json', 'printing-joins.json'];
  for (const name of names) {
    const content = name === 'decks.json' ? JSON.stringify(Object.fromEntries(['realDeckRows', 'zoroarkDeckRows'].map(key => [key, { orderedSourceIDs: Array(60).fill('synthetic-card') }]))) : 'synthetic input';
    writeFileSync(join(bundleRoot, name), content);
    if (name.endsWith('.dll')) writeFileSync(join(root, name), content);
  }
  writeFileSync(join(bundleRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 1, bundleId: 'synthetic', files: names.map(path => ({ path, sha256: hash(join(bundleRoot, path)) })) }));
  return { schema: 'local-worker-probe-v1', executable: process.execPath, executableSha256: hash(process.execPath), worker, workerSha256: hash(worker), bundleRoot, manifestSha256: hash(join(bundleRoot, 'manifest.json')) };
}

test('local input audit accepts intact exact pins without running them', t => {
  assert.equal(verifyLocalInputs(pinnedFixture(t)).selected[0].length, 60);
});

test('local input audit rejects changed programs and worker dependencies', t => {
  const config = pinnedFixture(t);
  writeFileSync(join(config.bundleRoot, 'cardData.json'), 'changed');
  assert.throws(() => verifyLocalInputs(config), /input mismatch/);
  const other = pinnedFixture(t);
  writeFileSync(join(other.worker, '..', 'MatchLogic.dll'), 'changed');
  assert.throws(() => verifyLocalInputs(other), /dependency differs/);
});

test('local input audit rejects unpinned execution and unbounded work', t => {
  const config = pinnedFixture(t);
  assert.throws(() => verifyLocalInputs({ ...config, projectionCopyMode: 'unknown' }), /copy mode/);
  assert.throws(() => verifyLocalInputs({ ...config, workerSha256: '0'.repeat(64) }), /pin mismatch/);
  assert.throws(() => verifyLocalInputs({ ...config, maxCommands: 2001 }), /budget/);
});
