import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LocalWorker, verifyLocalInputs } from './probe.mjs';
import { PolicyView } from './policy-view.mjs';
import { SemanticState, staticProgramIds, verifySeedTranscript } from './semantic-state.mjs';
import { collectLegalAnswers } from './decision-domain.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runAuditedEpisode(config, { seed = 1729, replay = null, extraReads = 0, boundaryEvery = 0, seatOrder = [0, 1], maxCommands = 1000, maxSeconds = 120, onFrame = () => {}, session = null, decideOrdinary = null, onAcceptedDecision = () => {}, strictCommands = false, measureProcess = null } = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isSafeInteger(maxCommands) || maxCommands < 1 || maxCommands > 2000 || !Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 180 || !Number.isSafeInteger(extraReads) || extraReads < 0 || extraReads > 4) throw new TypeError('invalid audited episode budget');
  if (!Number.isSafeInteger(boundaryEvery) || boundaryEvery < 0 || boundaryEvery > 1000) throw new TypeError('invalid boundary audit cadence');
  if (replay && decideOrdinary) throw new TypeError('recorded replay cannot use a learned policy');
  if (session && (session.failed || session.busy)) throw new Error('native session is failed or already busy');
  const inputs = verifyLocalInputs(config);
  if (!Array.isArray(seatOrder) || seatOrder.length !== 2 || ![[0, 1], [1, 0]].some(value => isDeepStrictEqual(value, seatOrder))) throw new TypeError('two exact decks must swap seats together');
  const selected = seatOrder.map(index => inputs.selected[index]);
  if (config.offlineAuditVersion !== 'indigo-offline-audit/1' || !inputs.decisions) throw new Error('prepared audit worker and pinned local strategy required');
  const policy = (await import(pathToFileURL(inputs.decisions))).livePracticeDecisions;
  const programs = ['cardData.json', 'gameData.json'].map(name => JSON.parse(readFileSync(join(inputs.root, name))));
  const knownIds = staticProgramIds(...programs);
  const state = new SemanticState(knownIds);
  const projectors = { human: new PolicyView(), opponent: new PolicyView() };
  const identity = { id: inputs.manifest.bundleId, cardsHash: inputs.pins.get('cardData.json'), rulesHash: inputs.pins.get('gameData.json'), runtimeHash: inputs.pins.get('MatchLogic.dll') };
  const header = { schema: 'local-semantic-replay-v1', seed, normalization: 'runtime-identity-minus-lastCheckedState/3', manifestSha256: config.manifestSha256, workerSha256: config.workerSha256, executableSha256: config.executableSha256, policySha256: config.policySha256, deckHashes: selected.map(digest) };
  if (config.projectionCopyMode !== undefined) header.projectionCopyMode = inputs.copyMode;
  if (replay && !isDeepStrictEqual(replay.header, header)) throw new Error('replay pins or seed mismatch');
  const journal = { header, frames: [], commands: [] };
  const boundaryChecks = [];
  if (session?.config && !isDeepStrictEqual(session.config, config)) throw new Error('native session configuration changed');
  const worker = session?.worker ?? new LocalWorker(config, { timeoutMs: maxSeconds * 1000 });
  if (session) { session.worker = worker; session.config = structuredClone(config); session.busy = true; }
  const start = performance.now();
  const budget = setTimeout(() => worker.close(Object.assign(new Error('audited episode time budget exhausted'), { code: 'NATIVE_EPISODE_TIME_BUDGET' })), maxSeconds * 1000);
  let previews = 0; let rejected = 0;
  let completed = false;
  try {
    const seats = Object.fromEntries(['human', 'opponent'].map((seat, index) => [seat, { accountId: `offline-${seat}`, name: `Offline ${seat}`, cards: selected[index] }]));
    const payload = { bundle: identity, seats, offline: { seed, projectionCopyMode: inputs.copyMode } };
    const reusedProcess = session?.initialized === true;
    let frame = await (reusedProcess ? worker.nextMatch(payload) : worker.request('create', payload));
    const startupOrResetMilliseconds = performance.now() - start;
    for (;;) {
      const audit = await worker.request('audit', {});
      if (audit.schema !== 'indigo-offline-audit/1' || audit.seed !== seed || audit.fixedClock !== '2026-10-11T00:00:00Z' || audit.readChanceAttempts !== 0) throw new Error('offline RNG/read contract failed');
      if (config.projectionCopyMode !== undefined && audit.projectionCopyMode !== inputs.copyMode) throw new Error('offline copy mode not honored');
      verifySeedTranscript(seed, audit.emittedSeeds);
      const normalized = state.normalize(audit.authority);
      const actorViews = Object.fromEntries(['human', 'opponent'].map(seat => [seat, projectors[seat].project(frame.views[seat])]));
      if (strictCommands && Object.values(actorViews).some(view => view.status === 'failed' || view.prompts.some(prompt => prompt.kind === 'unsupported'))) throw new Error('training slice contains an unsupported native decision');
      const entry = { revision: frame.revision, stateHash: digest(normalized), snapshotHash: new SemanticState(knownIds).hash(audit.authority), actorHashes: Object.fromEntries(Object.entries(actorViews).map(([seat, view]) => [seat, digest(view)])), emittedSeeds: audit.emittedSeeds };
      if (replay && !isDeepStrictEqual(replay.frames[journal.frames.length], entry)) {
        onFrame({ entry, normalized, frame, divergence: true });
        throw new Error(`semantic replay diverged at revision ${frame.revision}`);
      }
      journal.frames.push(entry); onFrame({ entry, normalized, frame, divergence: false });
      if (boundaryEvery > 0 && frame.revision % boundaryEvery === 0 && !frame.terminal) {
        for (const seat of ['human', 'opponent']) {
          const variant = await worker.request('audit-privacy', { seat });
          const baselineView = new PolicyView().project(frame.views[seat]);
          const variantView = new PolicyView().project(variant.view);
          if (!isDeepStrictEqual(baselineView, variantView)) {
            onFrame({ entry, normalized, frame, privacyDivergence: { seat, baselineView, variantView } });
            throw new Error(`player observation changed under hidden permutation at revision ${frame.revision}`);
          }
          boundaryChecks.push({ revision: frame.revision, seat, permutedSlots: variant.permutedSlots, opponentHandExchanged: variant.opponentHandExchanged });
          const prompt = frame.views[seat].prompts[0];
          if (prompt && prompt.choices.length <= 8 && prompt.kind !== 'allocation') {
            try {
              const domain = await collectLegalAnswers(prompt, async answer => (await worker.request('preview', { seat, selection: { ...answer, requestId: randomUUID(), expectedRevision: frame.revision } })).valid === true, { maxCandidates: 256 });
              boundaryChecks.push({ revision: frame.revision, seat, decisionDomain: { kind: prompt.kind, checked: domain.checked, legalAnswers: domain.answers.length, complete: domain.complete } });
            } catch (error) {
              if (error.code !== 'DECISION_DOMAIN_BUDGET_EXCEEDED') throw error;
              boundaryChecks.push({ revision: frame.revision, seat, decisionDomain: { complete: false, unsupported: error.code } });
            }
          }
        }
        const use = await worker.request('audit-use', {});
        if (use.checked && (use.missing.length || use.extra.length)) {
          onFrame({ entry, normalized, frame, useDivergence: { ...use, missing: use.missing.map(value => value.split('/').map(part => state.token(part)).join('/')), extra: use.extra.map(value => value.split('/').map(part => state.token(part)).join('/')) } });
          throw new Error(`native Use action audit disagreed at revision ${frame.revision}`);
        }
        boundaryChecks.push({ revision: frame.revision, useAudit: use });
      }
      for (let index = 0; index < extraReads; index++) {
        for (const seat of ['human', 'opponent']) if (!isDeepStrictEqual(await worker.request('view', { seat }), frame.views[seat])) throw new Error('cached seat read changed');
      }
      if (frame.terminal) break;
      if (journal.commands.length >= maxCommands) throw Object.assign(new Error('audited episode command budget exhausted'), { code: 'NATIVE_EPISODE_COMMAND_BUDGET' });
      let next;
      const expected = replay?.commands[journal.commands.length];
      if (replay && !expected) throw new Error('replay command transcript exhausted');
      const candidates = expected ? [[expected.seat, [expected.decision]]] : ['human', 'opponent'].map(seat => [seat, policy(actorViews[seat])]);
      for (const [seat, offered] of candidates) {
        if (!projectors[seat]) throw new Error('invalid recorded seat');
        const view = actorViews[seat];
        const learned = decideOrdinary && view.status === 'playing' && !view.prompts.length && view.actions.length && view.turn === 'you'
          ? await decideOrdinary({ seat, view }) : null;
        const decisions = learned === null ? offered : [learned];
        let examined = 0;
        for (const decision of decisions) {
          if (++examined > 128) throw new Error('strategy candidate budget exhausted');
          const native = projectors[seat].resolve(decision);
          if (native.promptId) {
            previews++;
            const answer = await worker.request('preview', { seat, selection: { ...native, requestId: randomUUID(), expectedRevision: frame.revision } });
            if (!answer.valid) { if (expected) throw new Error('recorded decision no longer validates'); continue; }
          }
          const afterRead = await worker.request('audit', {});
          if (!isDeepStrictEqual(afterRead, audit)) throw new Error('read or preview mutated authority or RNG');
          const reply = await worker.request('command', { seat, command: { ...native, commandId: randomUUID(), expectedRevision: frame.revision } });
          if (reply.receipt?.status !== 'accepted') { rejected++; if (expected || strictCommands) throw new Error('native command rejected'); continue; }
          if (reply.frame?.revision !== frame.revision + 1) throw new Error('native revision did not advance once');
          await onAcceptedDecision({ seat, view, decision: structuredClone(decision), ordinaryPolicyUsed: learned !== null });
          next = reply.frame; journal.commands.push({ seat, decision: structuredClone(decision) }); break;
        }
        if (next) break;
      }
      if (!next) throw new Error('no supported policy candidate advances native state');
      frame = next;
    }
    if (replay && (journal.commands.length !== replay.commands.length || journal.frames.length !== replay.frames.length)) throw new Error('replay left commands or frames unused');
    const elapsedMs = performance.now() - start;
    const processMetrics = measureProcess ? await measureProcess(worker.child.pid) : null;
    completed = true;
    if (session) session.initialized = true;
    return { journal, summary: { schema: 'audited-native-episode-v1', completedNaturally: true, seed, seatOrder, winnerSeat: frame.terminal.winner, turns: frame.views.human.turnNumber, terminalStateHash: journal.frames.at(-1).snapshotHash, commands: journal.commands.length, frames: journal.frames.length, previews, rejected, boundaryChecks, nativeSeedCalls: journal.frames.at(-1).emittedSeeds.length, elapsedMs, startupOrResetMilliseconds, reusedProcess, processMetrics, replayVerified: replay !== null, fullStandardClaim: false } };
  } finally {
    clearTimeout(budget);
    if (session) { session.busy = false; if (!completed) session.failed = true; }
    if (!session || !completed) worker.close();
  }
}
