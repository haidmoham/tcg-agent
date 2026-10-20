import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const configPath = resolve(process.argv[2] ?? '');
if (process.argv.length !== 3) throw new Error('Usage: node scripts/run-model3-training.mjs <private-campaign-config.json>');
const config = read(configPath);
for (const name of ['python', 'nativeConfig', 'profilePlan', 'dataset', 'modelRoot', 'campaignDirectory'])
  if (!isAbsolute(config[name] ?? '')) throw new Error(`absolute ${name} required`);
if (!Number.isInteger(config.maximumBatches) || config.maximumBatches < 1 || config.maximumBatches > 128
    || !Number.isInteger(config.gamesPerBatch) || config.gamesPerBatch < 2 || config.gamesPerBatch > 16
    || !Number.isInteger(config.firstSeed) || config.firstSeed < 95001
    || !Number.isFinite(Date.parse(config.stopByUtc))) throw new Error('bounded campaign and explicit deadline required');
const campaign = resolve(config.campaignDirectory);
if (existsSync(campaign)) throw new Error('fresh campaign directory required');
mkdirSync(campaign, { recursive: true });
save(join(campaign, 'campaign-config.json'), config);
const sourceSha256 = hash(fileURLToPath(import.meta.url));
const log = value => {
  const row = { at: new Date().toISOString(), ...value };
  appendFileSync(join(campaign, 'events.jsonl'), JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
};
async function run(executable, args) {
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, PTCG_AGENT_MODEL_ROOT: config.modelRoot } });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`training command exited ${code ?? signal}: ${args[0]}`)));
  });
}
const started = Date.now(), deadline = Date.parse(config.stopByUtc);
let selected = null, updates = 0;
try {
  log({ event: 'waiting-for-active-collection', dataset: config.dataset });
  while (!existsSync(join(config.dataset, 'receipt.json'))) {
    if (Date.now() >= deadline) throw new Error('campaign deadline reached before collection completed');
    await pause(10000);
  }
  const data = read(join(config.dataset, 'receipt.json'));
  if (data.fatal !== false || data.complete !== true) throw new Error('active collection failed its runtime admission');
  const bcDirectory = config.bcDirectory ?? join(config.modelRoot, config.modelGroup, 'bc');
  if (!config.bcDirectory) {
    log({ event: 'bc-training-start', games: data.games?.length, output: bcDirectory });
    await run(config.python, ['learning/train_card_action.py', config.dataset, bcDirectory,
      '--device', 'cuda', '--updates', '2000', '--max-seconds', '180']);
  } else log({ event: 'existing-bc-warm-start', output: bcDirectory });
  const selection = read(join(bcDirectory, 'model-config.json'));
  const selectionConfigPath = join(campaign, 'frozen-selection-cpu.json');
  save(selectionConfigPath, { ...selection, device: 'cpu' });
  const outputDirectory = join(config.modelRoot, config.modelGroup, 'ppo');
  const initial = config.initialPpoCheckpoint ?? join(outputDirectory, 'update-000.pt');
  if (!config.initialPpoCheckpoint) {
    log({ event: 'ppo-initialize', bcCheckpointSha256: hash(selection.checkpoint) });
    await run(config.python, ['learning/ppo_runtime.py', 'init', selection.checkpoint, initial,
      '--device', 'cpu', '--seed', '1729']);
  } else log({ event: 'existing-ppo-initialization', checkpoint: initial });
  selected = initial;
  const base = read(config.profilePlan);
  for (let batch = 0; batch < config.maximumBatches; batch++) {
    const remaining = Math.floor((deadline - Date.now()) / 1000);
    if (remaining < 30) break;
    const tag = String(batch + 1).padStart(3, '0');
    const modelConfigPath = join(campaign, `ppo-config-${tag}.json`);
    save(modelConfigPath, { executable: config.python, checkpoint: selected, modelRoot: config.modelRoot,
      device: 'cpu', seed: 1729, printingAliases: selection.printingAliases });
    const tasks = Array.from({ length: config.gamesPerBatch }, (_, index) => {
      const seed = config.firstSeed + batch * config.gamesPerBatch + index;
      const human = index % 2 === 0;
      return { id: `seed-${seed}`, seed, seatOrder: human ? [0, 1] : [1, 0], policySeat: human ? 'human' : 'opponent' };
    });
    const planPath = join(campaign, `plan-${tag}.json`), runName = `${config.runPrefix}-${tag}`;
    save(planPath, { schema: 'native-ppo-rollout-plan/1', ppoConfig: modelConfigPath,
      selectionConfig: selectionConfigPath, workers: 4, maximumWallSeconds: Math.min(600, remaining),
      maximumGameSeconds: Math.min(240, remaining), maximumGameCommands: 500, auditEvery: 32,
      opponentPolicy: 'teacher', seed: 1729, diagnostics: base.diagnostics, tasks });
    const before = Date.now();
    log({ event: 'ppo-collection-start', batch: batch + 1, seeds: tasks.map(task => task.seed), parent: selected });
    await run(process.execPath, ['scripts/ppo-native-rollout.mjs', config.nativeConfig, runName, planPath]);
    const rolloutDirectory = join(root, 'runs', runName), receipt = read(join(rolloutDirectory, 'receipt.json'));
    log({ event: 'ppo-collection-end', batch: batch + 1, counts: receipt.counts,
      elapsedSeconds: (Date.now() - before) / 1000 });
    if (!receipt.recordsCount) throw new Error('PPO batch contains no admitted ordinary transitions');
    const next = join(outputDirectory, `update-${tag}.pt`);
    await run(config.python, ['learning/ppo_runtime.py', 'update', selected, rolloutDirectory, next, '--device', 'cuda']);
    selected = next; updates++;
    const updateReceipt = read(next.replace(/\.pt$/, '.receipt.json'));
    log({ event: 'ppo-update-accepted', batch: batch + 1, checkpointSha256: updateReceipt.checkpointSha256,
      metrics: updateReceipt.metrics });
  }
  const final = { schema: 'model3-outcome-campaign/1', completed: true, selectedCheckpoint: selected,
    checkpointSha256: hash(selected), frozenSelectionConfig: selectionConfigPath,
    frozenSelectionSha256: hash(selection.checkpoint), updates, elapsedSeconds: (Date.now() - started) / 1000,
    stopReason: updates === config.maximumBatches ? 'fixed-batch-budget' : 'declared-deadline',
    configSha256: hash(configPath), sourceSha256, comparisonScope: 'Model2 versus Model3 only',
    checkpointSelection: 'last finite accepted PPO update; no final-outcome selection' };
  save(join(campaign, 'receipt.json'), final); log({ event: 'campaign-finished', ...final });
} catch (error) {
  save(join(campaign, 'failure.json'), { error: error.message, updates, lastAcceptedCheckpoint: selected,
    elapsedSeconds: (Date.now() - started) / 1000, sourceSha256 });
  console.error(error.stack); process.exitCode = 1;
}
