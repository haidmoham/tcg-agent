import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { benchmarkDeckOrder } from './benchmark.mjs';
import { LocalWorker, verifyLocalInputs } from './probe.mjs';
import { PolicyView } from './policy-view.mjs';
import { SemanticState, staticProgramIds, verifySeedTranscript } from './semantic-state.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = values => {
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const latency = values => {
  const ordered = [...values].sort((a, b) => a - b);
  return { count: ordered.length, medianMilliseconds: median(ordered), p95Milliseconds: ordered[Math.ceil(ordered.length * 0.95) - 1], minMilliseconds: ordered[0], maxMilliseconds: ordered.at(-1) };
};

export function validateWarmCases(config, cases, selected) {
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > 3) throw new TypeError('two or three fixed native workloads required');
  const ids = new Set(), workloads = new Set();
  return cases.map(({ id, journal }) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id ?? '') || ids.has(id)) throw new Error('distinct native workload identities required');
    ids.add(id);
    const header = journal?.header;
    if (header?.schema !== 'local-semantic-replay-v1' || header.normalization !== 'runtime-identity-minus-lastCheckedState/3'
        || !Number.isInteger(header.seed) || header.seed < 0 || header.seed > 0xffffffff
        || !Array.isArray(journal.commands) || journal.commands.length < 1 || journal.commands.length > 2000
        || !Array.isArray(journal.frames) || journal.frames.length !== journal.commands.length + 1) throw new Error('complete verified native journal required');
    for (const key of ['workerSha256', 'executableSha256', 'manifestSha256', 'policySha256']) {
      if (typeof config[key] !== 'string' || header[key] !== config[key]) throw new Error(`warm benchmark changes ${key}`);
    }
    if ((header.projectionCopyMode ?? 'native') !== (config.projectionCopyMode ?? 'native')) throw new Error('warm benchmark changes copy mode');
    const decks = benchmarkDeckOrder(selected, header);
    const workloadSha256 = digest({ seed: header.seed, decks: header.deckHashes, frames: journal.frames, commands: journal.commands });
    if (workloads.has(workloadSha256)) throw new Error('distinct representative workloads required');
    workloads.add(workloadSha256);
    return { id, journal, decks, workloadSha256 };
  });
}

function sessionInputs(config, cases, options) {
  const { maxSeconds = 180, totalSeconds = 900 } = options;
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 180
      || !Number.isSafeInteger(totalSeconds) || totalSeconds < 1 || totalSeconds > 900) throw new TypeError('bounded native session required');
  const inputs = verifyLocalInputs(config);
  if (config.offlineAuditVersion !== 'indigo-offline-audit/1') throw new Error('prepared original audit adapter required');
  const workloads = validateWarmCases(config, cases, inputs.selected);
  const identity = { id: inputs.manifest.bundleId, cardsHash: inputs.pins.get('cardData.json'), rulesHash: inputs.pins.get('gameData.json'), runtimeHash: inputs.pins.get('MatchLogic.dll') };
  const knownIds = staticProgramIds(...['cardData.json', 'gameData.json'].map(name => JSON.parse(readFileSync(join(inputs.root, name)))));
  return { ...inputs, identity, knownIds, workloads, maxSeconds, totalSeconds };
}

function createPayload(context, workload, verifyTurnPreflight = false) {
  const seats = Object.fromEntries(['human', 'opponent'].map((seat, index) => [seat, { accountId: `offline-${seat}`, name: `Offline ${seat}`, cards: workload.decks[index] }]));
  return { bundle: context.identity, seats, offline: { seed: workload.journal.header.seed, projectionCopyMode: context.copyMode, verifyTurnPreflight } };
}

function auditContract(audit, context, journal) {
  if (audit.schema !== 'indigo-offline-audit/1' || audit.seed !== journal.header.seed
      || audit.fixedClock !== '2026-10-11T00:00:00Z' || audit.readChanceAttempts !== 0
      || audit.projectionCopyMode !== context.copyMode) throw new Error('warm session RNG or read contract failed');
  verifySeedTranscript(journal.header.seed, audit.emittedSeeds);
}

function verifyTerminal(audit, context, journal) {
  auditContract(audit, context, journal);
  const expected = journal.frames.at(-1);
  if (audit.revision !== expected.revision || !isDeepStrictEqual(audit.emittedSeeds, expected.emittedSeeds)
      || new SemanticState(context.knownIds).hash(audit.authority) !== expected.snapshotHash) throw new Error('warm session terminal state diverged');
}

function describe(config, context) {
  return { timestamp: new Date().toISOString(), executionProfile: 'private-two-deck-2026-10-11', fullStandardClaim: false,
    node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length, concurrency: 1, workerSha256: config.workerSha256,
    executableSha256: config.executableSha256, manifestSha256: config.manifestSha256, policySha256: config.policySha256,
    projectionCopyMode: context.copyMode, buildConfiguration: config.buildConfiguration ?? 'Debug', maxSecondsPerGame: context.maxSeconds, totalBudgetSeconds: context.totalSeconds,
    workloads: context.workloads.map(({ id, journal, workloadSha256 }) => ({ id, seed: journal.header.seed,
      deckHashes: journal.header.deckHashes, commands: journal.commands.length, frames: journal.frames.length, workloadSha256 })) };
}

export async function benchmarkNativeWarm(config, cases, { repeats = 3, warmups = 1, maxSeconds = 180, totalSeconds = 900, onGame = () => {} } = {}) {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5 || !Number.isSafeInteger(warmups) || warmups < 1 || warmups > 2) throw new TypeError('one or two warm-up games and one through five repetitions required');
  const context = sessionInputs(config, cases, { maxSeconds, totalSeconds });
  const sessionStarted = performance.now(), worker = new LocalWorker(config, { timeoutMs: maxSeconds * 1000 });
  const sessionBudget = setTimeout(() => worker.close(new Error('warm benchmark session budget exhausted')), totalSeconds * 1000);
  const runs = [], warmupRuns = [];
  const schedule = [
    ...Array.from({ length: warmups }, (_, round) => ({ workload: context.workloads[round % context.workloads.length], stage: 'warmup', round: round + 1 })),
    ...Array.from({ length: repeats }, (_, round) => context.workloads.map(workload => ({ workload, stage: 'measured', round: round + 1 }))).flat(),
  ];
  let first = true;
  try {
    for (const { workload, stage, round } of schedule) {
      const gameBudget = setTimeout(() => worker.close(new Error('warm benchmark game budget exhausted')), maxSeconds * 1000);
      try {
        const started = first ? sessionStarted : performance.now();
        await (first ? worker.request('create', createPayload(context, workload)) : worker.nextMatch(createPayload(context, workload)));
        const resetMilliseconds = performance.now() - started;
        const batch = await worker.request('offline-batch', { commands: workload.journal.commands });
        const elapsedMilliseconds = performance.now() - started;
        const verificationStarted = performance.now();
        if (!batch.terminal || batch.commands !== workload.journal.commands.length
            || batch.revision !== workload.journal.frames.at(-1).revision || batch.projectionCopyMode !== context.copyMode) throw new Error('warm benchmark did not complete the fixed workload');
        verifyTerminal(await worker.request('audit', {}), context, workload.journal);
        const run = { id: workload.id, round, stage, cold: first,
          games: 1, commands: batch.commands, elapsedMilliseconds, resetMilliseconds,
          batchMilliseconds: batch.batchMilliseconds, verificationMilliseconds: performance.now() - verificationStarted,
          gamesPerSecond: 1000 / elapsedMilliseconds, commandsPerSecond: batch.commands * 1000 / elapsedMilliseconds,
          nativeSeedCalls: batch.nativeSeedCalls, terminalStateHash: workload.journal.frames.at(-1).snapshotHash, errors: 0, truncations: 0 };
        for (const key of ['readCopyCalls', 'readCopyMilliseconds', 'snapshotHits', 'serializationCalls', 'serializationMilliseconds', 'deserializationCalls', 'deserializationMilliseconds', 'commandLatencyMilliseconds', 'managedCurrentThreadAllocatedBytes', 'gcCollections']) {
          if (batch[key] !== undefined) run[key] = batch[key];
        }
        (stage === 'warmup' ? warmupRuns : runs).push(run);
        first = false; onGame(run);
      } finally { clearTimeout(gameBudget); }
    }
    const sessionMilliseconds = performance.now() - sessionStarted;
    const timedMilliseconds = runs.reduce((sum, run) => sum + run.elapsedMilliseconds, 0);
    const summarize = values => ({ games: values.length, commands: values.reduce((sum, run) => sum + run.commands, 0),
      latency: latency(values.map(run => run.elapsedMilliseconds)),
      medianGamesPerSecond: median(values.map(run => run.gamesPerSecond)),
      resetLatency: latency(values.map(run => run.resetMilliseconds)), batchLatency: latency(values.map(run => run.batchMilliseconds)) });
    return { schema: 'native-warm-benchmark-v1', ...describe(config, context), repeats, warmups, complete: true, errors: 0, truncations: 0,
      includes: 'every timed game includes fresh worker-object reset, fresh seeded setup, all recorded commands, native legal enumeration and compact projections; one retained process and pinned program bundle',
      excludes: 'timed warm aggregate excludes startup, verified warm-up games and terminal audit verification; worker session time includes these. No policy inference, previews, GUI or disk writes run inside this harness; optional presentation details are disabled during batch',
      limitation: 'terminal state and seed verification per timed game; run warm proof separately for every-frame and both-player observation equivalence across reset; no broad Standard cache-safety claim',
      sessionMilliseconds, sessionGames: runs.length + warmupRuns.length, sessionGamesPerSecond: (runs.length + warmupRuns.length) * 1000 / sessionMilliseconds,
      coldGameMilliseconds: warmupRuns[0].elapsedMilliseconds, timedMilliseconds, warmGamesPerSecond: runs.length * 1000 / timedMilliseconds,
      ...summarize(runs), byWorkload: context.workloads.map(workload => ({ id: workload.id, ...summarize(runs.filter(run => run.id === workload.id)) })), warmupRuns, runs };
  } finally { clearTimeout(sessionBudget); worker.close(); }
}

export async function proveNativeWarm(config, cases, { maxSeconds = 180, totalSeconds = 900, onGame = () => {} } = {}) {
  const context = sessionInputs(config, cases, { maxSeconds, totalSeconds });
  const started = performance.now(), worker = new LocalWorker(config, { timeoutMs: maxSeconds * 1000 });
  const budget = setTimeout(() => worker.close(new Error('warm proof session budget exhausted')), totalSeconds * 1000);
  const runs = [];
  try {
    for (const workload of [...context.workloads, context.workloads[0]]) {
      const gameBudget = setTimeout(() => worker.close(new Error('warm proof game budget exhausted')), maxSeconds * 1000);
      try {
        const gameStarted = performance.now(), journal = workload.journal, state = new SemanticState(context.knownIds);
        const projectors = { human: new PolicyView(), opponent: new PolicyView() }, commandLatencies = [];
        let frame = await (runs.length === 0 ? worker.request('create', createPayload(context, workload, true)) : worker.nextMatch(createPayload(context, workload, true)));
        for (let index = 0; index < journal.frames.length; index++) {
          const audit = await worker.request('audit', {});
          auditContract(audit, context, journal);
          const actorViews = Object.fromEntries(['human', 'opponent'].map(seat => [seat, projectors[seat].project(frame.views[seat])]));
          const entry = { revision: frame.revision, stateHash: digest(state.normalize(audit.authority)), snapshotHash: new SemanticState(context.knownIds).hash(audit.authority),
            actorHashes: Object.fromEntries(Object.entries(actorViews).map(([seat, view]) => [seat, digest(view)])), emittedSeeds: audit.emittedSeeds };
          if (!isDeepStrictEqual(entry, journal.frames[index])) throw new Error(`warm reset proof diverged in ${workload.id} at revision ${frame.revision}`);
          if (index === journal.commands.length) {
            if (!frame.terminal) throw new Error('warm reset proof did not end naturally');
            verifyTerminal(audit, context, journal); break;
          }
          if (frame.terminal) throw new Error('warm reset proof left recorded commands unused');
          const recorded = journal.commands[index];
          if (!projectors[recorded.seat]) throw new Error('invalid recorded seat');
          const decision = projectors[recorded.seat].resolve(recorded.decision);
          if (decision.promptId) {
            const preview = await worker.request('preview', { seat: recorded.seat, selection: { ...decision, requestId: randomUUID(), expectedRevision: frame.revision } });
            if (preview.valid !== true) throw new Error('warm reset proof selection no longer validates');
          }
          for (const seat of ['human', 'opponent']) if (!isDeepStrictEqual(await worker.request('view', { seat }), frame.views[seat])) throw new Error('warm cached observation changed');
          if (!isDeepStrictEqual(await worker.request('audit', {}), audit)) throw new Error('warm proof read mutated authority or RNG');
          const commandStarted = performance.now();
          const result = await worker.request('command', { seat: recorded.seat, command: { ...decision, commandId: randomUUID(), expectedRevision: frame.revision } });
          commandLatencies.push(performance.now() - commandStarted);
          if (result.receipt?.status !== 'accepted' || result.frame?.revision !== frame.revision + 1) throw new Error('warm reset proof command rejected');
          frame = result.frame;
        }
        const run = { id: workload.id, sequence: runs.length + 1, reset: runs.length > 0, commands: journal.commands.length,
          frames: journal.frames.length, nativeSeedCalls: journal.frames.at(-1).emittedSeeds.length,
          terminalStateHash: journal.frames.at(-1).snapshotHash, elapsedMilliseconds: performance.now() - gameStarted,
          commandLatency: latency(commandLatencies), errors: 0, truncations: 0 };
        runs.push(run); onGame(run);
      } finally { clearTimeout(gameBudget); }
    }
    return { schema: 'native-warm-proof-v1', ...describe(config, context), complete: true, errors: 0, truncations: 0,
      sequence: 'all fixed cases in order, then first case again; fresh worker object, policy aliases and state normalizer per game',
      verification: 'all normalized authority frames, both actor observation hashes, every emitted seed, extra cached reads and preview immutability; same fixed commands and natural terminal state',
      limitation: 'finite pinned two-deck traces only; does not certify all native global state or full Standard behavior; command latencies include full presentation and IPC and are diagnostic, not batch throughput',
      sessionMilliseconds: performance.now() - started, runs };
  } finally { clearTimeout(budget); worker.close(); }
}
