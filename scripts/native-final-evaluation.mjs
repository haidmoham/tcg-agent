import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, isDeepStrictEqual } from 'node:util';
import { NativeModelClient } from '../integrations/local-worker/learning-model.mjs';
import { generateLearningLane } from '../integrations/local-worker/learning-rollout.mjs';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sources = ['scripts/native-final-evaluation.mjs', 'learning/model-two-plan.json', 'learning/native_torch.py',
  'integrations/local-worker/learning-model.mjs', 'integrations/local-worker/learning-rollout.mjs', 'integrations/local-worker/learning-features.mjs',
  'integrations/local-worker/audit-runner.mjs', 'integrations/local-worker/probe.mjs', 'integrations/local-worker/policy-view.mjs',
  'integrations/local-worker/semantic-state.mjs', 'integrations/local-worker/decision-domain.mjs'];

export function finalEvaluationTasks(plan) {
  const expected = [
    { id: '92001-human', seed: 92001, ordinaryPolicySeat: 'human', seatOrder: [0, 1] },
    { id: '92001-opponent', seed: 92001, ordinaryPolicySeat: 'opponent', seatOrder: [1, 0] },
    { id: '92002-human', seed: 92002, ordinaryPolicySeat: 'human', seatOrder: [0, 1] },
    { id: '92002-opponent', seed: 92002, ordinaryPolicySeat: 'opponent', seatOrder: [1, 0] },
  ];
  const settings = plan?.finalEvaluation;
  if (plan?.schema !== 'native-second-model-plan/1' || settings?.learnerDeckIndex !== 0 || settings.maximumGameSeconds !== 180
      || settings.maximumGameCommands !== 400 || settings.untouchedUntilCheckpointSelected !== true
      || !isDeepStrictEqual(settings.casesPerModel, expected)) throw new Error('fixed untouched final-evaluation plan required');
  return expected;
}

export function finalFailure(error, cancellation = null) {
  if (error?.code === 'NATIVE_EPISODE_TIME_BUDGET') return { status: 'capacity-timeout', reason: 'episode-wall-budget', code: error.code };
  if (cancellation === 'global-wall-budget' && (['GLOBAL_EVALUATION_TIME_BUDGET', 'ABORT_ERR'].includes(error?.code)
      || ['native learning lane cancelled', 'worker closed or request already pending', 'model service closed'].includes(error?.message)))
    return { status: 'capacity-timeout', reason: 'global-wall-budget', code: 'GLOBAL_EVALUATION_TIME_BUDGET' };
  return { status: 'fatal', reason: error?.message ?? 'unknown evaluation failure', code: error?.code ?? null };
}

export function nativeOutcome(winnerSeat, policySeat) {
  if (!['human', 'opponent'].includes(policySeat) || !['human', 'opponent', null].includes(winnerSeat)) throw new Error('invalid native terminal outcome');
  return { nativeWinnerSeat: winnerSeat, modelWin: winnerSeat === null ? null : winnerSeat === policySeat,
    outcome: winnerSeat === null ? 'native-terminal-without-winner' : winnerSeat === policySeat ? 'model-win' : 'model-loss' };
}

function sourceHashes() { return Object.fromEntries(sources.map(path => [path, hash(readFileSync(join(root, path)))])); }
function inside(directory, target) {
  const path = relative(directory, target);
  if (!path || isAbsolute(path) || path.startsWith('..')) throw new Error('evaluation artifact escaped its private directory');
  return path.replaceAll('\\', '/');
}
async function reap(session) {
  const worker = session.worker;
  if (!worker) return;
  worker.close();
  if (worker.child.pid && worker.child.exitCode === null && worker.child.signalCode === null)
    await new Promise(accept => { worker.child.once('exit', accept); worker.child.once('close', accept); });
}

export async function evaluateFixedCheckpoint(configPath, name, modelConfigPath) {
  const started = performance.now(), deadlineUtcMilliseconds = Date.now() + 780000;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '')) throw new Error('fresh private final-evaluation name required');
  const config = JSON.parse(readFileSync(configPath, 'utf8')); verifyLocalInputs(config);
  if (config.buildConfiguration !== 'Release' || config.projectionCopyMode !== 'projection-turn-v1') throw new Error('accepted Release turn-profile worker required');
  const modelConfig = JSON.parse(readFileSync(modelConfigPath, 'utf8'));
  if (modelConfig.device !== 'cpu' || !isAbsolute(modelConfig.executable ?? '') || !isAbsolute(modelConfig.checkpoint ?? '')) throw new Error('explicit CPU model executable and private checkpoint required');
  const runs = join(root, 'runs'); mkdirSync(runs, { recursive: true });
  if (realpathSync(runs) !== runs) throw new Error('private evaluation runs directory must not be redirected');
  const originalCheckpoint = realpathSync(modelConfig.checkpoint); inside(runs, originalCheckpoint);
  const checkpointSha256 = hash(readFileSync(originalCheckpoint));
  const plan = JSON.parse(readFileSync(join(root, 'learning/model-two-plan.json'), 'utf8')), tasks = finalEvaluationTasks(plan), hashes = sourceHashes();
  const output = join(runs, name); mkdirSync(output);
  for (const path of sources) {
    const bytes = readFileSync(join(root, path));
    if (hash(bytes) !== hashes[path]) throw new Error('evaluation source changed during snapshot');
    const target = join(output, 'source-snapshot', path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' });
  }
  const checkpoint = join(output, 'fixed-checkpoint.pt'); copyFileSync(originalCheckpoint, checkpoint);
  save(join(output, 'native-config.json'), config); save(join(output, 'model-config.json'), { ...modelConfig, checkpoint }); save(join(output, 'plan.json'), plan);
  const pins = Object.fromEntries(['workerSha256', 'executableSha256', 'manifestSha256', 'policySha256'].map(key => [key, config[key]]));
  const assertFixed = () => {
    if (hash(readFileSync(originalCheckpoint)) !== checkpointSha256 || hash(readFileSync(checkpoint)) !== checkpointSha256) throw new Error('selected checkpoint changed during final evaluation');
    if (!isDeepStrictEqual(sourceHashes(), hashes)) throw new Error('final-evaluation source changed after admission');
  };
  let session = {}, model = null, cancellation = null, info = null, preflight = null;
  const abort = new AbortController(), outcomes = [], fatalFailures = [];
  const cancel = reason => {
    cancellation = reason;
    const error = Object.assign(new Error(reason), { code: reason === 'global-wall-budget' ? 'GLOBAL_EVALUATION_TIME_BUDGET' : 'EVALUATION_INTERRUPTED' });
    session.worker?.close(error); model?.close(error); abort.abort();
  };
  const interrupt = () => cancel('operator-interrupted');
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const timer = setTimeout(() => cancel('global-wall-budget'), Math.max(0, deadlineUtcMilliseconds - Date.now()));
  try {
    assertFixed();
    const code = 'import json,sys,torch\ntorch.set_num_threads(1)\np=torch.load(sys.argv[1],map_location="cpu",weights_only=True)\ns=p["state_dict"]\nassert p["schema"]=="native-ordinary-features/1"\nassert s and all(isinstance(v,torch.Tensor) and bool(torch.isfinite(v).all()) and bool((v.abs()<=1e6).all()) for v in s.values()),"nonfinite or excessive checkpoint parameter"\nn=sum(v.numel() for v in s.values())\nassert n==1953,"checkpoint parameter count mismatch"\nprint(json.dumps({"finite":True,"maximumAbsoluteParameterBound":1000000,"parameters":n,"device":"cpu"}))';
    const preflightStarted = performance.now();
    const checked = await execute(modelConfig.executable, ['-c', code, checkpoint], { windowsHide: true, timeout: 30000, signal: abort.signal, maxBuffer: 1024 * 1024 });
    preflight = { ...JSON.parse(checked.stdout), elapsedMilliseconds: performance.now() - preflightStarted };
    assertFixed();
    const startupStarted = performance.now(); model = new NativeModelClient({ ...modelConfig, checkpoint });
    info = await model.verify();
    if (info.device !== 'cpu' || realpathSync(info.checkpoint) !== realpathSync(checkpoint)) throw new Error('fixed CPU checkpoint was not loaded');
    info.startupMilliseconds = performance.now() - startupStarted;
    for (const task of tasks) {
      if (cancellation || Date.now() >= deadlineUtcMilliseconds) { cancellation ??= 'global-wall-budget'; break; }
      const directory = join(output, task.id); mkdirSync(directory);
      const caseStarted = performance.now(), requestsBefore = model.requests;
      let outcome;
      try {
        assertFixed();
        const remaining = Math.floor((deadlineUtcMilliseconds - Date.now()) / 1000);
        if (remaining < 1) { cancellation = 'global-wall-budget'; break; }
        const result = await generateLearningLane(config, [task], directory, { session, retainSession: true, signal: abort.signal,
          maxSeconds: Math.min(180, remaining), maxCommands: 400, boundaryEvery: 1,
          decideOrdinary: context => context.seat === context.task.ordinaryPolicySeat ? model.decide(context) : null,
          onProgress: value => console.log(JSON.stringify({ case: task.id, ...value })) });
        const game = result.games[0], inferenceRequests = model.requests - requestsBefore;
        if (game.modelDecisionCount !== inferenceRequests || inferenceRequests <= 0 || game.ordinaryPolicySeat !== task.ordinaryPolicySeat) throw new Error('accepted model commands disagree with inference count or policy role');
        assertFixed();
        const receiptPath = join(directory, 'fixed-case-receipt.json');
        const admitted = { ...game, ...nativeOutcome(game.winnerSeat, task.ordinaryPolicySeat), checkpointSha256, device: 'cpu', pins, sourceHashes: hashes, inferenceRequests };
        save(receiptPath, admitted);
        outcome = { ...task, status: 'completed', ...nativeOutcome(game.winnerSeat, task.ordinaryPolicySeat), commands: game.commands,
          modelDecisionCount: game.modelDecisionCount, inferenceRequests, terminalStateHash: game.terminalStateHash,
          receiptPath: inside(output, receiptPath), receiptSha256: hash(readFileSync(receiptPath)), elapsedMilliseconds: performance.now() - caseStarted };
      } catch (error) {
        outcome = { ...task, ...finalFailure(error, cancellation), elapsedMilliseconds: performance.now() - caseStarted,
          attemptedInferenceRequests: model.requests - requestsBefore, failurePath: inside(output, join(directory, 'evaluation-failure.json')) };
        save(join(directory, 'evaluation-failure.json'), { ...outcome, error: { message: error.message, code: error.code ?? null, stderr: error.stderr ?? null } });
        await reap(session); session = {};
      }
      outcomes.push(outcome); save(join(directory, 'outcome.json'), outcome);
      if (outcome.status === 'fatal') { fatalFailures.push(outcome); break; }
    }
  } catch (error) {
    const failure = finalFailure(error, cancellation);
    if (failure.status === 'fatal') fatalFailures.push({ ...failure, phase: 'startup-or-provenance', stderr: error.stderr ?? null });
    else cancellation = 'global-wall-budget';
    save(join(output, 'startup-failure.json'), { ...failure, stderr: error.stderr ?? null });
  } finally {
    clearTimeout(timer); await reap(session); if (model) await model.shutdown();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    try { assertFixed(); } catch (error) { fatalFailures.push({ status: 'fatal', reason: error.message, phase: 'final-provenance' }); }
  }
  const completed = outcomes.filter(item => item.status === 'completed'), capacityFailures = outcomes.filter(item => item.status === 'capacity-timeout');
  const unattempted = tasks.filter(task => !outcomes.some(item => item.id === task.id)).map(task => ({ ...task, status: 'unattempted', reason: fatalFailures.length ? 'fatal-prior-case-or-startup' : cancellation ?? 'global-wall-budget' }));
  const summary = { schema: 'native-fixed-checkpoint-evaluation/1', complete: true, fatal: fatalFailures.some(item => item.status === 'fatal'),
    timestamp: new Date().toISOString(), tasks, completed, capacityFailures, fatalFailures, unattempted,
    model: { checkpointSha256, originalCheckpoint, fixedCheckpoint: 'fixed-checkpoint.pt', device: 'cpu', info, preflight,
      inferenceRequests: model?.requests ?? 0, inferenceMilliseconds: model?.inferenceMilliseconds ?? 0, checkpointUnchanged: hash(readFileSync(originalCheckpoint)) === checkpointSha256 && hash(readFileSync(checkpoint)) === checkpointSha256 },
    pins, sourceHashes: hashes, limits: { maximumWallSeconds: 780, maximumGameSeconds: 180, maximumGameCommands: 400, nativeConcurrency: 1, replacements: 0 },
    counts: { completed: completed.length, capacityFailures: capacityFailures.length, fatalFailures: fatalFailures.filter(item => item.status === 'fatal').length,
      unattempted: unattempted.length, wins: completed.filter(item => item.modelWin === true).length, losses: completed.filter(item => item.modelWin === false).length,
      nativeTerminalWithoutWinner: completed.filter(item => item.modelWin === null).length, commands: completed.reduce((sum, item) => sum + item.commands, 0),
      acceptedModelDecisions: completed.reduce((sum, item) => sum + item.modelDecisionCount, 0) },
    elapsedMilliseconds: performance.now() - started, stopReason: cancellation ?? (fatalFailures.length ? 'fatal' : 'fixed-plan-finished'),
    modelSelectionChanged: false, interpretation: 'four fixed descriptive cases per checkpoint; timeouts are incomplete, not losses; no strength or superiority claim', fullStandardClaim: false };
  save(join(output, 'receipt.json'), summary); return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error('Usage: node scripts/native-final-evaluation.mjs <private-native-config.json> <fresh-run-name> <private-cpu-model-config.json>');
    const result = await evaluateFixedCheckpoint(...args); if (result.fatal) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
