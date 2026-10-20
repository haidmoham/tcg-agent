import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeModelClient } from '../integrations/local-worker/learning-model.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('malformed null model replies close the service and reject pending work', async () => {
  const client = Object.create(NativeModelClient.prototype);
  let killed = false;
  Object.assign(client, { buffer: '', closed: false, pending: new Map(), child: { exitCode: null, kill: () => { killed = true; } } });
  const pending = new Promise((accept, reject) => client.pending.set(1, { accept, reject, timer: null }));
  const rejected = assert.rejects(pending, /model service response invalid/);
  client.read('null\n');
  await rejected;
  assert.equal(client.closed, true);
  assert.equal(client.pending.size, 0);
  assert.equal(killed, true);
});

test('scale retains an early warmup failure and reaps its synthetic worker', { timeout: 15000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tcg-learning-failure-'));
  const name = `learning-failure-test-${randomUUID().slice(0, 8)}`;
  const directory = join(root, 'runs', name);
  try {
    const worker = join(fixture, 'synthetic-worker.mjs'), policy = join(fixture, 'synthetic-policy.mjs'), pidPath = join(fixture, 'worker-pid.txt');
    writeFileSync(worker, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.stdout.write('null\\n');\nsetInterval(() => {}, 1000);\n`);
    writeFileSync(policy, 'export function* livePracticeDecisions() {}\n');
    const data = {
      'MatchLogic.dll': 'synthetic-runtime', 'CardDatabase.DataAccess.dll': 'synthetic-access',
      'Newtonsoft.Json.dll': 'synthetic-json', 'TimeProvider.dll': 'synthetic-clock',
      'cardData.json': '{}', 'gameData.json': '{}', 'printing-joins.json': '{}',
      'decks.json': JSON.stringify({ realDeckRows: { orderedSourceIDs: Array(60).fill('synthetic-a') }, zoroarkDeckRows: { orderedSourceIDs: Array(60).fill('synthetic-b') } }),
    };
    for (const [path, bytes] of Object.entries(data)) writeFileSync(join(fixture, path), bytes);
    const manifest = JSON.stringify({ schemaVersion: 1, bundleId: 'synthetic-failure', files: Object.entries(data).map(([path, bytes]) => ({ path, sha256: digest(bytes) })) });
    writeFileSync(join(fixture, 'manifest.json'), manifest);
    const config = { schema: 'local-worker-probe-v1', offlineAuditVersion: 'indigo-offline-audit/1',
      executable: process.execPath, executableSha256: digest(readFileSync(process.execPath)), worker, workerSha256: digest(readFileSync(worker)),
      bundleRoot: fixture, manifestSha256: digest(manifest), policyModule: policy, policySha256: digest(readFileSync(policy)),
      buildConfiguration: 'Release', projectionCopyMode: 'projection-turn-v1', maxCommands: 400, maxSeconds: 180 };
    const configPath = join(fixture, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
    let failure;
    try { await execute(process.execPath, [join(root, 'scripts', 'native-learning.mjs'), 'scale', configPath, name], { cwd: root, windowsHide: true, timeout: 10000 }); }
    catch (error) { failure = error; }
    assert.equal(failure?.code, 1);
    assert.match(failure.stderr, /native learning lane failed before the warmup barrier/);
    assert.doesNotMatch(failure.stderr, /UnhandledPromiseRejection|triggerUncaughtException/);
    const receipt = JSON.parse(readFileSync(join(directory, 'failure.json'), 'utf8'));
    assert.match(receipt.message, /before the warmup barrier/);
    const pid = Number(readFileSync(pidPath, 'utf8'));
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  } finally {
    assert.equal(dirname(directory), join(root, 'runs'));
    assert.equal(dirname(fixture), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
