import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runTrainingEpisode } from '../integrations/local-worker/model6-training-episode.mjs';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import { supportsCardSelection, rankedPromptAnswers, weakOrdinaryDecision } from '../integrations/local-worker/card-action-policy.mjs';
import { EntityModelClient } from '../integrations/local-worker/entity-model.mjs';
import { Model6ModelClient } from '../integrations/local-worker/model6-model.mjs';
import { EntityPpoModelClient } from '../integrations/local-worker/entity-ppo-model.mjs';
import { createModel5Teacher } from '../learning/model5-teacher.mjs';
import { encodeModel6Decision as encodeEntityDecision, model6FeatureContract as entityFeatureContract } from '../learning/model6-features.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sourcePaths = ['scripts/entity-ppo-rollout.mjs', 'integrations/local-worker/entity-ppo-model.mjs',
  'learning/model6-contract.json', 'learning/model6-features.mjs', 'learning/model6_torch.py', 'learning/train_model6.py',
  'integrations/local-worker/model6-model.mjs', 'integrations/local-worker/model6-training-episode.mjs',
  'integrations/local-worker/model6-policy-view.mjs', 'integrations/local-worker/model6-native-source/MatchWorker.Energy.cs',
  'learning/entity_ppo.py', 'learning/entity_ppo_runtime.py', 'learning/entity_torch.py', 'learning/entity-contract.json',
  'learning/entity-features.mjs', 'learning/masked_ppo.py', 'learning/card_action_torch.py',
  'integrations/local-worker/entity-model.mjs', 'integrations/local-worker/training-episode.mjs',
  'integrations/local-worker/policy-view.mjs', 'integrations/local-worker/probe.mjs',
  'integrations/local-worker/semantic-state.mjs', 'integrations/local-worker/card-action-policy.mjs',
  'learning/model5-teacher.mjs', 'learning/agentpult-teacher.mjs',
  'integrations/local-worker/native-source/MatchWorker.Offers.cs', 'integrations/local-worker/native-source/MatchWorker.Projection.cs'];
const sourceHashes = () => Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(join(root, path)))]));

function visibleContext() {
  let turn = null, originAction = null, originCard = null, usage = {}, entityUsage = {};
  return {
    view(view) {
      if (turn !== view.turnNumber) {
        turn = view.turnNumber; originAction = null; originCard = null; entityUsage = {};
        usage = Object.fromEntries(['energyPlayed', 'supporterPlayed', 'retreated'].map(key => [key, { known: true, value: false }]));
      }
      for (const card of [view.you.active, ...view.you.bench].filter(Boolean))
        entityUsage[card.instanceId] ??= { abilityUsed: { known: true, value: false } };
      return { ...view, decisionContext: { originAction, originCard, usage: structuredClone(usage), entityUsage: structuredClone(entityUsage) } };
    },
    accept(view, decision, catalog) {
      if (!decision.actionId) return;
      const action = view.actions.find(item => item.id === decision.actionId);
      if (!action) throw new Error('accepted action absent from actor-visible offers');
      originAction = structuredClone(action);
      originCard = [...view.hand, view.you.active, ...view.you.bench, ...view.you.discard].filter(Boolean)
        .find(card => card.instanceId === (action.sourceCardId ?? action.actorId)) ?? null;
      if (action.kind === 'retreat') usage.retreated.value = true;
      if (action.kind === 'ability' && action.actorId) entityUsage[action.actorId] = { abilityUsed: { known: true, value: true } };
      if (action.kind === 'play' && originCard?.category === 'energy') usage.energyPlayed.value = true;
      const canonical = catalog.printingAliases[originCard?.printingId] ?? originCard?.printingId;
      const card = catalog.cards[catalog.cardIds[canonical] ?? 0];
      if (action.kind === 'play' && card?.format === 'supporter') usage.supporterPlayed.value = true;
    },
  };
}

function promotion(view) {
  const prompt = view.prompts[0], bench = new Set(view.you.bench.map(card => card.instanceId));
  return view.status === 'playing' && supportsCardSelection(view) && prompt.kind === 'pokemon'
    && prompt.min === 1 && prompt.max === 1 && !prompt.ordered
    && (!view.you.active || view.decisionContext?.originAction?.kind === 'retreat')
    && prompt.choices.every(choice => !choice.sourceCard && !choice.sourceCardId
      && choice.minAmount == null && choice.maxAmount == null && choice.initialAmount == null
      && bench.has(choice.instanceId ?? choice.card?.instanceId));
}

function singletonCardSelection(view) {
  const prompt = view.prompts[0];
  return view.status === 'playing' && supportsCardSelection(view) && prompt.min === 1 && prompt.max === 1
    && !prompt.ordered && prompt.choices.every(choice => choice.minAmount == null
      && choice.maxAmount == null && choice.initialAmount == null);
}

export async function chooseValidatedSingleton(view, validate, actor, catalog, deterministic) {
  if (!singletonCardSelection(view) || typeof validate !== 'function') throw new Error('current singleton and native validator required');
  const prompt = view.prompts[0], encoded = encodeEntityDecision(view, { catalog });
  encoded.selectionCardinality = 1;
  encoded.legalMask = [];
  for (const choice of prompt.choices) encoded.legalMask.push(await validate({ promptId: prompt.id, choiceIds: [choice.id] }) === true);
  if (!encoded.legalMask.some(Boolean)) throw new Error('current card decision has no native-valid singleton');
  const [sample] = await actor.act([encoded], { deterministic });
  if (!encoded.legalMask[sample.actionIndex]) throw new Error('PPO chose native-invalid singleton');
  return { encoded, sample, decision: { promptId: prompt.id, choiceIds: [prompt.choices[sample.actionIndex].id] } };
}

async function reap(session) {
  if (!session.worker) return;
  const child = session.worker.child; session.worker.close();
  if (child.exitCode === null && child.signalCode === null)
    await new Promise(accept => { child.once('exit', accept); child.once('close', accept); });
}

function admit(plan) {
  if (plan?.schema !== 'entity-ppo-plan/1' || !['collect', 'evaluate'].includes(plan.mode)
      || !Number.isInteger(plan.workers) || plan.workers < 1 || plan.workers > 4
      || !Number.isInteger(plan.maximumWallSeconds) || plan.maximumWallSeconds < 1 || plan.maximumWallSeconds > 3600
      || !Number.isInteger(plan.maximumGameSeconds) || plan.maximumGameSeconds < 1 || plan.maximumGameSeconds > 360
      || !Number.isInteger(plan.maximumGameCommands) || plan.maximumGameCommands < 1 || plan.maximumGameCommands > 2000
      || !Number.isSafeInteger(plan.seed) || plan.seed < 0 || plan.seed > 0xffffffff
      || plan.targetNativeCommands !== undefined && (!Number.isSafeInteger(plan.targetNativeCommands)
        || plan.targetNativeCommands < 1 || plan.targetNativeCommands > 32768)
      || plan.targetLearnedTransitions !== undefined && (!Number.isSafeInteger(plan.targetLearnedTransitions)
        || plan.targetLearnedTransitions < 1 || plan.targetLearnedTransitions > 16384)
      || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 64)
    throw new Error('bounded Model6 collection/evaluation plan required');
  if (plan.baselineOpponentKind !== undefined && plan.baselineOpponentKind !== 'ppo')
    throw new Error('explicit PPO opponent kind or unchanged legacy route required');
  if (plan.baselineOpponentKind === 'ppo' && (!isAbsolute(plan.baselineOpponentConfig ?? '')
      || !/^[a-f0-9]{64}$/.test(plan.baselineCheckpointSha256 ?? '')))
    throw new Error('frozen PPO opponent configuration and checkpoint pin required');
  if (plan.fixedDeckSha256 !== undefined && plan.fixedDeckSha256 !== '33353baee4928160844e04c61362341d40260b51cc1a048be1117cd2455ce4a7')
    throw new Error('only the retained exact Hammerpult pilot recipe is admitted');
  const ids = new Set(), seeds = new Set();
  for (const task of plan.tasks) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(task.id) || ids.has(task.id)
        || !Number.isSafeInteger(task.seed) || task.seed < 200000 || task.seed > 0xffffffff
        || (plan.mode === 'collect' && seeds.has(task.seed))
        || !['human', 'opponent'].includes(task.policySeat)
        || ![[0, 1], [1, 0]].some(order => isDeepStrictEqual(order, task.seatOrder))
        || task.seatOrder[task.policySeat === 'human' ? 0 : 1] !== 0
        || !['weak', 'teacher', 'baseline'].includes(task.opponentPolicy)) throw new Error('fresh exact-deck Model6 task required');
    ids.add(task.id); seeds.add(task.seed);
  }
  return plan;
}

export async function runEntityPpoRollout(configPath, name, planPath) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '')) throw new Error('fresh ignored Model6 run name required');
  const plan = admit(read(planPath)), config = read(configPath), inputs = verifyLocalInputs(config);
  const deckSha256 = plan.fixedDeckSha256 ?? '18910f5075b8b115d38081e4b9c4b396e7cbf17006a6fb030ed6bd9d912f69a3';
  if (hash(JSON.stringify(inputs.selected[0])) !== deckSha256)
    throw new Error('exact AgentPult sixty required');
  if (plan.tasks.some(task => task.opponentPolicy === 'baseline')
      && hash(JSON.stringify(inputs.selected[1])) !== deckSha256)
    throw new Error('fixed-deck baseline opponent requires the mirrored AgentPult profile');
  const ppoConfig = read(plan.ppoConfig), selectionConfig = read(plan.selectionConfig);
  const opponentConfig = plan.baselineOpponentConfig ? read(plan.baselineOpponentConfig) : selectionConfig;
  const ppoOpponent = plan.baselineOpponentKind === 'ppo';
  if (ppoOpponent && (hash(readFileSync(opponentConfig.checkpoint)) !== plan.baselineCheckpointSha256
      || opponentConfig.frozenSelectionSha256 !== hash(readFileSync(selectionConfig.checkpoint))))
    throw new Error('frozen PPO ordinary/selector pins differ from the admitted baseline');
  if ([ppoConfig, selectionConfig, opponentConfig].some(value => value.device !== 'cpu' || !isAbsolute(value.checkpoint ?? '') || !isAbsolute(value.executable ?? '')))
    throw new Error('explicit frozen CPU rollout configurations required');
  if (ppoConfig.catalogSha256 !== selectionConfig.catalogSha256 || ppoConfig.catalogSha256 !== opponentConfig.catalogSha256)
    throw new Error('Model5/6 catalog mismatch');
  const catalogBytes = readFileSync(ppoConfig.catalogPath), catalog = read(ppoConfig.catalogPath);
  if (hash(catalogBytes) !== ppoConfig.catalogSha256) throw new Error('catalog bytes changed');
  const teacherCatalogSha256 = hash(readFileSync(plan.teacherCatalogPath));
  const teacherCatalog = read(plan.teacherCatalogPath), teacher = createModel5Teacher(teacherCatalog);
  const checkpoints = [ppoConfig, selectionConfig, opponentConfig].map(value => ({ path: value.checkpoint, sha256: hash(readFileSync(value.checkpoint)) }));
  const hashes = sourceHashes(), planHash = hash(readFileSync(planPath)), configHash = hash(readFileSync(configPath));
  const output = join(root, 'runs', name); mkdirSync(output);
  for (const path of sourcePaths) {
    const target = join(output, 'source-snapshot', path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, path), target);
  }
  save(join(output, 'plan.json'), plan); save(join(output, 'native-config.json'), config);
  save(join(output, 'ppo-config.json'), ppoConfig); save(join(output, 'selection-config.json'), selectionConfig);
  copyFileSync(ppoConfig.catalogPath, join(output, 'public-catalog.json'));
  const recordsPath = join(output, 'records.jsonl'); writeFileSync(recordsPath, '', { flag: 'wx' });
  const assertFixed = () => {
    if (!isDeepStrictEqual(sourceHashes(), hashes) || hash(readFileSync(planPath)) !== planHash
        || hash(readFileSync(configPath)) !== configHash || hash(readFileSync(ppoConfig.catalogPath)) !== hash(catalogBytes)
        || hash(readFileSync(plan.teacherCatalogPath)) !== teacherCatalogSha256
        || checkpoints.some(value => hash(readFileSync(value.path)) !== value.sha256)) throw new Error('frozen Model6 collection authority changed');
  };
  const started = performance.now(), deadline = Date.now() + plan.maximumWallSeconds * 1000, abort = new AbortController();
  const sessions = Array.from({ length: plan.workers }, () => ({})), episodes = [], clients = [];
  let cursor = 0, cancellation = null, nativeCommands = 0, learnedTransitions = 0;
  const cancel = reason => { cancellation ??= reason; abort.abort(); for (const session of sessions) session.worker?.close(); };
  const timer = setTimeout(() => cancel('global-wall-budget'), plan.maximumWallSeconds * 1000);
  const interrupt = () => cancel('operator-interrupted'); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  async function lane(index) {
    let ppo, frozen, opponent;
    try {
      ppo = new EntityPpoModelClient({ ...ppoConfig, seed: (plan.seed + index) >>> 0 }); clients.push(ppo); await ppo.verify();
      frozen = new Model6ModelClient(selectionConfig); clients.push(frozen); await frozen.verify();
      opponent = ppoOpponent ? new EntityPpoModelClient(opponentConfig)
        : isDeepStrictEqual(opponentConfig, selectionConfig) ? frozen : new EntityModelClient(opponentConfig);
      if (opponent !== frozen) { clients.push(opponent); await opponent.verify(); }
      while (!cancellation && cursor < plan.tasks.length && Date.now() < deadline
          && (!plan.targetNativeCommands || nativeCommands < plan.targetNativeCommands)
          && (!plan.targetLearnedTransitions || learnedTransitions < plan.targetLearnedTransitions)) {
        const task = plan.tasks[cursor++], directory = join(output, task.id); mkdirSync(directory); assertFixed();
        await ppo.setSeed((task.seed ^ plan.seed) >>> 0);
        if (ppoOpponent) await opponent.setSeed(task.seed);
        const contexts = { human: visibleContext(), opponent: visibleContext() }, records = [];
        let pending = null, selectionDecisions = 0, helperDecisions = 0, promotionDecisions = 0, singletonSelectionDecisions = 0, lastProgress = 0, acceptedCommands = 0;
        const begin = performance.now();
        const sampled = async view => {
          const encoded = encodeEntityDecision(view, { catalog });
          if (view.prompts.length) throw new Error('selection sampling needs native-checked legal mask');
          const [sample] = await ppo.act([encoded], { deterministic: plan.mode === 'evaluate' });
          pending = { revision: view.revision, encoded, sample, view };
          return { actionId: view.actions[sample.actionIndex].id };
        };
        let episode;
        try {
          const result = await runTrainingEpisode(config, { seed: task.seed, seatOrder: task.seatOrder, session: sessions[index],
            maxSeconds: Math.max(1, Math.min(plan.maximumGameSeconds, Math.floor((deadline - Date.now()) / 1000))),
            maxCommands: plan.maximumGameCommands, auditEvery: 32, signal: abort.signal,
            onFrame: ({ entry }) => {
              appendFileSync(join(directory, 'progress.jsonl'), JSON.stringify(entry) + '\n');
              if (performance.now() - lastProgress > 20000) { console.log(JSON.stringify({ case: task.id, revision: entry.revision })); lastProgress = performance.now(); }
            },
            decideOrdinary: async ({ seat, view: raw }) => {
              const view = contexts[seat].view(raw);
              if (seat === task.policySeat) return sampled(view);
              if (task.opponentPolicy === 'baseline') return opponent.decide({ view });
              return task.opponentPolicy === 'teacher' ? [...teacher(view)].find(value => value.actionId) : weakOrdinaryDecision(view);
            },
            decidePrompt: async ({ seat, view: raw, validate }) => {
              const view = contexts[seat].view(raw);
              if (seat !== task.policySeat) {
                if (task.opponentPolicy !== 'baseline') return teacher(view);
                if (ppoOpponent) {
                  if (singletonCardSelection(view)) return [(await chooseValidatedSingleton(view, validate, opponent, catalog, true)).decision];
                  return supportsCardSelection(view) ? rankedPromptAnswers(view, await frozen.rankChoices({ view })) : null;
                }
                return supportsCardSelection(view) ? rankedPromptAnswers(view, await opponent.rankChoices({ view })) : teacher(view);
              }
              if (singletonCardSelection(view)) {
                const { encoded, sample, decision } = await chooseValidatedSingleton(view, validate, ppo, catalog, plan.mode === 'evaluate');
                pending = { revision: view.revision, encoded, sample, view };
                return [decision];
              }
              return supportsCardSelection(view) ? rankedPromptAnswers(view, await frozen.rankChoices({ view })) : ppoOpponent ? null : teacher(view);
            },
            onAcceptedDecision: ({ seat, view: raw, decision }) => {
              acceptedCommands++;
              const view = contexts[seat].view(raw);
              if (seat === task.policySeat) {
                let source;
                if (pending?.revision === view.revision) {
                  const { encoded, sample } = pending;
                  const expected = encoded.kind === 'ordinary' ? { actionId: view.actions[sample.actionIndex].id }
                    : { promptId: view.prompts[0].id, choiceIds: [view.prompts[0].choices[sample.actionIndex].id] };
                  if (!isDeepStrictEqual(expected, decision)) throw new Error('executed decision differs from exact PPO sample');
                  if (records.length) records.at(-1).nextValue = sample.oldValue;
                  records.push({ ...encoded, ...sample, actorView: pending.view, executedChoice: decision,
                    episodeId: task.id, stepIndex: records.length, reward: 0, terminated: false, truncated: false,
                    segmentEnd: false, nextValue: null, behaviorSource: 'entity-ppo',
                    behaviorPolicy: 'entity-ppo-categorical/1', executedActionIndex: sample.actionIndex, seed: task.seed });
                  if (encoded.kind === 'selection') { singletonSelectionDecisions++; if (promotion(view)) promotionDecisions++; }
                  pending = null; source = 'entity-ppo';
                } else if (supportsCardSelection(view) && view.status === 'playing') { selectionDecisions++; source = 'frozen-model6-pre-PPO-selection'; }
                else { helperDecisions++; source = 'fixed-helper'; }
                appendFileSync(join(directory, 'accepted-decisions.jsonl'), JSON.stringify({ source, view, decision }) + '\n');
              }
              contexts[seat].accept(view, decision, catalog);
            } });
          assertFixed();
          const native = result.summary;
          if (acceptedCommands !== native.commands) throw new Error('accepted native command count mismatch');
          if (!native.completedNaturally || native.rejected !== 0 || native.privacyChecks < 2 || !records.length
              || !['human', 'opponent'].includes(native.winnerSeat)) throw new Error('native result/legality/privacy admission failed');
          const outcome = native.winnerSeat === task.policySeat ? 'win' : 'loss';
          Object.assign(records.at(-1), { reward: outcome === 'win' ? 1 : -1, terminated: true, segmentEnd: true, nextValue: 0 });
          const bytes = records.map(record => JSON.stringify(record)).join('\n') + '\n';
          writeFileSync(join(directory, 'records.jsonl'), bytes, { flag: 'wx' }); appendFileSync(recordsPath, bytes);
          save(join(directory, 'journal.json'), result.journal);
          episode = { ...task, episodeId: task.id, status: 'terminated', result: outcome, terminated: true, truncated: false,
            recordsPath: `${task.id}/records.jsonl`, recordsSha256: hash(bytes), recordsCount: records.length,
            ordinaryDecisions: records.length - singletonSelectionDecisions, singletonSelectionDecisions, promotionDecisions, selectionDecisions, helperDecisions,
            nativeSummary: native, completedNaturally: true, auditMode: native.auditMode, privacyChecks: native.privacyChecks,
            errors: 0, rejected: 0, elapsedMilliseconds: performance.now() - begin };
          learnedTransitions += records.length;
        } catch (error) {
          const budget = ['NATIVE_EPISODE_TIME_BUDGET', 'NATIVE_EPISODE_COMMAND_BUDGET'].includes(error.code) || cancellation === 'global-wall-budget';
          const bytes = records.map(record => JSON.stringify(record)).join('\n') + '\n';
          writeFileSync(join(directory, 'partial-records.jsonl'), bytes, { flag: 'wx' });
          episode = { ...task, episodeId: task.id, status: budget ? 'excluded' : cancellation ? 'excluded' : 'fatal', result: null,
            terminated: false, truncated: budget, exclusionReason: error.message, errorCode: error.code ?? null,
            recordsCount: 0, partialRecords: records.length, partialRecordsPath: `${task.id}/partial-records.jsonl`,
            partialRecordsSha256: hash(bytes), errors: budget || cancellation ? 0 : 1, rejected: 0,
            selectionDecisions, helperDecisions, singletonSelectionDecisions, promotionDecisions, acceptedCommands, elapsedMilliseconds: performance.now() - begin };
          await reap(sessions[index]); sessions[index] = {};
          if (episode.status === 'fatal') cancel('fatal-peer');
        }
        nativeCommands += acceptedCommands;
        episodes.push(episode); save(join(directory, 'receipt.json'), episode);
        console.log(JSON.stringify({ case: task.id, status: episode.status, result: episode.result, records: episode.recordsCount }));
      }
    } catch (error) { episodes.push({ episodeId: `lane-${index}`, status: 'fatal', result: null, recordsCount: 0, errors: 1, reason: error.message }); cancel('fatal-peer'); }
    finally { await reap(sessions[index]); if (ppo) await ppo.shutdown(); if (frozen) await frozen.shutdown();
      if (opponent && opponent !== frozen) await opponent.shutdown(); }
  }
  try { await Promise.all(Array.from({ length: plan.workers }, (_, index) => lane(index))); }
  finally { clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  try { assertFixed(); verifyLocalInputs(config); } catch (error) { episodes.push({ episodeId: 'final-integrity', status: 'fatal', result: null, recordsCount: 0, errors: 1, reason: error.message }); }
  const unattempted = plan.tasks.filter(task => !episodes.some(episode => episode.id === task.id));
  const receipt = { schema: 'entity-ppo-rollout/1', complete: true, fatal: episodes.some(episode => episode.status === 'fatal'),
    featureContract: entityFeatureContract, sourceHashes: hashes, parentCheckpointSha256: checkpoints[0].sha256,
    selectionCheckpointSha256: checkpoints[1].sha256, catalogSha256: hash(catalogBytes), teacherCatalogSha256,
    opponentCheckpointSha256: checkpoints[2].sha256, opponentKind: ppoOpponent ? 'frozen-ppo' : 'legacy',
    rewardVersion: 'natural-terminal-w1-d0-lminus1/1', nativeCommands, learnedTransitions,
    checkpointsUnchanged: checkpoints.every(value => hash(readFileSync(value.path)) === value.sha256),
    recordsPath: 'records.jsonl', recordsSha256: hash(readFileSync(recordsPath)), recordsCount: episodes.reduce((sum, value) => sum + value.recordsCount, 0),
    episodes, unattempted, deterministic: plan.mode === 'evaluate', teacherOverrides: 0, mode: plan.mode,
    pins: { workerSha256: config.workerSha256, executableSha256: config.executableSha256, manifestSha256: config.manifestSha256, policySha256: config.policySha256 },
    counts: { episodes: episodes.length, terminated: episodes.filter(value => value.status === 'terminated').length,
      truncated: episodes.filter(value => value.truncated).length, excluded: episodes.filter(value => value.status === 'excluded').length,
      wins: episodes.filter(value => value.result === 'win').length, losses: episodes.filter(value => value.result === 'loss').length,
      draws: 0, fatalErrors: episodes.filter(value => value.status === 'fatal').length,
      errors: episodes.reduce((sum, value) => sum + (value.errors ?? 0), 0), rejected: 0,
      records: episodes.reduce((sum, value) => sum + value.recordsCount, 0), unattempted: unattempted.length },
    elapsedMilliseconds: performance.now() - started,
    stopReason: cancellation ?? (plan.targetLearnedTransitions && learnedTransitions >= plan.targetLearnedTransitions ? 'whole-game-learned-transition-target'
      : plan.targetNativeCommands && nativeCommands >= plan.targetNativeCommands ? 'whole-game-native-step-target' : 'fixed-plan-finished'),
    interpretation: 'PPO ordinary and supported exact-one-card choices with every offered singleton natively checked; complete offered candidates retained. Other card rankings use immutable same-contract Model6 pre-PPO BC; cardinality and unsupported decisions are attributed helpers. Natural terminal +/-1 only. Incomplete raw trajectories retained, explicitly excluded from initial PPO updates; no invented bootstrap/result.' };
  save(join(output, 'receipt.json'), receipt); return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEntityPpoRollout(...process.argv.slice(2)).then(value => { console.log(JSON.stringify(value.counts)); if (value.fatal) process.exitCode = 1; })
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
