import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ordinaryFeatureContract } from '../integrations/local-worker/learning-features.mjs';
import { generateLearningLane, learningTasks, evaluationTasks } from '../integrations/local-worker/learning-rollout.mjs';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import { NativeModelClient } from '../integrations/local-worker/learning-model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const usage = 'Usage: node scripts/native-learning.mjs <scale|gate|evaluate|evaluate-opponent> <private-config.json> <new-run-name> [private-model-config.json]';
let output;

async function scale(configPath, config, directory, workers, tasks, warmup = true) {
  const started = performance.now(), children = [], completions = [], ready = [];
  let measuredStarted = null;
  const cancel = () => children.forEach(child => { if (child.connected) child.send({ cancel: true }, () => {}); });
  const timer = setTimeout(cancel, 20 * 60 * 1000);
  try {
    const laneRuns = Array.from({ length: workers }, async (_, index) => {
      const laneDirectory = join(directory, `lane-${index}`); mkdirSync(laneDirectory);
      const laneTasks = tasks.filter((_, task) => task % workers === index);
      const taskPath = join(laneDirectory, 'tasks.json'); save(taskPath, { tasks: laneTasks, warmup });
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'lane', resolve(configPath), laneDirectory, taskPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      let markReady;
      const readiness = new Promise(accept => { markReady = accept; }); ready.push(readiness);
      child.on('message', message => { if (message?.ready === true) markReady(true); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => process.stdout.write(chunk));
      child.stderr.on('data', chunk => process.stderr.write(chunk));
      const completion = new Promise((accept, reject) => { child.once('error', error => { markReady(false); reject(error); }); child.once('exit', code => { markReady(false); accept(code); }); });
      completions.push(completion);
      const code = await completion;
      if (code !== 0) throw new Error(`native learning lane ${index} failed; completed receipts retained`);
      return JSON.parse(readFileSync(join(laneDirectory, 'receipt.json'), 'utf8'));
    });
    const allLanes = Promise.all(laneRuns);
    allLanes.catch(() => {});
    const readiness = await Promise.all(ready);
    if (readiness.some(value => !value)) throw new Error('native learning lane failed before the warmup barrier');
    measuredStarted = performance.now();
    children.forEach(child => child.send({ start: true }, () => {}));
    const lanes = await allLanes;
    const measuredMilliseconds = performance.now() - measuredStarted;
    const elapsedMilliseconds = performance.now() - started;
    const games = lanes.flatMap(lane => lane.games).sort((a, b) => a.seed - b.seed);
    if (games.length !== tasks.length || games.some(game => !game.completedNaturally || game.rejected)) throw new Error('scaling level has incomplete or rejected games');
    const transitions = games.reduce((sum, game) => sum + game.commands, 0), ordinaryDecisions = games.reduce((sum, game) => sum + game.ordinaryDecisions, 0);
    const nativeCpuMilliseconds = games.every(game => game.nativeCpuMilliseconds !== null) ? games.reduce((sum, game) => sum + game.nativeCpuMilliseconds, 0) : null;
    const receipt = { schema: 'native-learning-scaling-level/1', workers, complete: true, games, transitions, ordinaryDecisions, elapsedMilliseconds, measuredMilliseconds,
      warmup: lanes.map(lane => lane.warmup), startupAndWarmupMilliseconds: measuredStarted - started,
      gamesPerSecond: games.length * 1000 / measuredMilliseconds, transitionsPerSecond: transitions * 1000 / measuredMilliseconds,
      ordinaryDecisionsPerSecond: ordinaryDecisions * 1000 / measuredMilliseconds, coldGamesPerSecond: games.length * 1000 / elapsedMilliseconds, errors: 0, truncations: 0,
      nativeCpuMilliseconds, nativeCpuCoreEquivalent: nativeCpuMilliseconds === null ? null : nativeCpuMilliseconds / measuredMilliseconds,
      jsCpuMilliseconds: lanes.reduce((sum, lane) => sum + lane.jsCpuMilliseconds, 0),
      nativeWorkerPeakWorkingSetBytes: lanes.map(lane => lane.games.at(-1)?.processMetrics?.peakWorkingSetBytes ?? null),
      featureContract: ordinaryFeatureContract, projectionCopyMode: config.projectionCopyMode,
      timingIncludes: 'fresh policy decisions, native setup/reset, legal offers, commands, actor projections, complete per-frame RNG/authority audits and hidden-world probes, JSONL and journal writes, OS metric samples',
      timingExcludes: 'full per-lane warmup game and initial native startup, PyTorch inference/training, GUI, Live play', repetitions: 1 };
    save(join(directory, 'receipt.json'), receipt); return receipt;
  } finally { clearTimeout(timer); cancel(); await Promise.allSettled(completions); }
}

try {
  const [mode, configPath, name, tasksPath, ...extra] = process.argv.slice(2);
  if (mode === 'lane') {
    if (!configPath || !name || !tasksPath || extra.length) throw new TypeError(usage);
    const config = JSON.parse(readFileSync(configPath, 'utf8')), input = JSON.parse(readFileSync(tasksPath, 'utf8'));
    const tasks = input.tasks;
    const abort = new AbortController(), session = {};
    let markStart;
    const cancel = () => { abort.abort(); session.worker?.close(); markStart?.(); };
    process.on('disconnect', cancel);
    const start = new Promise(accept => { markStart = accept; });
    process.on('message', message => { if (message?.cancel === true) { cancel(); markStart(); } if (message?.start === true) markStart(); });
    try {
      const progress = value => console.log(JSON.stringify({ lane: name.split(/[\\/]/).at(-1), ...value }));
      let warmup = null;
      if (input.warmup) {
        const warmupDirectory = join(name, 'warmup'); mkdirSync(warmupDirectory);
        warmup = await generateLearningLane(config, [{ id: 'warmup-80000', seed: 80000, seatOrder: [0, 1] }], warmupDirectory, { session, retainSession: true, signal: abort.signal, onProgress: progress });
        save(join(warmupDirectory, 'receipt.json'), warmup);
      }
      process.send({ ready: true }); await start;
      const result = await generateLearningLane(config, tasks, name, { session, signal: abort.signal, onProgress: progress });
      save(join(name, 'receipt.json'), { ...result, warmup });
    } finally { session.worker?.close(); process.removeListener('disconnect', cancel); if (process.connected) process.disconnect(); }
  } else {
    const evaluating = mode === 'evaluate' || mode === 'evaluate-opponent';
    if (!['scale', 'gate', 'evaluate', 'evaluate-opponent'].includes(mode) || !configPath || !/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '') || extra.length || (evaluating ? !tasksPath : tasksPath)) throw new TypeError(usage);
    const config = JSON.parse(readFileSync(configPath, 'utf8')); verifyLocalInputs(config);
    const runs = join(root, 'runs'); mkdirSync(runs, { recursive: true });
    if (realpathSync(runs) !== runs) throw new Error('ignored runs directory must not be redirected');
    output = join(runs, name); mkdirSync(output);
    save(join(output, 'config.json'), config);
    if (evaluating) {
      const modelConfig = JSON.parse(readFileSync(tasksPath, 'utf8'));
      const model = new NativeModelClient(modelConfig);
      try {
        const info = await model.verify();
        const tasks = evaluationTasks(mode);
        const result = await generateLearningLane(config, tasks, output, { decideOrdinary: context => context.seat === context.task.ordinaryPolicySeat ? model.decide(context) : null,
          onProgress: value => console.log(JSON.stringify(value)) });
        save(join(output, 'receipt.json'), { ...result, schema: 'native-learning-evaluation/1', model: info,
          inferenceRequests: model.requests, inferenceMilliseconds: model.inferenceMilliseconds,
          ordinaryPolicySeats: tasks.map(task => task.ordinaryPolicySeat), modelDecisionCount: result.games.reduce((sum, game) => sum + game.modelDecisionCount, 0),
          opponent: 'pinned heuristic in the other seat', prompts: 'pinned heuristic for both seats', freshPolicyDriven: true, replay: false, fullStandardClaim: false,
          interpretation: `${tasks.length}-game end-to-end correctness smoke; no strength or win-rate claim` });
      } finally { await model.shutdown(); }
    } else {
    const tasks = learningTasks(), levels = [];
    const schedule = mode === 'gate' ? [1] : [1, 2, 4];
    for (const workers of schedule) {
      const directory = join(output, `workers-${workers}`); mkdirSync(directory);
      const result = await scale(configPath, config, directory, workers, mode === 'gate' ? tasks.slice(0, 1) : tasks, mode !== 'gate');
      if (levels.length && !isDeepStrictEqual(result.games.map(({ seed, seatOrder, trajectorySha256, recordsSha256, commands, nativeSeedCalls }) => ({ seed, seatOrder, trajectorySha256, recordsSha256, commands, nativeSeedCalls })),
        levels[0].games.map(({ seed, seatOrder, trajectorySha256, recordsSha256, commands, nativeSeedCalls }) => ({ seed, seatOrder, trajectorySha256, recordsSha256, commands, nativeSeedCalls })))) throw new Error('process concurrency changed a trajectory, actor label, command count, or seed transcript');
      levels.push(result); console.log(JSON.stringify({ workers, games: result.games.length, transitions: result.transitions, elapsedMilliseconds: result.elapsedMilliseconds }));
    }
    save(join(output, 'receipt.json'), { schema: 'native-learning-scaling/1', timestamp: new Date().toISOString(), complete: true, freshPolicyDriven: true, replay: false, fullStandardClaim: false,
      featureContract: ordinaryFeatureContract, tasks: mode === 'gate' ? tasks.slice(0, 1) : tasks, levels,
      pins: Object.fromEntries(['workerSha256', 'executableSha256', 'manifestSha256', 'policySha256'].map(key => [key, config[key]])),
      repetitionsPerLevel: 1, interpretation: 'bounded scaling smoke; one fresh fixed seed set per level, no statistical scaling winner claimed' });
    }
  }
} catch (error) {
  if (output) { try { save(join(output, 'failure.json'), { message: error.message, code: error.code ?? null }); } catch {} }
  console.error(error.message); process.exitCode = 1;
}
