import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectionTasks, collectionSourceHashes, classifyCollectionFailure } from '../scripts/native-collect.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(readFileSync(join(root, 'learning/model-two-plan.json'), 'utf8'));
const execute = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('second-model plan fixes 24 disjoint games, splits and deck seats without warmups or replacements', () => {
  const tasks = collectionTasks(plan);
  assert.equal(tasks.length, 24);
  assert.equal(new Set(tasks.map(task => task.seed)).size, 24);
  assert.deepEqual(tasks.filter(task => task.split === 'train').map(task => task.seed), Array.from({ length: 18 }, (_, index) => 91001 + index));
  assert.deepEqual(tasks.filter(task => task.split === 'validation').map(task => task.seed), [91019, 91020, 91021, 91022, 91023, 91024]);
  tasks.forEach((task, index) => assert.deepEqual(task.seatOrder, index % 2 ? [1, 0] : [0, 1]));
  for (const patch of [{ maximumAttempts: 25 }, { workers: 5 }, { maximumWallSeconds: 1801 }, { warmups: 1 }, { replacements: 1 }])
    assert.throws(() => collectionTasks({ ...plan, collection: { ...plan.collection, ...patch } }));
});

test('only explicit wall budgets allow excluding a game and continuing', () => {
  assert.equal(classifyCollectionFailure({ code: 'NATIVE_EPISODE_TIME_BUDGET' }).status, 'capacity-timeout');
  assert.equal(classifyCollectionFailure({ message: 'worker closed or request already pending' }, 'global-wall-budget').reason, 'global-wall-budget');
  assert.equal(classifyCollectionFailure({ message: 'audited episode time budget exhausted' }).status, 'fatal');
  for (const error of [{ code: 'NATIVE_EPISODE_COMMAND_BUDGET' }, { message: 'native command rejected' }, { message: 'player observation changed under hidden permutation' }, { message: 'read or preview mutated authority or RNG' }, { message: 'local worker reply uncertain; no automatic mutation retry' }])
    assert.equal(classifyCollectionFailure(error, 'global-wall-budget').status, 'fatal');
  assert.equal(classifyCollectionFailure({ code: 'COLLECTION_PEER_FAILED' }, 'fatal-peer').status, 'cancelled');
});

test('source admission includes the controller, fixed plan and complete generation boundary', () => {
  const hashes = collectionSourceHashes();
  for (const path of ['scripts/native-collect.mjs', 'learning/model-two-plan.json', 'integrations/local-worker/audit-runner.mjs',
    'integrations/local-worker/learning-rollout.mjs', 'integrations/local-worker/learning-features.mjs', 'integrations/local-worker/policy-view.mjs'])
    assert.match(hashes[path], /^[a-f0-9]{64}$/);
  assert.deepEqual(collectionSourceHashes(), hashes);
});

test('a synthetic native protocol failure blocks training, retains outcomes and reaps all owned workers', { timeout: 15000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tcg-collect-failure-'));
  const name = `collect-failure-test-${randomUUID().slice(0, 8)}`, directory = join(root, 'runs', name);
  try {
    const worker = join(fixture, 'synthetic-worker.mjs'), policy = join(fixture, 'synthetic-policy.mjs');
    writeFileSync(worker, `import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nwriteFileSync(join(${JSON.stringify(fixture)}, process.pid + '.pid'), String(process.pid));\nprocess.stdout.write('null\\n');\nsetInterval(() => {}, 1000);\n`);
    writeFileSync(policy, 'export function* livePracticeDecisions() {}\n');
    const files = { 'MatchLogic.dll': 'synthetic-runtime', 'CardDatabase.DataAccess.dll': 'synthetic-access', 'Newtonsoft.Json.dll': 'synthetic-json',
      'TimeProvider.dll': 'synthetic-clock', 'cardData.json': '{}', 'gameData.json': '{}', 'printing-joins.json': '{}',
      'decks.json': JSON.stringify({ realDeckRows: { orderedSourceIDs: Array(60).fill('a') }, zoroarkDeckRows: { orderedSourceIDs: Array(60).fill('b') } }) };
    for (const [path, bytes] of Object.entries(files)) writeFileSync(join(fixture, path), bytes);
    const manifest = JSON.stringify({ schemaVersion: 1, bundleId: 'synthetic-failure', files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: digest(bytes) })) });
    writeFileSync(join(fixture, 'manifest.json'), manifest);
    const config = { schema: 'local-worker-probe-v1', offlineAuditVersion: 'indigo-offline-audit/1', executable: process.execPath,
      executableSha256: digest(readFileSync(process.execPath)), worker, workerSha256: digest(readFileSync(worker)), bundleRoot: fixture,
      manifestSha256: digest(manifest), policyModule: policy, policySha256: digest(readFileSync(policy)), buildConfiguration: 'Release', projectionCopyMode: 'projection-turn-v1' };
    const configPath = join(fixture, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
    let failure;
    try { await execute(process.execPath, [join(root, 'scripts/native-collect.mjs'), configPath, name], { cwd: root, windowsHide: true, timeout: 10000 }); }
    catch (error) { failure = error; }
    assert.equal(failure?.code, 2);
    assert.doesNotMatch(failure.stderr, /UnhandledPromiseRejection|triggerUncaughtException/);
    const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.complete, true); assert.equal(receipt.fatal, true);
    assert.equal(receipt.completed.length, 0); assert.equal(receipt.capacityFailures.length, 0);
    assert.ok(receipt.fatalFailures.length > 0);
    assert.equal(receipt.counts.attempted + receipt.counts.unattempted, 24);
    assert.deepEqual(receipt.sourceHashes, collectionSourceHashes());
    const pids = readdirSync(fixture).filter(path => path.endsWith('.pid'));
    assert.ok(pids.length > 0 && pids.length <= 4);
    for (const path of pids) assert.throws(() => process.kill(Number(readFileSync(join(fixture, path), 'utf8')), 0), error => error.code === 'ESRCH');
  } finally {
    assert.equal(dirname(directory), join(root, 'runs')); assert.equal(dirname(fixture), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true });
  }
});
