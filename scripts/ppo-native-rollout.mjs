import { appendFileSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runTrainingEpisode } from '../integrations/local-worker/training-episode.mjs';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';
import { measureNativeProcess } from '../integrations/local-worker/learning-rollout.mjs';
import { CardActionModelClient } from '../integrations/local-worker/card-action-model.mjs';
import { PpoModelClient, validatePpoActions } from '../integrations/local-worker/ppo-model.mjs';
import { supportsCardSelection, rankedPromptAnswers, weakOrdinaryDecision, cardActionDiagnostics } from '../integrations/local-worker/card-action-policy.mjs';
import { cardActionFeatureContract, encodeCardActionDecision } from '../learning/card-action-features.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sources = ['scripts/ppo-native-rollout.mjs', 'integrations/local-worker/ppo-model.mjs', 'learning/ppo_runtime.py', 'learning/masked_ppo.py',
  'learning/card_action_torch.py', 'learning/card-action-features.mjs', 'integrations/local-worker/training-episode.mjs',
  'integrations/local-worker/card-action-policy.mjs', 'integrations/local-worker/card-action-model.mjs',
  'integrations/local-worker/probe.mjs', 'integrations/local-worker/policy-view.mjs', 'integrations/local-worker/semantic-state.mjs',
  'integrations/local-worker/learning-rollout.mjs', 'integrations/local-worker/learning-features.mjs', 'learning/model-three-plan.json'];
const sourceHashes = () => Object.fromEntries(sources.map(path => [path, hash(readFileSync(join(root, path)))]));
const budgetCodes = new Set(['NATIVE_EPISODE_TIME_BUDGET', 'NATIVE_EPISODE_COMMAND_BUDGET']);

export function admitPpoRolloutPlan(plan) {
  if (plan?.schema !== 'native-ppo-rollout-plan/1' || typeof plan.ppoConfig !== 'string' || typeof plan.selectionConfig !== 'string'
      || !Number.isInteger(plan.workers) || plan.workers < 1 || plan.workers > 4
      || !Number.isInteger(plan.maximumWallSeconds) || plan.maximumWallSeconds < 1 || plan.maximumWallSeconds > 3600
      || !Number.isInteger(plan.maximumGameSeconds) || plan.maximumGameSeconds < 1 || plan.maximumGameSeconds > 360
      || !Number.isInteger(plan.maximumGameCommands) || plan.maximumGameCommands < 1 || plan.maximumGameCommands > 500
      || !Number.isInteger(plan.auditEvery ?? 32) || (plan.auditEvery ?? 32) < 1 || (plan.auditEvery ?? 32) > 1000
      || !['teacher', 'weak'].includes(plan.opponentPolicy ?? 'teacher') || ['teacherMix', 'epsilon', 'temperature'].some(key => Object.hasOwn(plan, key))
      || !Number.isSafeInteger(plan.seed ?? 1729) || (plan.seed ?? 1729) < 0 || (plan.seed ?? 1729) > 0xffffffff
      || (Object.hasOwn(plan, 'deterministic') && plan.deterministic !== false)
      || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 64) throw new Error('bounded on-policy PPO collection plan required');
  const ids = new Set(), seeds = new Set();
  for (const task of plan.tasks) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(task.id ?? '') || ids.has(task.id) || !Number.isSafeInteger(task.seed)
        || task.seed < 0 || task.seed > 0xffffffff || seeds.has(task.seed)
        || (task.seed >= 94301 && task.seed <= 94304) || (task.seed >= 94401 && task.seed <= 94404)
        || !['human', 'opponent'].includes(task.policySeat) || ![[0, 1], [1, 0]].some(value => isDeepStrictEqual(value, task.seatOrder))
        || task.seatOrder[task.policySeat === 'human' ? 0 : 1] !== 0) throw new Error('unique fresh training seeds and AgentPult policy seat required');
    ids.add(task.id); seeds.add(task.seed);
  }
  return plan;
}

export function encodePpoBootstrapState(view, printingAliases = {}) {
  if (view?.status !== 'playing') throw new Error('actual playing actor-visible state required for bootstrap');
  const state = encodeCardActionDecision({ ...view, turn: 'you', prompts: [], actions: [{ id: 'critic-only-state', kind: 'pass' }] }, null, { printingAliases }).state;
  state[0] = Number(view.turn === 'you'); return state;
}

export class PpoEpisodeBuffer {
  constructor(episodeId) { this.episodeId = episodeId; this.records = []; this.closed = false; }
  accept(encoded, action, metadata = {}) {
    if (this.closed) throw new Error('PPO episode boundary is already closed');
    const [sample] = validatePpoActions([encoded], [action]);
    const previous = this.records.at(-1);
    if (previous) previous.nextValue = sample.oldValue;
    const record = { ...encoded, ...metadata, kind: 'ordinary', ...sample, reward: 0, terminated: false, truncated: false,
      nextValue: null, episodeId: this.episodeId, stepIndex: this.records.length, segmentEnd: false };
    this.records.push(record); return record;
  }
  finish({ terminated, nextValue, result = null }) {
    if (this.closed || !this.records.length || typeof terminated !== 'boolean' || !Number.isFinite(nextValue)
        || (terminated && !['win', 'loss', 'draw'].includes(result)) || (!terminated && result !== null)) throw new Error('explicit PPO episode outcome/bootstrap boundary required');
    const last = this.records.at(-1);
    Object.assign(last, { reward: terminated ? result === 'win' ? 1 : result === 'loss' ? -1 : 0 : 0,
      terminated, truncated: !terminated, nextValue: terminated ? 0 : nextValue, segmentEnd: true });
    this.closed = true; return this.records;
  }
}

export async function collectPpoEpisode(config, task, { ppo, selection, session = {}, opponentPolicy = 'teacher', opponent = null,
  printingAliases = {}, maxSeconds = 240, maxCommands = 500, auditEvery = 32, signal = null, onProgress = () => {},
  runEpisode = runTrainingEpisode, diagnostics = {} } = {}) {
  const episodeId = `${task.id}/${task.policySeat}`, buffer = new PpoEpisodeBuffer(episodeId), projector = new PolicyView();
  let lastActorView = null, lastRevision = -1, requiredRevision = -1, commandInFlight = false, currentSample = null;
  let selectionDecisions = 0, helperDecisions = 0, acceptedPpoDecisions = 0;
  const sampledRevisions = [], actorEvents = [];
  const auditEvidence = () => ({ auditMode: 'sampled-native-training/1', auditEvery, auditSummaryAvailable: false,
    sampledRevisions: [...sampledRevisions], privacyChecks: null, opponentHandExchanges: null });
  const exclusion = (reason, extra = {}) => ({ id: task.id, episodeId, seed: task.seed, policySeat: task.policySeat, seatOrder: task.seatOrder,
    status: 'excluded', terminated: false, truncated: false, result: null, records: [], exclusionReason: reason,
    acceptedPpoDecisions, selectionDecisions, helperDecisions, audit: auditEvidence(), ...extra });
  try {
    const result = await runEpisode(config, { seed: task.seed, seatOrder: task.seatOrder, session, maxSeconds, maxCommands, auditEvery, signal,
      measureProcess: measureNativeProcess,
      onFrame: ({ entry, frame }) => {
        lastActorView = projector.project(frame.views[task.policySeat]); lastRevision = entry.revision;
        if (Object.hasOwn(entry, 'nativeSeedCalls')) sampledRevisions.push(entry.revision);
        onProgress({ revision: entry.revision, actorView: lastActorView, entry });
      },
      decideOrdinary: async ({ seat, view }) => {
        commandInFlight = true;
        if (seat !== task.policySeat) {
          if (opponent) return [...opponent(view)].find(value => value.actionId) ?? null;
          return opponentPolicy === 'weak' ? weakOrdinaryDecision(view) : null;
        }
        const encoded = encodeCardActionDecision(view, null, { printingAliases });
        const [sample] = validatePpoActions([encoded], await ppo.act([encoded], { deterministic: false }));
        currentSample = { revision: view.revision, encoded, sample };
        return { actionId: view.actions[sample.actionIndex].id };
      },
      decidePrompt: async ({ seat, view }) => {
        commandInFlight = true;
        if (seat !== task.policySeat) return opponent ? opponent(view) : null;
        if (view.status !== 'playing' || !supportsCardSelection(view)) return null;
        return rankedPromptAnswers(view, await selection.rankChoices({ view, prompt: view.prompts[0] }));
      },
      onAcceptedDecision: ({ seat, view, decision, promptPolicyUsed }) => {
        commandInFlight = false; requiredRevision = view.revision + 1;
        if (seat !== task.policySeat) return;
        if (currentSample?.revision === view.revision) {
          const { encoded, sample } = currentSample;
          if (decision.actionId !== view.actions[sample.actionIndex].id) throw new Error('executed PPO action differs from sampled legal index');
          buffer.accept(encoded, sample, { nativeRevision: view.revision, actorView: view, offeredActions: view.actions,
            behaviorSource: 'ppo-sampled', executedChoice: decision, seed: task.seed });
          currentSample = null; acceptedPpoDecisions++;
          actorEvents.push({ kind: 'ordinary', behaviorSource: 'model', view, decision });
        } else {
          const frozen = promptPolicyUsed === true;
          if (frozen) selectionDecisions++; else helperDecisions++;
          actorEvents.push({ kind: frozen ? 'selection' : 'helper', behaviorSource: frozen ? 'model' : 'fixed-helper', policySource: frozen ? 'frozen-bc-selection' : 'fixed-helper', view, decision });
        }
      } });
    const summary = result.summary;
    if (!summary.completedNaturally || summary.rejected !== 0 || summary.auditMode !== 'sampled-native-training/1') throw new Error('native PPO completion or audit-mode gate failed');
    if (!buffer.records.length) return exclusion('no-learned-ordinary-decision', { nativeSummary: summary, journal: result.journal });
    const winner = summary.winnerSeat;
    const explicitDraw = winner === null && (result.draw === true || lastActorView?.result === 'draw');
    if (!['human', 'opponent'].includes(winner) && !explicitDraw) return exclusion('natural-terminal-outcome-unavailable', { nativeSummary: summary, journal: result.journal });
    const outcome = explicitDraw ? 'draw' : winner === task.policySeat ? 'win' : 'loss';
    const records = buffer.finish({ terminated: true, nextValue: 0, result: outcome });
    return { id: task.id, episodeId, seed: task.seed, policySeat: task.policySeat, seatOrder: task.seatOrder,
      status: 'terminated', terminated: true, truncated: false, result: outcome, records, nativeSummary: summary, journal: result.journal,
      acceptedPpoDecisions, selectionDecisions, helperDecisions, diagnostics: cardActionDiagnostics(actorEvents, diagnostics),
      audit: { auditMode: summary.auditMode, auditEvery, auditSummaryAvailable: true, privacyChecks: summary.privacyChecks,
        opponentHandExchanges: summary.opponentHandExchanges, sampledRevisions: summary.sampledRevisions } };
  } catch (error) {
    const globalBudget = signal?.aborted && signal.reason?.code === 'PPO_GLOBAL_WALL_BUDGET' && error.code === 'NATIVE_TRAINING_CANCELLED';
    if (!budgetCodes.has(error?.code) && !globalBudget) return exclusion(error.message, { status: 'fatal', errorCode: error.code ?? null,
      rejected: error.message === 'native command rejected' ? 1 : 0 });
    if (!buffer.records.length) return exclusion('truncation-before-first-learned-ordinary-decision', { truncationCode: error.code });
    if (commandInFlight || currentSample || lastRevision < requiredRevision || !lastActorView)
      return exclusion('truncation-final-state-unavailable-or-command-uncertain', { truncationCode: error.code });
    try {
      const state = encodePpoBootstrapState(lastActorView, printingAliases), [nextValue] = await ppo.values([state]);
      if (!Number.isFinite(nextValue)) throw new Error('nonfinite truncation bootstrap');
      const records = buffer.finish({ terminated: false, nextValue, result: null });
      return { id: task.id, episodeId, seed: task.seed, policySeat: task.policySeat, seatOrder: task.seatOrder,
        status: 'truncated', terminated: false, truncated: true, result: null, records, truncationCode: error.code,
        bootstrapRevision: lastRevision, bootstrapState: state, acceptedPpoDecisions, selectionDecisions, helperDecisions,
        diagnostics: cardActionDiagnostics(actorEvents, diagnostics), audit: auditEvidence() };
    } catch (bootstrapError) { return exclusion('truncation-bootstrap-unavailable', { truncationCode: error.code, bootstrapError: bootstrapError.message }); }
  }
}

async function reap(session) {
  if (!session.worker) return;
  const child = session.worker.child; session.worker.close();
  if (child.pid && child.exitCode === null && child.signalCode === null)
    await new Promise(accept => { child.once('exit', accept); child.once('close', accept); });
}

export async function runPpoNativeRollout(configPath, name, planPath) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '')) throw new Error('fresh PPO rollout name required');
  const plan = admitPpoRolloutPlan(read(planPath)), config = read(configPath), inputs = verifyLocalInputs(config);
  if (config.buildConfiguration !== 'Release' || config.projectionCopyMode !== 'projection-turn-v1') throw new Error('accepted pinned Release native profile required');
  const experiment = read(join(root, 'learning/model-three-plan.json'));
  if (hash(JSON.stringify(inputs.selected[0])) !== experiment.deck.orderedMechanicsSha256) throw new Error('exact AgentPult deck-zero identity required');
  const outputRoot = resolve(plan.outputRoot ?? join(root, 'runs'));
  if (!isAbsolute(outputRoot) || outputRoot === parse(outputRoot).root) throw new Error('dedicated private outputRoot required');
  mkdirSync(outputRoot, { recursive: true });
  if (realpathSync(outputRoot).toLowerCase() !== outputRoot.toLowerCase()) throw new Error('outputRoot must not be redirected');
  const output = join(outputRoot, name); mkdirSync(output);
  const hashes = sourceHashes(), planHash = hash(readFileSync(planPath)), configHash = hash(readFileSync(configPath));
  const pins = Object.fromEntries(['workerSha256', 'executableSha256', 'manifestSha256', 'policySha256'].map(key => [key, config[key]]));
  const frozen = [];
  const snapshotModel = (path, label) => {
    const value = read(path);
    if (value.device !== 'cpu' || !isAbsolute(value.checkpoint ?? '') || !isAbsolute(value.executable ?? '')) throw new Error('explicit CPU rollout scorer configuration required');
    const original = realpathSync(value.checkpoint), sha256 = hash(readFileSync(original)), fixed = join(output, `${label}-fixed.pt`);
    copyFileSync(original, fixed); frozen.push({ original, fixed, sha256 });
    return { ...value, checkpoint: fixed, modelRoot: output };
  };
  const ppoConfig = snapshotModel(plan.ppoConfig, 'ppo'), selectionConfig = snapshotModel(plan.selectionConfig, 'selection');
  if (!isDeepStrictEqual(ppoConfig.printingAliases ?? {}, selectionConfig.printingAliases ?? {})) throw new Error('PPO and frozen-selection aliases must match');
  ppoConfig.frozenSelectionSha256 = frozen[1].sha256;
  const opponent = plan.opponentPolicyModule ? (await import(pathToFileURL(resolve(plan.opponentPolicyModule)))).livePracticeDecisions : null;
  const opponentPolicySha256 = plan.opponentPolicyModule ? hash(readFileSync(resolve(plan.opponentPolicyModule))) : null;
  for (const path of sources) {
    const destination = join(output, 'source-snapshot', path); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(join(root, path), destination);
    if (hash(readFileSync(destination)) !== hashes[path]) throw new Error('source changed during PPO snapshot');
  }
  copyFileSync(inputs.decisions, join(output, 'teacher-policy.mjs'));
  if (hash(readFileSync(join(output, 'teacher-policy.mjs'))) !== config.policySha256) throw new Error('teacher changed during snapshot');
  if (plan.opponentPolicyModule) copyFileSync(resolve(plan.opponentPolicyModule), join(output, 'opponent-policy.mjs'));
  if (plan.opponentPolicyModule && hash(readFileSync(join(output, 'opponent-policy.mjs'))) !== opponentPolicySha256) throw new Error('opponent changed during snapshot');
  save(join(output, 'plan.json'), plan); save(join(output, 'native-config.json'), config);
  save(join(output, 'ppo-config.json'), ppoConfig); save(join(output, 'selection-config.json'), selectionConfig);
  const assertFixed = () => {
    if (!isDeepStrictEqual(sourceHashes(), hashes) || hash(readFileSync(planPath)) !== planHash || hash(readFileSync(configPath)) !== configHash
        || hash(readFileSync(inputs.decisions)) !== config.policySha256
        || frozen.some(value => hash(readFileSync(value.original)) !== value.sha256 || hash(readFileSync(value.fixed)) !== value.sha256)
        || (plan.opponentPolicyModule && hash(readFileSync(resolve(plan.opponentPolicyModule))) !== opponentPolicySha256)) throw new Error('PPO collection checkpoint, source or policy changed');
  };
  const recordsPath = join(output, 'records.jsonl'); writeFileSync(recordsPath, '', { flag: 'wx' });
  const started = performance.now(), deadline = Date.now() + plan.maximumWallSeconds * 1000, abort = new AbortController();
  const sessions = Array.from({ length: plan.workers }, () => ({})), episodes = [], clients = [];
  let cursor = 0, cancellation = null;
  const cancel = reason => {
    cancellation ??= reason;
    abort.abort(Object.assign(new Error(reason), { code: reason === 'global-wall-budget' ? 'PPO_GLOBAL_WALL_BUDGET' : 'PPO_COLLECTION_CANCELLED' }));
    for (const session of sessions) session.worker?.close();
  };
  const timer = setTimeout(() => cancel('global-wall-budget'), plan.maximumWallSeconds * 1000);
  const interrupt = () => cancel('operator-interrupted'); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  async function lane(index) {
    let ppo = null, selection = null;
    try {
      ppo = new PpoModelClient({ ...ppoConfig, seed: ((plan.seed ?? 1729) + index) >>> 0 }); clients.push(ppo); await ppo.verify();
      selection = new CardActionModelClient(selectionConfig); clients.push(selection); await selection.verify();
      while (!cancellation && cursor < plan.tasks.length && Date.now() < deadline) {
        const task = plan.tasks[cursor++], directory = join(output, task.id); mkdirSync(directory); assertFixed();
        const samplingSeed = (task.seed ^ (plan.seed ?? 1729)) >>> 0;
        await ppo.setSeed(samplingSeed);
        let lastProgress = 0;
        const collected = await collectPpoEpisode(config, task, { ppo, selection, session: sessions[index], opponent,
          opponentPolicy: plan.opponentPolicy ?? 'teacher', printingAliases: ppoConfig.printingAliases ?? {},
          maxSeconds: Math.max(1, Math.min(plan.maximumGameSeconds, Math.floor((deadline - Date.now()) / 1000))),
          maxCommands: plan.maximumGameCommands, auditEvery: plan.auditEvery ?? 32, signal: abort.signal, diagnostics: plan.diagnostics ?? {},
          onProgress: value => {
            appendFileSync(join(directory, 'progress.jsonl'), JSON.stringify(value) + '\n');
            if (performance.now() - lastProgress > 20000) { console.log(JSON.stringify({ lane: index, case: task.id, revision: value.revision })); lastProgress = performance.now(); }
          } });
        assertFixed();
        const { records, journal, ...episode } = collected;
        if (journal) save(join(directory, 'journal.json'), journal);
        if (records.length) {
          const bytes = records.map(value => JSON.stringify(value)).join('\n') + '\n';
          writeFileSync(join(directory, 'records.jsonl'), bytes, { flag: 'wx' }); appendFileSync(recordsPath, bytes);
          episode.recordsPath = `${task.id}/records.jsonl`; episode.recordsSha256 = hash(bytes);
        }
        episode.recordsCount = records.length; episode.errors = collected.status === 'fatal' ? 1 : 0; episode.rejected ??= 0;
        episode.lane = index; episode.samplingSeed = samplingSeed;
        save(join(directory, 'receipt.json'), episode); episodes.push(episode);
        console.log(JSON.stringify({ case: task.id, status: episode.status, result: episode.result, records: records.length }));
        if (collected.status !== 'terminated') { await reap(sessions[index]); sessions[index] = {}; }
        if (collected.status === 'fatal') cancel('fatal-peer');
      }
    } catch (error) { episodes.push({ id: `lane-${index}-failure`, status: 'fatal', result: null, recordsCount: 0, errors: 1, reason: error.message }); cancel('fatal-peer'); }
    finally { await reap(sessions[index]); if (ppo) await ppo.shutdown(); if (selection) await selection.shutdown(); }
  }
  try { await Promise.all(Array.from({ length: plan.workers }, (_, index) => lane(index))); }
  finally { clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  try { assertFixed(); verifyLocalInputs(config); } catch (error) { episodes.push({ id: 'final-provenance', status: 'fatal', result: null, recordsCount: 0, errors: 1, reason: error.message }); }
  const fatalErrors = episodes.filter(value => value.status === 'fatal').length;
  const unattempted = plan.tasks.filter(task => !episodes.some(value => value.id === task.id));
  const receipt = { schema: 'native-ppo-rollout/1', complete: true, fatal: fatalErrors > 0, featureContract: cardActionFeatureContract,
    sourceHashes: hashes, pins, parentCheckpointSha256: frozen[0].sha256, selectionCheckpointSha256: frozen[1].sha256,
    checkpointsUnchanged: frozen.every(value => hash(readFileSync(value.original)) === value.sha256 && hash(readFileSync(value.fixed)) === value.sha256),
    printingAliases: ppoConfig.printingAliases ?? {}, recordsPath: 'records.jsonl', recordsSha256: hash(readFileSync(recordsPath)),
    recordsCount: episodes.reduce((sum, value) => sum + value.recordsCount, 0), episodes, unattempted, auditMode: 'sampled-native-training/1',
    auditEvery: plan.auditEvery ?? 32, planSha256: planHash, opponentPolicy: opponent ? 'pinned-module' : plan.opponentPolicy ?? 'teacher', opponentPolicySha256,
    deterministic: false, teacherOverrides: 0, counts: { episodes: episodes.length, terminated: episodes.filter(value => value.status === 'terminated').length,
      truncated: episodes.filter(value => value.status === 'truncated').length, excluded: episodes.filter(value => value.status === 'excluded').length,
      fatalErrors, errors: fatalErrors, rejected: episodes.reduce((sum, value) => sum + (value.rejected ?? 0), 0), records: episodes.reduce((sum, value) => sum + value.recordsCount, 0),
      wins: episodes.filter(value => value.result === 'win').length, losses: episodes.filter(value => value.result === 'loss').length,
      draws: episodes.filter(value => value.result === 'draw').length, unattempted: unattempted.length },
    elapsedMilliseconds: performance.now() - started, stopReason: cancellation ?? 'fixed-plan-finished',
    interpretation: 'On-policy ordinary actions only; frozen BC card selections and explicit helpers are excluded from PPO records. Truncations bootstrap only a verified actual pre-reset actor-visible state.' };
  save(join(output, 'receipt.json'), receipt); return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error('Usage: node scripts/ppo-native-rollout.mjs <private-native-config> <fresh-run-name> <private-plan.json>');
    const receipt = await runPpoNativeRollout(...args); if (receipt.fatal) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
