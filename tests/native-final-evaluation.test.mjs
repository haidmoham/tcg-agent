import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { finalEvaluationTasks, finalFailure, nativeOutcome } from '../scripts/native-final-evaluation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(readFileSync(join(root, 'learning/model-two-plan.json'), 'utf8'));
const execute = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('final evaluation fixes both untouched seeds and roles with the learner on deck zero', () => {
  const tasks = finalEvaluationTasks(plan);
  assert.deepEqual(tasks.map(task => task.id), ['92001-human', '92001-opponent', '92002-human', '92002-opponent']);
  for (const task of tasks) assert.equal(task.seatOrder[task.ordinaryPolicySeat === 'human' ? 0 : 1], 0);
  const changed = structuredClone(plan); changed.finalEvaluation.casesPerModel[0].seed = 90005;
  assert.throws(() => finalEvaluationTasks(changed));
  assert.throws(() => finalEvaluationTasks({ ...plan, finalEvaluation: { ...plan.finalEvaluation, maximumGameSeconds: 181 } }));
});

test('capacity cases never manufacture losses or draws and correctness errors stay fatal', () => {
  const timeout = finalFailure({ code: 'NATIVE_EPISODE_TIME_BUDGET' });
  assert.equal(timeout.status, 'capacity-timeout');
  assert.equal(Object.hasOwn(timeout, 'modelWin'), false);
  assert.equal(Object.hasOwn(timeout, 'nativeWinnerSeat'), false);
  for (const error of [{ code: 'NATIVE_EPISODE_COMMAND_BUDGET' }, { message: 'native command rejected' }, { message: 'nonfinite model parameter' }, { message: 'privacy mismatch' }])
    assert.equal(finalFailure(error, 'global-wall-budget').status, 'fatal');
  assert.equal(finalFailure({ code: 'GLOBAL_EVALUATION_TIME_BUDGET' }, 'global-wall-budget').status, 'capacity-timeout');
  assert.equal(finalFailure({ code: 'ABORT_ERR' }, 'global-wall-budget').status, 'capacity-timeout');
  assert.equal(finalFailure({ code: 'ABORT_ERR' }).status, 'fatal');
});

test('model outcomes use the actual policy role and preserve absent native winners', () => {
  assert.equal(nativeOutcome('opponent', 'opponent').modelWin, true);
  assert.equal(nativeOutcome('human', 'opponent').modelWin, false);
  assert.deepEqual(nativeOutcome(null, 'human'), { nativeWinnerSeat: null, modelWin: null, outcome: 'native-terminal-without-winner' });
});

test('failed CPU checkpoint startup retains a fatal receipt without invented game outcomes', { timeout: 15000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tcg-final-eval-failure-')), token = randomUUID().slice(0, 8);
  const name = `final-eval-failure-test-${token}`, output = join(root, 'runs', name), modelDirectory = join(root, 'runs', `final-eval-model-fixture-${token}`);
  mkdirSync(modelDirectory, { recursive: true });
  try {
    const worker = join(fixture, 'unused-worker.mjs'), policy = join(fixture, 'policy.mjs'), checkpoint = join(modelDirectory, 'model.pt');
    writeFileSync(worker, 'throw new Error("native worker must not start after failed model preflight");\n');
    writeFileSync(policy, 'export function* livePracticeDecisions() {}\n'); writeFileSync(checkpoint, 'synthetic-unloaded-checkpoint');
    const checkpointBefore = digest(readFileSync(checkpoint));
    const files = { 'MatchLogic.dll': 'runtime', 'CardDatabase.DataAccess.dll': 'access', 'Newtonsoft.Json.dll': 'json', 'TimeProvider.dll': 'clock',
      'cardData.json': '{}', 'gameData.json': '{}', 'printing-joins.json': '{}',
      'decks.json': JSON.stringify({ realDeckRows: { orderedSourceIDs: Array(60).fill('a') }, zoroarkDeckRows: { orderedSourceIDs: Array(60).fill('b') } }) };
    for (const [path, bytes] of Object.entries(files)) writeFileSync(join(fixture, path), bytes);
    const manifest = JSON.stringify({ schemaVersion: 1, bundleId: 'synthetic-final-failure', files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: digest(bytes) })) });
    writeFileSync(join(fixture, 'manifest.json'), manifest);
    const config = { schema: 'local-worker-probe-v1', offlineAuditVersion: 'indigo-offline-audit/1', executable: process.execPath,
      executableSha256: digest(readFileSync(process.execPath)), worker, workerSha256: digest(readFileSync(worker)), bundleRoot: fixture,
      manifestSha256: digest(manifest), policyModule: policy, policySha256: digest(readFileSync(policy)), buildConfiguration: 'Release', projectionCopyMode: 'projection-turn-v1' };
    const configPath = join(fixture, 'config.json'), modelConfig = join(fixture, 'model-config.json');
    writeFileSync(configPath, JSON.stringify(config)); writeFileSync(modelConfig, JSON.stringify({ executable: process.execPath, checkpoint, device: 'cpu', seed: 1729 }));
    let failure;
    try { await execute(process.execPath, [join(root, 'scripts/native-final-evaluation.mjs'), configPath, name, modelConfig], { cwd: root, windowsHide: true, timeout: 10000 }); }
    catch (error) { failure = error; }
    assert.equal(failure?.code, 2);
    const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
    assert.equal(receipt.fatal, true); assert.equal(receipt.completed.length, 0);
    assert.equal(receipt.capacityFailures.length, 0); assert.equal(receipt.unattempted.length, 4);
    assert.equal(receipt.counts.wins, 0); assert.equal(receipt.counts.losses, 0);
    assert.equal(receipt.model.checkpointUnchanged, true);
    assert.equal(digest(readFileSync(checkpoint)), checkpointBefore);
    assert.equal(digest(readFileSync(join(output, 'source-snapshot/scripts/native-final-evaluation.mjs'))), receipt.sourceHashes['scripts/native-final-evaluation.mjs']);
  } finally {
    assert.equal(dirname(output), join(root, 'runs')); assert.equal(dirname(modelDirectory), join(root, 'runs')); assert.equal(dirname(fixture), resolve(tmpdir()));
    rmSync(output, { recursive: true, force: true }); rmSync(modelDirectory, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true });
  }
});
