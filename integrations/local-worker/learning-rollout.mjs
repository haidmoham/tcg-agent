import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAuditedEpisode } from './audit-runner.mjs';
import { encodeOrdinaryDecision, ordinaryFeatureContract } from './learning-features.mjs';

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

export async function measureNativeProcess(pid) {
  if (process.platform !== 'win32') return { available: false, reason: 'Windows process counters unavailable' };
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('native process identity unavailable');
  try {
    const command = `$nativeProcess = Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{processId=$nativeProcess.Id;peakWorkingSetBytes=$nativeProcess.PeakWorkingSet64;workingSetBytes=$nativeProcess.WorkingSet64;cpuMilliseconds=$nativeProcess.TotalProcessorTime.TotalMilliseconds} | ConvertTo-Json -Compress`;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000 });
    const result = JSON.parse(stdout);
    if (result.processId !== pid || !Number.isFinite(result.peakWorkingSetBytes) || result.peakWorkingSetBytes <= 0) throw new Error('native process counter mismatch');
    return { available: true, ...result };
  } catch { return { available: false, reason: 'read-only native process counters unavailable' }; }
}

export function learningTasks(seeds = [90001, 90002, 90003, 90004]) {
  if (!Array.isArray(seeds) || seeds.length !== 4 || new Set(seeds).size !== 4 || seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)) throw new Error('four distinct bounded fresh seeds required');
  return seeds.map((seed, index) => ({ id: `seed-${seed}`, seed, seatOrder: index % 2 ? [1, 0] : [0, 1] }));
}

export function evaluationTasks(mode = 'evaluate') {
  if (mode === 'evaluate') return [
    { id: 'seed-90005', seed: 90005, seatOrder: [0, 1], ordinaryPolicySeat: 'human' },
    { id: 'seed-90006', seed: 90006, seatOrder: [1, 0], ordinaryPolicySeat: 'opponent' },
  ];
  if (mode === 'evaluate-opponent') return [{ id: 'seed-90007', seed: 90007, seatOrder: [1, 0], ordinaryPolicySeat: 'opponent' }];
  throw new Error('unknown bounded native evaluation plan');
}

export async function generateLearningLane(config, tasks, directory, { maxCommands = 400, maxSeconds = 180, boundaryEvery = 1, decideOrdinary = null, onProgress = () => {}, signal = null, session = {}, retainSession = false } = {}) {
  const games = [];
  const cancel = () => session.worker?.close(new Error('native learning lane cancelled'));
  signal?.addEventListener('abort', cancel, { once: true });
  const laneStarted = performance.now();
  const jsCpuBefore = process.cpuUsage();
  let ordinaryDecisions = 0;
  try {
    for (const task of tasks) {
      if (signal?.aborted) throw new Error('native learning lane cancelled');
      const records = [];
      let modelDecisionCount = 0;
      let lastProgress = performance.now();
      const result = await runAuditedEpisode(config, { ...task, session, maxCommands, maxSeconds, boundaryEvery, strictCommands: true,
        decideOrdinary: decideOrdinary ? context => decideOrdinary({ ...context, task }) : null,
        measureProcess: measureNativeProcess,
        onFrame: ({ entry, privacyDivergence, useDivergence, divergence }) => {
          appendFileSync(join(directory, `${task.id}-progress.jsonl`), JSON.stringify({ entry, privacyDivergence, useDivergence, divergence }) + '\n');
          if (entry.revision === 0) onProgress({ task: task.id, started: true, nativeProcessId: session.worker.child.pid });
          if (performance.now() - lastProgress > 15000) { onProgress({ task: task.id, revision: entry.revision }); lastProgress = performance.now(); }
        },
        onAcceptedDecision: ({ seat, view, decision, ordinaryPolicyUsed }) => {
          if (ordinaryPolicyUsed) modelDecisionCount++;
          if (seat === 'human' && view.status === 'playing' && decision.actionId && !view.prompts.length && view.turn === 'you') records.push(encodeOrdinaryDecision(view, decision));
        } });
      if (!result.summary.completedNaturally || result.summary.rejected || (decideOrdinary ? !modelDecisionCount : !records.length)) throw new Error('native learning game did not pass acceptance gates');
      const privacyChecks = result.summary.boundaryChecks.filter(value => value.permutedSlots !== undefined);
      if (boundaryEvery !== 1 || !privacyChecks.length || !privacyChecks.some(value => value.opponentHandExchanged)) throw new Error('training slice requires hidden-world checks including a real hand exchange');
      save(join(directory, `${task.id}-journal.json`), result.journal);
      writeFileSync(join(directory, `${task.id}-records.jsonl`), records.map(value => JSON.stringify(value)).join('\n') + '\n', { flag: 'wx' });
      const cumulativeCpu = result.summary.processMetrics?.available ? result.summary.processMetrics.cpuMilliseconds : null;
      const nativeCpuMilliseconds = cumulativeCpu === null ? null : cumulativeCpu - (session.lastMeasuredCpu ?? 0);
      if (cumulativeCpu !== null) session.lastMeasuredCpu = cumulativeCpu;
      const game = { id: task.id, ...result.summary, boundaryChecks: undefined, privacyChecks: privacyChecks.length, nativeCpuMilliseconds,
        ordinaryPolicySeat: task.ordinaryPolicySeat ?? null, modelDecisionCount, ordinaryRecordSeat: 'human',
        realHandExchanges: privacyChecks.filter(value => value.opponentHandExchanged).length, ordinaryDecisions: records.length,
        trajectorySha256: hash(result.journal), recordsSha256: hash(records), featureContract: ordinaryFeatureContract };
      save(join(directory, `${task.id}-receipt.json`), game);
      games.push(game); ordinaryDecisions += records.length; onProgress({ task: task.id, completed: true, commands: game.commands, ordinaryDecisions: records.length, modelDecisionCount });
    }
    const elapsedMilliseconds = performance.now() - laneStarted;
    const jsCpu = process.cpuUsage(jsCpuBefore);
    return { schema: 'native-learning-lane/1', complete: true, elapsedMilliseconds, games, ordinaryDecisions,
      jsCpuMilliseconds: (jsCpu.user + jsCpu.system) / 1000,
      gamesPerSecond: games.length * 1000 / elapsedMilliseconds, transitionsPerSecond: games.reduce((sum, value) => sum + value.commands, 0) * 1000 / elapsedMilliseconds };
  } catch (error) {
    session.failed = true;
    appendFileSync(join(directory, 'failure.jsonl'), JSON.stringify({ message: error.message, code: error.code ?? null, completedGames: games.map(value => value.id) }) + '\n');
    throw error;
  } finally { signal?.removeEventListener('abort', cancel); if (!retainSession || signal?.aborted || session.failed) session.worker?.close(); }
}
