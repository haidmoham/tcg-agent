import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { generateLearningLane } from '../integrations/local-worker/learning-rollout.mjs';
import { ordinaryFeatureContract } from '../integrations/local-worker/learning-features.mjs';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const protocol = 'native-supervised-collect/1';
const sources = ['scripts/native-collect.mjs', 'learning/model-two-plan.json', 'integrations/local-worker/learning-rollout.mjs',
  'integrations/local-worker/learning-features.mjs', 'integrations/local-worker/audit-runner.mjs', 'integrations/local-worker/probe.mjs',
  'integrations/local-worker/policy-view.mjs', 'integrations/local-worker/semantic-state.mjs', 'integrations/local-worker/decision-domain.mjs'];

export function collectionTasks(plan) {
  const limits = plan?.collection;
  const training = Array.from({ length: 18 }, (_, index) => 91001 + index), validation = Array.from({ length: 6 }, (_, index) => 91019 + index);
  if (plan?.schema !== 'native-second-model-plan/1' || limits?.workers !== 4 || limits.maximumAttempts !== 24
      || limits.maximumCompleteGames !== 24 || limits.maximumWallSeconds !== 1800 || limits.maximumGameSeconds !== 180
      || limits.maximumGameCommands !== 400 || limits.warmups !== 0 || limits.replacements !== 0
      || !isDeepStrictEqual(limits.trainingSeeds, training) || !isDeepStrictEqual(limits.validationSeeds, validation)) throw new Error('fixed second-model collection plan required');
  return [...training, ...validation].map((seed, index) => ({ id: `seed-${seed}`, seed, seatOrder: index % 2 ? [1, 0] : [0, 1], split: index < 18 ? 'train' : 'validation' }));
}

export function collectionSourceHashes() {
  return Object.fromEntries(sources.map(path => [path, hash(readFileSync(join(root, path)))]));
}

export function classifyCollectionFailure(error, cancellation = null) {
  if (error?.code === 'NATIVE_EPISODE_TIME_BUDGET') return { status: 'capacity-timeout', reason: 'episode-wall-budget', code: error.code };
  const cancelledWorker = ['native learning lane cancelled', 'local worker closed', 'worker closed or request already pending'].includes(error?.message);
  if (cancellation === 'global-wall-budget' && (error?.code === 'GLOBAL_COLLECTION_TIME_BUDGET' || cancelledWorker))
    return { status: 'capacity-timeout', reason: 'global-wall-budget', code: 'GLOBAL_COLLECTION_TIME_BUDGET' };
  if (cancellation === 'fatal-peer' && (error?.code === 'COLLECTION_PEER_FAILED' || cancelledWorker))
    return { status: 'cancelled', reason: 'fatal-peer', code: 'COLLECTION_PEER_FAILED' };
  return { status: 'fatal', reason: error?.message ?? 'unknown collection failure', code: error?.code ?? null };
}

function verifySources(expected) {
  if (!isDeepStrictEqual(collectionSourceHashes(), expected)) throw new Error('collection source changed after admission');
}

function privateRelative(directory, target) {
  const value = relative(directory, target);
  if (!value || isAbsolute(value) || value.startsWith('..')) throw new Error('collection artifact escaped its private run');
  return value.replaceAll('\\', '/');
}

async function reapSession(session) {
  const worker = session.worker;
  if (!worker) return;
  worker.close();
  const child = worker.child;
  if (child.pid && child.exitCode === null && child.signalCode === null)
    await new Promise(accept => { child.once('exit', accept); child.once('close', accept); });
}

async function runLane(configPath, directory, manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')), config = JSON.parse(readFileSync(configPath, 'utf8'));
  const send = payload => {
    if (process.connected) process.send({ protocol, collectionId: manifest.collectionId, lane: manifest.lane, ...payload }, error => { if (error) cancel('controller-disconnected'); });
  };
  const outcomes = [];
  let session = {}, cancellation = null;
  const abort = new AbortController();
  const cancel = reason => {
    if (cancellation) return;
    cancellation = reason;
    const code = reason === 'global-wall-budget' ? 'GLOBAL_COLLECTION_TIME_BUDGET' : reason === 'fatal-peer' ? 'COLLECTION_PEER_FAILED' : 'COLLECTION_CONTROLLER_DISCONNECTED';
    session.worker?.close(Object.assign(new Error(reason), { code }));
    abort.abort();
  };
  const disconnect = () => cancel('controller-disconnected');
  process.on('disconnect', disconnect);
  process.on('message', message => { if (message?.cancel) cancel(message.cancel); });
  try {
    verifySources(manifest.sourceHashes);
    verifyLocalInputs(config);
    for (const key of Object.keys(manifest.pins)) if (config[key] !== manifest.pins[key]) throw new Error('collection lane input pins changed');
    send({ kind: 'ready', sourceHashes: manifest.sourceHashes });
    for (const task of manifest.tasks) {
      if (abort.signal.aborted || Date.now() >= manifest.deadlineUtcMilliseconds) break;
      const started = performance.now(), gameDirectory = join(directory, task.id); mkdirSync(gameDirectory);
      let outcome;
      try {
        verifySources(manifest.sourceHashes);
        const remainingSeconds = Math.floor((manifest.deadlineUtcMilliseconds - Date.now()) / 1000);
        if (remainingSeconds < 1) break;
        const lane = await generateLearningLane(config, [task], gameDirectory, { session, retainSession: true, signal: abort.signal,
          maxCommands: 400, maxSeconds: Math.min(180, remainingSeconds), boundaryEvery: 1,
          onProgress: value => send({ kind: 'progress', task: task.id, ...value }) });
        verifySources(manifest.sourceHashes);
        const game = lane.games[0];
        const recordsPath = join(gameDirectory, `${task.id}-records.jsonl`), receiptPath = join(gameDirectory, 'admitted-receipt.json');
        const admitted = { ...game, collectionSchema: 'native-supervised-collection/1', split: task.split,
          pins: manifest.pins, sourceHashes: manifest.sourceHashes, collectionId: manifest.collectionId };
        save(receiptPath, admitted);
        outcome = { ...task, status: 'completed', recordsPath: privateRelative(manifest.output, recordsPath), receiptPath: privateRelative(manifest.output, receiptPath),
          receiptSha256: hash(readFileSync(receiptPath)), recordsFileSha256: hash(readFileSync(recordsPath)), ordinaryDecisions: game.ordinaryDecisions,
          commands: game.commands, terminalStateHash: game.terminalStateHash, recordsSha256: game.recordsSha256, trajectorySha256: game.trajectorySha256,
          elapsedMilliseconds: performance.now() - started };
      } catch (error) {
        const category = classifyCollectionFailure(error, cancellation);
        outcome = { ...task, ...category, elapsedMilliseconds: performance.now() - started,
          failurePath: privateRelative(manifest.output, join(gameDirectory, 'collection-failure.json')) };
        save(join(gameDirectory, 'collection-failure.json'), { ...outcome, error: { message: error.message, code: error.code ?? null } });
        await reapSession(session); session = {};
      }
      outcomes.push(outcome); save(join(gameDirectory, 'outcome.json'), outcome); send({ kind: 'outcome', outcome });
      if (outcome.status === 'fatal' || outcome.status === 'cancelled' || cancellation) break;
    }
  } catch (error) {
    save(join(directory, 'lane-failure.json'), { message: error.message, code: error.code ?? null });
    send({ kind: 'fatal', message: error.message });
  } finally {
    await reapSession(session);
    save(join(directory, 'lane-receipt.json'), { protocol, lane: manifest.lane, outcomes, cancellation });
    process.removeListener('disconnect', disconnect);
    if (process.connected) process.disconnect();
  }
}

export async function collectSupervised(configPath, name) {
  const started = performance.now(), startedUtcMilliseconds = Date.now();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '')) throw new Error('new bounded collection run name required');
  const config = JSON.parse(readFileSync(configPath, 'utf8')); verifyLocalInputs(config);
  if (config.buildConfiguration !== 'Release' || config.projectionCopyMode !== 'projection-turn-v1' || config.offlineAuditVersion !== 'indigo-offline-audit/1') throw new Error('accepted Release turn-profile audit worker required');
  const plan = JSON.parse(readFileSync(join(root, 'learning/model-two-plan.json'), 'utf8')), tasks = collectionTasks(plan);
  const sourceHashes = collectionSourceHashes(), pins = Object.fromEntries(['workerSha256', 'executableSha256', 'manifestSha256', 'policySha256'].map(key => [key, config[key]]));
  const runs = join(root, 'runs'); mkdirSync(runs, { recursive: true });
  if (realpathSync(runs) !== runs) throw new Error('private collection directory must not be redirected');
  const output = join(runs, name); mkdirSync(output);
  const snapshot = join(output, 'source-snapshot'); mkdirSync(snapshot);
  for (const path of sources) {
    const target = join(snapshot, path), bytes = readFileSync(join(root, path));
    if (hash(bytes) !== sourceHashes[path]) throw new Error('collection source changed during archival');
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' });
  }
  verifySources(sourceHashes);
  save(join(output, 'config.json'), config); save(join(output, 'plan.json'), plan);
  const collectionId = randomUUID(), deadlineUtcMilliseconds = startedUtcMilliseconds + 1800000;
  const children = [], completions = [], outcomes = new Map(), fatalFailures = [];
  let cancellation = null;
  const cancel = reason => {
    if (!cancellation || reason === 'fatal-peer') cancellation = reason;
    for (const child of children) if (child.connected) child.send({ cancel: reason }, () => {});
  };
  const fail = error => { fatalFailures.push({ message: error.message, code: error.code ?? null }); cancel('fatal-peer'); };
  const interrupted = () => fail(new Error('collection interrupted by operator'));
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  const timer = setTimeout(() => cancel('global-wall-budget'), Math.max(0, deadlineUtcMilliseconds - Date.now()));
  try {
    for (let index = 0; index < 4; index++) {
      const directory = join(output, `lane-${index}`); mkdirSync(directory);
      const manifest = { protocol, collectionId, lane: index, output, tasks: tasks.filter((_, task) => task % 4 === index), pins, sourceHashes, deadlineUtcMilliseconds };
      const manifestPath = join(directory, 'manifest.json'); save(manifestPath, manifest);
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'lane', resolve(configPath), directory, manifestPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', chunk => process.stderr.write(chunk));
      child.on('message', message => {
        if (message?.protocol !== protocol || message.collectionId !== collectionId || message.lane !== index) return fail(new Error('collection lane message correlation failed'));
        if (message.kind === 'ready') {
          if (!isDeepStrictEqual(message.sourceHashes, sourceHashes)) fail(new Error('collection lane source admission failed'));
        } else if (message.kind === 'outcome') {
          const item = message.outcome, task = manifest.tasks.find(value => value.id === item?.id);
          if (!task || !isDeepStrictEqual(task, Object.fromEntries(['id', 'seed', 'seatOrder', 'split'].map(key => [key, item[key]]))) || outcomes.has(item.id)) return fail(new Error('collection task duplicated or changed'));
          outcomes.set(item.id, item); appendFileSync(join(output, 'outcomes.jsonl'), JSON.stringify(item) + '\n');
          console.log(JSON.stringify({ lane: index, task: item.id, status: item.status, commands: item.commands ?? null }));
          if (item.status === 'fatal') fail(new Error(`correctness gate failed for ${item.id}: ${item.reason}`));
        } else if (message.kind === 'fatal') fail(new Error(`collection lane ${index} failed: ${message.message}`));
        else if (message.kind === 'progress') console.log(JSON.stringify({ lane: index, ...message }));
        else fail(new Error('unknown collection lane message'));
      });
      const completion = new Promise(accept => {
        child.once('error', error => { fail(error); accept(); });
        child.once('exit', code => { if (code !== 0) fail(new Error(`collection lane ${index} exited ${code}`)); accept(); });
      });
      completions.push(completion);
    }
    await Promise.all(completions);
    try { verifySources(sourceHashes); } catch (error) { fail(error); }
  } catch (error) { fail(error); }
  finally {
    clearTimeout(timer); if (cancellation) cancel(cancellation); await Promise.allSettled(completions);
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  }
  const items = [...outcomes.values()].sort((a, b) => a.seed - b.seed);
  const completed = items.filter(item => item.status === 'completed'), capacityFailures = items.filter(item => item.status === 'capacity-timeout');
  const cancelled = items.filter(item => item.status === 'cancelled'), taskFatalFailures = items.filter(item => item.status === 'fatal');
  const unattempted = tasks.filter(task => !outcomes.has(task.id)).map(task => ({ ...task, status: 'unattempted', reason: cancellation ?? 'lane-ended-without-task-outcome' }));
  if (unattempted.length && !cancellation) fatalFailures.push({ message: 'collection ended before every declared task had an outcome' });
  const receipt = { schema: 'native-supervised-collection/1', complete: true, fatal: fatalFailures.length > 0 || taskFatalFailures.length > 0,
    timestamp: new Date().toISOString(), collectionId, tasks, completed, capacityFailures, cancelled, unattempted, fatalFailures: [...fatalFailures, ...taskFatalFailures],
    pins, sourceHashes, featureContract: ordinaryFeatureContract, projectionCopyMode: config.projectionCopyMode,
    limits: { maximumAttempts: 24, maximumCompleteGames: 24, maximumWallSeconds: 1800, maximumGameSeconds: 180, maximumGameCommands: 400, workers: 4, warmups: 0, replacements: 0 },
    elapsedMilliseconds: performance.now() - started, stopReason: cancellation ?? 'all-declared-tasks-finished',
    counts: { attempted: items.length, completed: completed.length, capacityFailures: capacityFailures.length, cancelled: cancelled.length, unattempted: unattempted.length,
      trainGames: completed.filter(item => item.split === 'train').length, validationGames: completed.filter(item => item.split === 'validation').length,
      commands: completed.reduce((sum, item) => sum + item.commands, 0), ordinaryDecisions: completed.reduce((sum, item) => sum + item.ordinaryDecisions, 0) },
    workload: 'fresh pinned heuristic games with all per-frame authority, RNG, hidden-world and native legal-offer audits; no warmups or replay', fullStandardClaim: false };
  save(join(output, 'receipt.json'), receipt); return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === 'lane' && args.length === 4) await runLane(args[1], args[2], args[3]);
    else if (args.length === 2) { const receipt = await collectSupervised(...args); if (receipt.fatal) process.exitCode = 2; }
    else throw new Error('Usage: node scripts/native-collect.mjs <private-config.json> <new-run-name>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
