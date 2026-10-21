import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hashFile, readJson } from '../environment/frozen-runtime.mjs';

const [inputsPath, mode] = process.argv.slice(2);
assert(inputsPath && [undefined, '--preflight'].includes(mode),
  'usage: run-model7-overnight-evaluation <private-inputs.json> [--preflight]');
const inputs = readJson(inputsPath), design = readJson(inputs.design), config = readJson(inputs.environmentConfig);
assert.equal(design.schema, 'model7-overnight-design/1');
assert.equal(design.confirmation.seeds.length, 512);
assert.equal(design.monitoring.seeds.length, 64);
assert.equal(config.lockSha256, design.confirmation.environmentLockSha256);
const { verifyFrozenRuntime } = await import(pathToFileURL(path.join(config.runtimeRoot, 'environment/frozen-runtime.mjs')));
verifyFrozenRuntime(config);
const sourceFiles = ['scripts/run-model7-overnight-evaluation.mjs', 'scripts/run-native-ladder.mjs',
  'scripts/export-strength-confirmation.mjs', 'scripts/report-native-ladder.mjs', 'src/native-ladder.mjs'];
const sourcePins = Object.fromEntries(sourceFiles.map(file => [path.resolve(file), hashFile(file)]));
const inputPins = { [path.resolve(inputsPath)]: hashFile(inputsPath), [path.resolve(inputs.design)]: hashFile(inputs.design),
  [path.resolve(inputs.environmentConfig)]: hashFile(inputs.environmentConfig) };
if (mode === '--preflight') {
  console.log(JSON.stringify({ preflight: true, sourcePins, inputPins, games: 0, fits: 0 }));
  process.exit(0);
}
const root = path.resolve(inputs.outputDirectory);
assert(!fs.existsSync(root), 'fresh evaluation campaign required');
fs.mkdirSync(root, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
const startedAtUtc = new Date().toISOString();
const panels = [];
let phase = 'waiting-for-monitor', child = null, interrupted = false;
function assertInputs() {
  for (const [file, sha256] of Object.entries({ ...sourcePins, ...inputPins })) assert.equal(hashFile(file), sha256, 'evaluation source/input changed');
  verifyFrozenRuntime(config);
}
function status() {
  let current = null;
  if (child && fs.existsSync(path.join(child.directory, 'receipt.json'))) {
    try {
      const receipt = readJson(path.join(child.directory, 'receipt.json'));
      current = { state: receipt.state, completedPairs: receipt.blocks.filter(block => block.outcomes.length === 2).length,
        recordedGames: receipt.blocks.reduce((total, block) => total + block.outcomes.length, 0), plannedPairs: receipt.plannedPairs };
    } catch {}
  }
  save('status.json', { schema: 'model7-overnight-evaluation-status/1', phase, startedAtUtc, at: new Date().toISOString(),
    supervisorPid: process.pid, runnerPid: child?.process.pid ?? null, current, panels, promotion: false });
}
const heartbeat = setInterval(status, 30000);
process.on('SIGINT', () => { interrupted = true; child?.process.kill(); });
process.on('SIGTERM', () => { interrupted = true; child?.process.kill(); });
async function waitUntil(time) {
  while (Date.now() < time) {
    assert(!interrupted, 'operator interrupted');
    await new Promise(resolve => setTimeout(resolve, Math.min(30000, time - Date.now())));
    assertInputs();
  }
}
function announcements() {
  const file = path.join(inputs.trainingDirectory, 'checkpoint-announcements.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.flatMap((line, index) => {
    try { return [JSON.parse(line)]; }
    catch (error) { if (index === lines.length - 1) return []; throw error; }
  });
}
function selectCheckpoint(time) {
  const eligible = announcements().filter(row => Date.parse(row.completedAtUtc) <= time);
  const selected = eligible.sort((a, b) => Date.parse(b.completedAtUtc) - Date.parse(a.completedAtUtc))[0];
  if (!selected) return null;
  assert.equal(selected.reloadVerified, true);
  assert.equal(hashFile(selected.checkpoint), selected.checkpointSha256);
  const receiptPath = selected.checkpoint.replace(/\.pt$/, '.receipt.json');
  assert.equal(hashFile(receiptPath), selected.receiptSha256);
  const receipt = readJson(receiptPath);
  assert.equal(receipt.reloadLogitsExact, true);
  assert.equal(receipt.reloadValuesExact, true);
  assert.equal(receipt.checkpointSha256, selected.checkpointSha256);
  return selected;
}
async function command(script, args, directory, logName) {
  assertInputs();
  const log = fs.openSync(path.join(root, logName), 'a');
  try {
    return await new Promise((resolve, reject) => {
      const workerProcess = spawn(process.execPath, [script, ...args], { cwd: process.cwd(), windowsHide: true,
        stdio: ['ignore', log, log] });
      child = { process: workerProcess, directory }; status();
      workerProcess.once('error', reject);
      workerProcess.once('exit', (code, signal) => { child = null; resolve({ code, signal }); });
    });
  } finally { fs.closeSync(log); }
}
async function runPanel(label, checkpoint, seeds, split, workers, maximumWallSeconds, analysisAlpha) {
  assertInputs();
  const directory = path.join(root, label), manifestPath = path.join(root, `${label}-manifest.json`);
  const candidateId = `model7.${label}`;
  const nomination = { rule: split === 'confirmation' ? design.training.checkpointRule : design.monitoring.snapshotRule,
    checkpointSha256: checkpoint.checkpointSha256, completedAtUtc: checkpoint.completedAtUtc,
    completedTrainingGames: checkpoint.completedTrainingGames, completedBatchUpdates: checkpoint.completedBatchUpdates,
    optimizerSteps: checkpoint.optimizerSteps, trainingUpdateReceiptSha256: checkpoint.receiptSha256 };
  if (split === 'confirmation') nomination.publicProtocolSha256 = hashFile(path.join(root, 'confirmation-protocol.json'));
  const manifest = { schema: 'native-ladder-run/1', environmentConfig: inputs.environmentConfig, anchor: 'first-baseline',
    split, promotion: false, entrants: [
      { kind: 'baseline', id: 'first-baseline', description: 'Exact frozen environment-v1 reference' },
      { kind: 'ppo', id: candidateId, description: `Single Model7 trajectory ${label}`, checkpoint: checkpoint.checkpoint,
        sha256: checkpoint.checkpointSha256 }], pairs: [[candidateId, 'first-baseline']], seeds, workers,
    maximumGames: seeds.length * 2, maximumWallSeconds, maximumGameSeconds: 240, maximumGameCommands: 900,
    analysisAlpha, nomination, strengthPlan: split === 'confirmation' ? design.confirmation.strengthPlan : {
      effect: design.monitoring.question, independentUnit: 'paired seed block', uncertainty: design.monitoring.interval,
      sampleJustification: { radius: design.monitoring.intervalRadius, power: design.monitoring.powerLowerBoundAtThirtyPointShift } } };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  phase = label; status();
  const execution = await command('scripts/run-native-ladder.mjs', [manifestPath, directory], directory, `${label}.log`);
  assertInputs();
  const receipt = readJson(path.join(directory, 'receipt.json'));
  const panel = { label, ...nomination, state: receipt.state, stopReason: receipt.stopReason,
    receiptSha256: hashFile(path.join(directory, 'receipt.json')), elapsedSeconds: receipt.elapsedSeconds,
    plannedPairs: seeds.length, completedPairs: receipt.blocks.filter(block => block.outcomes.length === 2).length };
  panels.push(panel); status();
  if (split === 'confirmation') assert.equal(execution.code, 0, 'final confirmation incomplete');
  return directory;
}
function preserve() {
  const target = path.resolve(inputs.archiveDirectory);
  assert(!fs.existsSync(target), 'fresh preservation directory required');
  assert(!target.startsWith(root + path.sep), 'archive must be outside source');
  fs.mkdirSync(target, { recursive: true });
  const files = [];
  function copy(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name), source = path.join(directory, entry.name), destination = path.join(target, name);
      if (entry.isDirectory()) { fs.mkdirSync(destination); copy(source, name); }
      else { fs.copyFileSync(source, destination); const sha256 = hashFile(source); assert.equal(hashFile(destination), sha256);
        files.push({ path: name.replaceAll('\\', '/'), sha256 }); }
    }
  }
  copy(root);
  fs.writeFileSync(path.join(target, 'drive-preservation-manifest.json'), JSON.stringify({ at: new Date().toISOString(), files }, null, 2) + '\n');
  save('preservation.json', { archiveDirectory: target, verifiedFiles: files.length });
}
save('pins.json', { sourcePins, inputPins });
save('design.json', design); status();
try {
  for (const [index, time] of design.monitoring.snapshotTimesUtc.entries()) {
    phase = `waiting-for-monitor-${index + 1}`; status();
    await waitUntil(Date.parse(time));
    const selected = selectCheckpoint(Date.parse(time));
    if (!selected) { panels.push({ label: `monitor-${index + 1}`, state: 'unavailable', reason: 'no verified training update by nominal time' }); continue; }
    await runPanel(`monitor-${index + 1}`, selected, design.monitoring.seeds, 'development', 2, 7200, .025);
  }
  phase = 'waiting-for-final-candidate'; status();
  const deadline = Date.parse(design.training.deadlineUtc);
  await waitUntil(deadline);
  const finalPath = path.join(inputs.trainingDirectory, 'final-candidate.json');
  while (!fs.existsSync(finalPath)) {
    assert(Date.now() < deadline + 7200000, 'final candidate handoff unavailable after two hours');
    await waitUntil(Date.now() + 30000);
  }
  const final = readJson(finalPath), checkpoint = selectCheckpoint(deadline);
  assert(checkpoint && final.available === true, 'no admitted final candidate');
  assert.equal(final.checkpointSha256, checkpoint.checkpointSha256);
  assert.equal(final.checkpoint, checkpoint.checkpoint);
  save('confirmation-protocol.json', design.confirmation);
  const directory = await runPanel('confirmation', checkpoint, design.confirmation.seeds, 'confirmation', 6,
    design.confirmation.maximumWallSeconds, .05);
  phase = 'verifying-final-result'; status();
  const exported = await command('scripts/export-strength-confirmation.mjs', [directory, path.join(root, 'confirmation-protocol.json'),
    path.join(root, 'public-result.json')], directory, 'verification.log');
  assert.equal(exported.code, 0, 'final evidence verification failed');
  save('ladder-inputs.json', { anchor: 'first-baseline', sources: [{ type: 'native-ladder', receipt: path.join(directory, 'receipt.json') }] });
  const ingested = await command('scripts/report-native-ladder.mjs', [path.join(root, 'ladder-inputs.json'), path.join(root, 'ladder-report.json')],
    directory, 'verification.log');
  assert.equal(ingested.code, 0, 'final ladder ingestion failed');
  phase = 'completed'; status(); clearInterval(heartbeat); preserve();
} catch (error) {
  phase = 'failed'; save('error.json', { at: new Date().toISOString(), reason: error.message }); status(); process.exitCode = 2;
} finally { clearInterval(heartbeat); }
