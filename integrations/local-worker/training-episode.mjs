import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LocalWorker, verifyLocalInputs } from './probe.mjs';
import { PolicyView } from './policy-view.mjs';
import { SemanticState, staticProgramIds, verifySeedTranscript } from './semantic-state.mjs';

const auditMode = 'sampled-native-training/1';
const seats = ['human', 'opponent'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message, code) => Object.assign(new Error(message), { code });

async function closeAndReap(worker) {
  const child = worker.child;
  worker.close();
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', exited);
      reject(failure('native worker did not exit after close', 'NATIVE_WORKER_REAP_FAILED'));
    }, 5000);
    function exited() { clearTimeout(timer); resolve(); }
    child.once('exit', exited);
  });
}

export async function runTrainingEpisode(config, {
  seed = 1729, seatOrder = [0, 1], maxCommands = 1000, maxSeconds = 120,
  auditEvery = 32, onFrame = () => {}, session = null,
  decideOrdinary = null, decidePrompt = null, onAcceptedDecision = () => {},
  measureProcess = null, signal = null, replay = null, extraReads = 0,
} = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isSafeInteger(maxCommands) || maxCommands < 1 || maxCommands > 2000 || !Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 360) throw new TypeError('invalid training episode budget');
  if (!Number.isSafeInteger(auditEvery) || auditEvery < 1 || auditEvery > 1000) throw new TypeError('invalid training audit cadence');
  if (![[0, 1], [1, 0]].some(value => isDeepStrictEqual(value, seatOrder))) throw new TypeError('two exact decks must swap seats together');
  if (replay || extraReads !== 0) throw new TypeError('use the full audited runner for replay or extra reads');
  if (signal?.aborted) throw failure('training episode cancelled', 'NATIVE_TRAINING_CANCELLED');
  if (session && (session.failed || session.busy)) throw new Error('native session is failed or already busy');
  const inputs = verifyLocalInputs(config);
  if (config.offlineAuditVersion !== 'indigo-offline-audit/1' || !inputs.decisions) throw new Error('prepared audit worker and pinned local strategy required');
  if (session?.config && !isDeepStrictEqual(session.config, config)) throw new Error('native session configuration changed');
  const policy = (await import(pathToFileURL(inputs.decisions))).livePracticeDecisions;
  const programs = ['cardData.json', 'gameData.json'].map(name => JSON.parse(readFileSync(join(inputs.root, name))));
  const knownIds = staticProgramIds(...programs);
  const selected = seatOrder.map(index => inputs.selected[index]);
  const projectors = Object.fromEntries(seats.map(seat => [seat, new PolicyView()]));
  const identity = { id: inputs.manifest.bundleId, cardsHash: inputs.pins.get('cardData.json'), rulesHash: inputs.pins.get('gameData.json'), runtimeHash: inputs.pins.get('MatchLogic.dll') };
  const header = { schema: 'local-semantic-replay-v1', seed, normalization: 'runtime-identity-minus-lastCheckedState/3', manifestSha256: config.manifestSha256, workerSha256: config.workerSha256, executableSha256: config.executableSha256, policySha256: config.policySha256, deckHashes: selected.map(digest) };
  if (config.projectionCopyMode !== undefined) header.projectionCopyMode = inputs.copyMode;
  const journal = { header, auditMode, frames: [], commands: [], emittedSeeds: null };
  const boundaryChecks = [];
  const sampledRevisions = [];
  const worker = session?.worker ?? new LocalWorker(config, { timeoutMs: maxSeconds * 1000 });
  if (session) { session.worker = worker; session.config = structuredClone(config); session.busy = true; }
  const start = performance.now();
  let stopped = null;
  let stop;
  const interruption = new Promise((_, reject) => { stop = reject; });
  // A callback may ignore cancellation; racing it keeps the episode budget strict.
  const bounded = operation => Promise.race([Promise.resolve().then(() => {
    if (stopped) throw stopped;
    return operation();
  }), interruption]);
  const interrupt = error => { if (!stopped) { stopped = error; stop(error); worker.close(error); } };
  const cancel = () => interrupt(failure('training episode cancelled', 'NATIVE_TRAINING_CANCELLED'));
  const budget = setTimeout(() => interrupt(failure('training episode time budget exhausted', 'NATIVE_EPISODE_TIME_BUDGET')), maxSeconds * 1000);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let completed = false;
  let previews = 0;
  let privacyChecks = 0;
  let opponentHandExchanges = 0;
  let terminalAudit;
  try {
    const seatInputs = Object.fromEntries(seats.map((seat, index) => [seat, { accountId: `offline-${seat}`, name: `Offline ${seat}`, cards: selected[index] }]));
    const payload = { bundle: identity, seats: seatInputs, offline: { seed, projectionCopyMode: inputs.copyMode } };
    const reusedProcess = session?.initialized === true;
    let frame = await bounded(() => reusedProcess ? worker.nextMatch(payload) : worker.request('create', payload));
    const startupOrResetMilliseconds = performance.now() - start;
    for (;;) {
      let audit = null;
      if (journal.frames.length === 0 || frame.revision % auditEvery === 0 || frame.terminal) {
        audit = await bounded(() => worker.request('audit', {}));
        if (audit.schema !== 'indigo-offline-audit/1' || audit.seed !== seed || audit.fixedClock !== '2026-10-11T00:00:00Z' || audit.readChanceAttempts !== 0) throw new Error('offline RNG/read contract failed');
        if (config.projectionCopyMode !== undefined && audit.projectionCopyMode !== inputs.copyMode) throw new Error('offline copy mode not honored');
        verifySeedTranscript(seed, audit.emittedSeeds);
        sampledRevisions.push(frame.revision);
      }
      const actorViews = Object.fromEntries(seats.map(seat => [seat, projectors[seat].project(frame.views[seat])]));
      if (Object.values(actorViews).some(view => view.status === 'failed' || view.prompts.some(prompt => prompt.kind === 'unsupported'))) throw new Error('training slice contains an unsupported native decision');
      const entry = { revision: frame.revision, actorHashes: Object.fromEntries(seats.map(seat => [seat, digest(actorViews[seat])])) };
      if (audit) entry.nativeSeedCalls = audit.emittedSeeds.length;
      if (frame.terminal) { terminalAudit = audit; entry.snapshotHash = new SemanticState(knownIds).hash(audit.authority); }
      journal.frames.push(entry);
      await bounded(() => onFrame({ entry, frame, divergence: false }));
      if (audit && !frame.terminal) {
        for (const seat of seats) {
          const variant = await bounded(() => worker.request('audit-privacy', { seat }));
          privacyChecks++;
          if (variant.opponentHandExchanged) opponentHandExchanges++;
          if (!isDeepStrictEqual(new PolicyView().project(frame.views[seat]), new PolicyView().project(variant.view))) throw new Error(`player observation changed under hidden permutation at revision ${frame.revision}`);
          boundaryChecks.push({ revision: frame.revision, seat, permutedSlots: variant.permutedSlots, opponentHandExchanged: variant.opponentHandExchanged });
        }
        const use = await bounded(() => worker.request('audit-use', {}));
        if (use.checked && (use.missing.length || use.extra.length)) throw new Error(`native Use action audit disagreed at revision ${frame.revision}`);
        boundaryChecks.push({ revision: frame.revision, useAudit: use });
      }
      if (frame.terminal) break;
      if (journal.commands.length >= maxCommands) throw failure('training episode command budget exhausted', 'NATIVE_EPISODE_COMMAND_BUDGET');
      let next;
      for (const seat of seats) {
        const view = actorViews[seat];
        const offered = policy(view);
        const learned = decideOrdinary && view.status === 'playing' && !view.prompts.length && view.actions.length && view.turn === 'you'
          ? await bounded(() => decideOrdinary({ seat, view })) : null;
        const validate = async decision => {
          const native = projectors[seat].resolve(decision);
          if (!native.promptId) throw new Error('prompt validator requires a current prompt answer');
          previews++;
          return (await bounded(() => worker.request('preview', { seat, selection: { ...native, requestId: randomUUID(), expectedRevision: frame.revision } }))).valid === true;
        };
        const learnedPrompt = decidePrompt && view.prompts.length ? await bounded(() => decidePrompt({ seat, view, validate })) : null;
        const decisions = learnedPrompt ?? (learned === null ? offered : [learned]);
        let examined = 0;
        for (const decision of decisions) {
          if (++examined > 128) throw new Error('strategy candidate budget exhausted');
          const native = projectors[seat].resolve(decision);
          if (native.promptId && !await validate(decision)) continue;
          if (audit) {
            const afterRead = await bounded(() => worker.request('audit', {}));
            if (!isDeepStrictEqual(afterRead, audit)) throw new Error('read or preview mutated authority or RNG');
          }
          const reply = await bounded(() => worker.request('command', { seat, command: { ...native, commandId: randomUUID(), expectedRevision: frame.revision } }));
          if (reply.receipt?.status !== 'accepted') throw new Error('native command rejected');
          if (reply.frame?.revision !== frame.revision + 1) throw new Error('native revision did not advance once');
          await bounded(() => onAcceptedDecision({ seat, view, decision: structuredClone(decision), ordinaryPolicyUsed: learned !== null, promptPolicyUsed: learnedPrompt !== null }));
          next = reply.frame;
          journal.commands.push({ seat, decision: structuredClone(decision) });
          break;
        }
        if (next) break;
      }
      if (!next) throw new Error('no supported policy candidate advances native state');
      frame = next;
    }
    const processMetrics = measureProcess ? await bounded(() => measureProcess(worker.child.pid)) : null;
    journal.emittedSeeds = terminalAudit.emittedSeeds;
    const elapsedMs = performance.now() - start;
    completed = true;
    if (session) session.initialized = true;
    return { journal, summary: { schema: 'training-native-episode-v1', auditMode, completedNaturally: true, seed, seatOrder, winnerSeat: frame.terminal.winner, turns: frame.views.human.turnNumber, terminalStateHash: journal.frames.at(-1).snapshotHash, commands: journal.commands.length, frames: journal.frames.length, previews, rejected: 0, boundaryChecks, privacyChecks, opponentHandExchanges, sampledRevisions, nativeSeedCalls: terminalAudit.emittedSeeds.length, elapsedMs, startupOrResetMilliseconds, reusedProcess, processMetrics, replayVerified: false, fullStandardClaim: false } };
  } finally {
    clearTimeout(budget);
    signal?.removeEventListener('abort', cancel);
    if (session) { session.busy = false; if (!completed) session.failed = true; }
    if (!session || !completed) await closeAndReap(worker);
  }
}
