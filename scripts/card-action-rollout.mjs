import { appendFileSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runAuditedEpisode } from '../integrations/local-worker/audit-runner.mjs';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import { measureNativeProcess } from '../integrations/local-worker/learning-rollout.mjs';
import { NativeModelClient } from '../integrations/local-worker/learning-model.mjs';
import { CardActionModelClient } from '../integrations/local-worker/card-action-model.mjs';
import { supportsCardSelection, rankedPromptAnswers, weakOrdinaryDecision, cardActionDiagnostics } from '../integrations/local-worker/card-action-policy.mjs';
import { cardActionFeatureContract, encodeCardActionDecision, encodeCardChoiceDecision } from '../learning/card-action-features.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sourcePaths = ['scripts/card-action-rollout.mjs', 'integrations/local-worker/card-action-policy.mjs',
  'learning/model-three-plan.json',
  'learning/agentpult-teacher.mjs', 'learning/agentpult-deck.json', 'scripts/prepare-agentpult-training.mjs',
  'learning/requirements-model3-windows.txt',
  'learning/card-action-features.mjs', 'learning/card_action_torch.py', 'learning/train_card_action.py', 'integrations/local-worker/card-action-model.mjs',
  'integrations/local-worker/audit-runner.mjs', 'integrations/local-worker/probe.mjs', 'integrations/local-worker/policy-view.mjs',
  'integrations/local-worker/semantic-state.mjs', 'integrations/local-worker/decision-domain.mjs',
  'integrations/local-worker/learning-model.mjs', 'integrations/local-worker/learning-features.mjs', 'learning/native_torch.py'];
const sourceHashes = () => Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(join(root, path)))]));
const ordinary = view => view.status === 'playing' && view.turn === 'you' && !view.prompts.length && view.actions.length > 0;
const relativeArtifact = (directory, path) => {
  const value = relative(directory, path);
  if (!value || isAbsolute(value) || value.startsWith('..')) throw new Error('private artifact escaped run directory');
  return value.replaceAll('\\', '/');
};

export function admitCardActionPlan(plan) {
  if (plan?.schema !== 'native-card-action-rollout-plan/1' || !['qualification', 'bootstrap', 'dagger', 'evaluate'].includes(plan.mode)
      || !Number.isInteger(plan.workers) || plan.workers < 1 || plan.workers > 4
      || !Number.isInteger(plan.maximumWallSeconds) || plan.maximumWallSeconds < 1 || plan.maximumWallSeconds > 3600
      || !Number.isInteger(plan.maximumGameSeconds) || plan.maximumGameSeconds < 1 || plan.maximumGameSeconds > 360
      || !Number.isInteger(plan.maximumGameCommands) || plan.maximumGameCommands < 1 || plan.maximumGameCommands > 500
      || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 64
      || !['teacher', 'weak'].includes(plan.opponentPolicy ?? 'teacher')
      || !Number.isFinite(plan.teacherMix ?? 0) || (plan.teacherMix ?? 0) < 0 || (plan.teacherMix ?? 0) > 1)
    throw new Error('bounded card/action rollout plan required');
  if (['dagger', 'evaluate'].includes(plan.mode) && !plan.modelConfig) throw new Error('student checkpoint required');
  if (plan.mode === 'evaluate' && (plan.teacherMix ?? 0) !== 0) throw new Error('final evaluation cannot use teacher overrides');
  const ids = new Set(), keys = new Set();
  for (const task of plan.tasks) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(task.id ?? '') || ids.has(task.id)
        || !Number.isSafeInteger(task.seed) || task.seed < 0 || task.seed > 0xffffffff
        || !['train', 'validation', 'evaluation'].includes(task.split)
        || !['human', 'opponent'].includes(task.policySeat)
        || ![[0, 1], [1, 0]].some(order => isDeepStrictEqual(order, task.seatOrder))
        || task.seatOrder[task.policySeat === 'human' ? 0 : 1] !== 0
        || keys.has(`${task.seed}/${task.policySeat}`)) throw new Error('unique seeded AgentPult deck-zero tasks required');
    ids.add(task.id); keys.add(`${task.seed}/${task.policySeat}`);
  }
  if (['bootstrap', 'dagger'].includes(plan.mode)) {
    if (new Set(plan.tasks.map(task => task.seed)).size !== plan.tasks.length
        || !plan.tasks.some(task => task.split === 'train') || !plan.tasks.some(task => task.split === 'validation')
        || plan.tasks.some(task => task.split === 'evaluation')) throw new Error('training requires unique whole-game train/validation splits');
  } else if (plan.tasks.some(task => task.split !== 'evaluation')) throw new Error('nontraining cases must remain evaluation-only');
  return plan;
}

export function cardActionFailure(error, cancellation = null) {
  if (error?.code === 'NATIVE_EPISODE_TIME_BUDGET') return { status: 'capacity-timeout', reason: 'episode-wall-budget', code: error.code };
  const closed = ['CARD_ACTION_CANCELLED', 'ABORT_ERR'].includes(error?.code)
    || ['worker closed or request already pending', 'local worker closed', 'model service closed', 'card/action model closed'].includes(error?.message);
  if (closed && cancellation === 'global-wall-budget') return { status: 'capacity-timeout', reason: cancellation, code: 'GLOBAL_CARD_ACTION_BUDGET' };
  if (closed && cancellation === 'fatal-peer') return { status: 'cancelled', reason: cancellation, code: 'CARD_ACTION_PEER_FAILED' };
  if (closed && cancellation === 'operator-interrupted') return { status: 'cancelled', reason: cancellation, code: 'CARD_ACTION_INTERRUPTED' };
  return { status: 'fatal', reason: error?.message ?? 'unknown rollout failure', code: error?.code ?? null };
}

async function reap(session) {
  if (!session.worker) return;
  session.worker.close();
  const child = session.worker.child;
  if (child.pid && child.exitCode === null && child.signalCode === null)
    await new Promise(accept => { child.once('exit', accept); child.once('close', accept); });
}

export async function runCardActionRollout(configPath, name, planPath) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '')) throw new Error('fresh private run name required');
  const plan = admitCardActionPlan(read(planPath)), config = read(configPath), inputs = verifyLocalInputs(config);
  if (config.buildConfiguration !== 'Release' || config.projectionCopyMode !== 'projection-turn-v1') throw new Error('accepted Release turn-profile worker required');
  const experiment = read(join(root, 'learning/model-three-plan.json'));
  if (hash(JSON.stringify(inputs.selected[0])) !== experiment.deck.orderedMechanicsSha256
      || hash(JSON.stringify(inputs.selected[1])) !== experiment.deck.opponentDeckSha256) throw new Error('fixed exact AgentPult mechanics and opponent decks required');
  const runs = join(root, 'runs'); mkdirSync(runs, { recursive: true });
  if (realpathSync(runs) !== runs) throw new Error('private runs directory must not be redirected');
  const output = join(runs, name); mkdirSync(output);
  const teacher = (await import(pathToFileURL(inputs.decisions))).livePracticeDecisions;
  if (typeof teacher !== 'function') throw new Error('pinned teacher generator required');
  const opponentPolicy = plan.opponentPolicyModule ? (await import(pathToFileURL(resolve(plan.opponentPolicyModule)))).livePracticeDecisions : null;
  const opponentPolicySha256 = plan.opponentPolicyModule ? hash(readFileSync(resolve(plan.opponentPolicyModule))) : null;
  const hashes = sourceHashes(), planHash = hash(readFileSync(planPath)), configHash = hash(readFileSync(configPath));
  const pins = Object.fromEntries(['workerSha256', 'executableSha256', 'manifestSha256', 'policySha256'].map(key => [key, config[key]]));
  const checkpoints = [];
  const fixedConfig = (path, label) => {
    if (!path) return null;
    const value = read(path);
    if (value.device !== 'cpu' || !isAbsolute(value.executable ?? '') || !isAbsolute(value.checkpoint ?? '')) throw new Error('explicit CPU inference configuration required');
    const original = realpathSync(value.checkpoint); relativeArtifact(runs, original);
    const fixed = join(output, `${label}-fixed.pt`), digest = hash(readFileSync(original)); copyFileSync(original, fixed);
    checkpoints.push({ original, fixed, sha256: digest });
    return { ...value, checkpoint: fixed };
  };
  const modelConfig = fixedConfig(plan.modelConfig, 'student'), opponentConfig = fixedConfig(plan.opponentModelConfig, 'opponent');
  const aliases = modelConfig?.printingAliases ?? plan.printingAliases ?? {};
  for (const path of sourcePaths) {
    const destination = join(output, 'source-snapshot', path); mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, path), destination);
    if (hash(readFileSync(destination)) !== hashes[path]) throw new Error('generation source changed during snapshot');
  }
  const teacherSnapshot = join(output, 'teacher-policy.mjs'); copyFileSync(inputs.decisions, teacherSnapshot);
  if (hash(readFileSync(teacherSnapshot)) !== config.policySha256) throw new Error('teacher changed during snapshot');
  if (plan.opponentPolicyModule) {
    const snapshot = join(output, 'opponent-policy.mjs'); copyFileSync(resolve(plan.opponentPolicyModule), snapshot);
    if (hash(readFileSync(snapshot)) !== opponentPolicySha256) throw new Error('opponent policy changed during snapshot');
  }
  save(join(output, 'plan.json'), plan); save(join(output, 'native-config.json'), config);
  const assertFixed = () => {
    if (hash(readFileSync(planPath)) !== planHash || hash(readFileSync(configPath)) !== configHash || !isDeepStrictEqual(sourceHashes(), hashes))
      throw new Error('rollout plan, configuration or generation source changed');
    if (hash(readFileSync(inputs.decisions)) !== config.policySha256 || checkpoints.some(value => hash(readFileSync(value.original)) !== value.sha256 || hash(readFileSync(value.fixed)) !== value.sha256))
      throw new Error('teacher or frozen checkpoint changed');
    if (plan.opponentPolicyModule && hash(readFileSync(resolve(plan.opponentPolicyModule))) !== opponentPolicySha256) throw new Error('pinned opponent policy changed');
  };
  const started = performance.now(), deadline = Date.now() + plan.maximumWallSeconds * 1000;
  const sessions = Array.from({ length: plan.workers }, () => ({})), models = [], outcomes = [], games = [];
  let nextTask = 0, cancellation = null;
  const cancel = reason => {
    cancellation ??= reason;
    for (const session of sessions) session.worker?.close(Object.assign(new Error(reason), { code: 'CARD_ACTION_CANCELLED' }));
    for (const model of models) model.close();
  };
  const timer = setTimeout(() => cancel('global-wall-budget'), plan.maximumWallSeconds * 1000);
  const interrupt = () => cancel('operator-interrupted'); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  async function lane(index) {
    let model = null, opponent = null;
    try {
      if (modelConfig) {
        model = plan.modelKind === 'native-v2' ? new NativeModelClient(modelConfig) : new CardActionModelClient(modelConfig);
        models.push(model); await model.verify();
      }
      if (opponentConfig) {
        opponent = plan.opponentModelKind === 'card-action' ? new CardActionModelClient(opponentConfig) : new NativeModelClient(opponentConfig);
        models.push(opponent); await opponent.verify();
      }
      while (!cancellation && Date.now() < deadline && nextTask < plan.tasks.length) {
        const task = plan.tasks[nextTask++], directory = join(output, task.id); mkdirSync(directory);
        const recordsPath = join(directory, 'records.jsonl'); writeFileSync(recordsPath, '', { flag: 'wx' });
        const decisions = [], pending = new Map(); let teacherCorrections = 0, modelBehavior = 0, lastProgress = 0;
        const caseStarted = performance.now(), modelRequestsBefore = model?.requests ?? 0;
        const teacherBehavior = revision => !model || (plan.mode === 'dagger' && parseInt(hash(`${task.seed}/${revision}`).slice(0, 8), 16) / 0x100000000 < (plan.teacherMix ?? 0));
        let outcome;
        try {
          assertFixed();
          const result = await runAuditedEpisode(config, { seed: task.seed, seatOrder: task.seatOrder, session: sessions[index],
            maxSeconds: Math.max(1, Math.min(plan.maximumGameSeconds, Math.floor((deadline - Date.now()) / 1000))), maxCommands: plan.maximumGameCommands,
            boundaryEvery: 1, strictCommands: true, measureProcess: measureNativeProcess,
            onFrame: ({ entry }) => {
              appendFileSync(join(directory, 'progress.jsonl'), JSON.stringify(entry) + '\n');
              if (performance.now() - lastProgress > 20000) { console.log(JSON.stringify({ lane: index, case: task.id, revision: entry.revision })); lastProgress = performance.now(); }
            },
            decideOrdinary: async ({ seat, view }) => {
              if (seat !== task.policySeat) return opponent ? opponent.decide({ view }) : plan.opponentPolicy === 'weak' ? weakOrdinaryDecision(view)
                : opponentPolicy ? [...opponentPolicy(view)].find(value => value.actionId) ?? null : null;
              const expected = [...teacher(view)].find(value => value.actionId);
              const label = view.actions.findIndex(value => value.id === expected?.actionId);
              if (label < 0) throw new Error('teacher ordinary label is outside complete legal actions');
              const useTeacher = teacherBehavior(view.revision), decision = useTeacher ? expected : await model.decide({ view });
              pending.set(view.revision, { kind: 'ordinary', label, behaviorSource: useTeacher ? 'teacher' : 'model' });
              if (decision.actionId !== expected.actionId) teacherCorrections++;
              if (!useTeacher) modelBehavior++;
              return decision;
            },
            decidePrompt: async ({ seat, view, validate }) => {
              if (seat !== task.policySeat) return opponentPolicy ? opponentPolicy(view) : null;
              if (view.status !== 'playing' || !supportsCardSelection(view)) return null;
              let expected = null, checked = 0;
              for (const candidate of teacher(view)) {
                if (++checked > 128) throw new Error('teacher prompt candidate budget exhausted');
                if (await validate(candidate)) { expected = candidate; break; }
              }
              if (!expected) throw new Error('teacher has no valid current card-selection answer');
              const prompt = view.prompts[0], labels = (expected.choiceIds ?? []).map(id => prompt.choices.findIndex(choice => choice.id === id));
              if (labels.some(label => label < 0) || new Set(labels).size !== labels.length) throw new Error('teacher label is outside complete visible choices');
              const fixedSelectionHelper = model && typeof model.rankChoices !== 'function';
              const useTeacher = fixedSelectionHelper || teacherBehavior(view.revision);
              pending.set(view.revision, { kind: 'selection', labels, label: labels[0], behaviorSource: fixedSelectionHelper ? 'fixed-helper' : useTeacher ? 'teacher' : 'model' });
              if (useTeacher) return [expected];
              modelBehavior++;
              return rankedPromptAnswers(view, await model.rankChoices({ view, prompt }));
            },
            onAcceptedDecision: ({ seat, view, decision }) => {
              if (seat !== task.policySeat) return;
              const metadata = pending.get(view.revision) ?? { kind: 'helper', behaviorSource: 'fixed-helper' };
              pending.delete(view.revision);
              const entry = { ...metadata, view, decision };
              decisions.push(entry); appendFileSync(join(directory, 'decisions.jsonl'), JSON.stringify(entry) + '\n');
              let encoded;
              if (metadata.kind === 'ordinary') encoded = encodeCardActionDecision(view, null, { printingAliases: aliases });
              else if (metadata.kind === 'selection' && metadata.labels.length) encoded = encodeCardChoiceDecision(view, view.prompts[0], { printingAliases: aliases });
              else return;
              const behaviorLabel = metadata.kind === 'ordinary' ? view.actions.findIndex(value => value.id === decision.actionId) : null;
              const behaviorLabels = metadata.kind === 'selection' ? (decision.choiceIds ?? []).map(id => view.prompts[0].choices.findIndex(choice => choice.id === id)) : undefined;
              appendFileSync(recordsPath, JSON.stringify({ ...encoded, ...metadata, actorView: view, episode: task.id, seed: task.seed, actorSeat: seat,
                behaviorLabel, behaviorLabels, executedChoice: decision, completeOfferedCandidateList: true,
                wholePromptAnswerEnumerationComplete: metadata.kind === 'selection' ? false : undefined }) + '\n');
            } });
          assertFixed();
          const summary = result.summary, checks = summary.boundaryChecks.filter(value => value.permutedSlots !== undefined);
          if (!summary.completedNaturally || summary.rejected || checks.length !== summary.commands * 2 || !checks.some(value => value.opponentHandExchanged)) throw new Error('native completion/privacy gates failed');
          if (!['human', 'opponent', null].includes(summary.winnerSeat)) throw new Error('unknown native terminal winner');
          if (model && model.requests - modelRequestsBefore !== modelBehavior) throw new Error('model inference/behavior accounting disagreed');
          save(join(directory, 'journal.json'), result.journal);
          const { boundaryChecks, ...native } = summary;
          const game = { ...task, ...native, privacyChecks: checks.length, realHandExchanges: checks.filter(value => value.opponentHandExchanged).length,
            recordsPath: relativeArtifact(output, recordsPath), recordsSha256: hash(readFileSync(recordsPath)),
            journalSha256: hash(readFileSync(join(directory, 'journal.json'))), diagnostics: cardActionDiagnostics(decisions, plan.diagnostics),
            modelBehaviorDecisions: modelBehavior, teacherCorrections, modelWin: summary.winnerSeat === null ? null : summary.winnerSeat === task.policySeat,
            sourceHashes: hashes, pins, checkpointSha256: modelConfig ? checkpoints[0].sha256 : null };
          save(join(directory, 'case-receipt.json'), game); games.push(game);
          outcome = { ...task, status: 'completed', winnerSeat: summary.winnerSeat, modelWin: game.modelWin, commands: summary.commands,
            modelBehaviorDecisions: modelBehavior, diagnostics: game.diagnostics, receiptPath: relativeArtifact(output, join(directory, 'case-receipt.json')),
            receiptSha256: hash(readFileSync(join(directory, 'case-receipt.json'))), elapsedMilliseconds: performance.now() - caseStarted };
        } catch (error) {
          outcome = { ...task, ...cardActionFailure(error, cancellation), elapsedMilliseconds: performance.now() - caseStarted,
            partialModelRequests: (model?.requests ?? 0) - modelRequestsBefore };
          save(join(directory, 'failure.json'), { ...outcome, error: { message: error.message, code: error.code ?? null } });
          await reap(sessions[index]); sessions[index] = {};
          if (outcome.status === 'fatal') cancel('fatal-peer');
        }
        outcomes.push(outcome); save(join(directory, 'outcome.json'), outcome);
        console.log(JSON.stringify({ case: task.id, status: outcome.status, winnerSeat: outcome.winnerSeat, modelWin: outcome.modelWin }));
      }
    } catch (error) {
      outcomes.push({ status: 'fatal', phase: 'lane-startup', lane: index, reason: error.message }); cancel('fatal-peer');
    } finally {
      await reap(sessions[index]); if (model) await model.shutdown(); if (opponent) await opponent.shutdown();
    }
  }
  try { await Promise.all(Array.from({ length: plan.workers }, (_, index) => lane(index))); }
  finally { clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  try { assertFixed(); verifyLocalInputs(config); } catch (error) { outcomes.push({ status: 'fatal', phase: 'final-provenance', reason: error.message }); }
  const unattempted = plan.tasks.filter(task => !outcomes.some(value => value.id === task.id)).map(task => ({ ...task, status: 'unattempted', reason: cancellation ?? 'budget' }));
  const fatal = outcomes.some(value => value.status === 'fatal');
  const receipt = { schema: 'native-card-action-dataset/1', complete: true, fatal, timestamp: new Date().toISOString(), mode: plan.mode,
    featureContract: cardActionFeatureContract, printingAliases: aliases, sourceHashes: hashes, pins, planSha256: planHash,
    policyDeckHash: hash(JSON.stringify(inputs.selected[0])), opponentDeckHash: hash(JSON.stringify(inputs.selected[1])),
    games, outcomes, unattempted, limits: { workers: plan.workers, maximumWallSeconds: plan.maximumWallSeconds,
      maximumGameSeconds: plan.maximumGameSeconds, maximumGameCommands: plan.maximumGameCommands, replacements: 0 },
    counts: { attempted: outcomes.filter(value => value.id).length, completed: games.length,
      wins: games.filter(value => value.modelWin === true).length, losses: games.filter(value => value.modelWin === false).length,
      nativeTerminalWithoutWinner: games.filter(value => value.modelWin === null).length,
      capacityTimeouts: outcomes.filter(value => value.status === 'capacity-timeout').length,
      fatalErrors: outcomes.filter(value => value.status === 'fatal').length, cancelled: outcomes.filter(value => value.status === 'cancelled').length,
      unattempted: unattempted.length, commands: games.reduce((sum, value) => sum + value.commands, 0) },
    elapsedMilliseconds: performance.now() - started, stopReason: cancellation ?? 'fixed-plan-finished', checkpoints: checkpoints.map(({ sha256 }) => ({ sha256 })),
    opponentPolicy: opponentConfig ? plan.opponentModelKind ?? 'native-v2' : opponentPolicy ? 'pinned-module' : plan.opponentPolicy ?? 'teacher', opponentPolicySha256,
    modelSelectionChanged: false, interpretation: 'Natural outcomes only. Timeouts and interrupted games remain incomplete. Teaching labels and helper choices are attributed separately.' };
  save(join(output, 'receipt.json'), receipt); return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error('Usage: node scripts/card-action-rollout.mjs <private-native-config> <fresh-run-name> <private-plan.json>');
    const result = await runCardActionRollout(...args); if (result.fatal) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
