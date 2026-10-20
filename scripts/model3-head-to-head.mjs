import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { NativeModelClient } from '../integrations/local-worker/learning-model.mjs';

// Eight direct comparisons only; gameplay and inference remain in the existing native APIs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => hash(readFileSync(path));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const [preparedPath, checkpoint, checkpointSha256, name] = process.argv.slice(2);
if (process.argv.length !== 6 || !isAbsolute(checkpoint ?? '') || !/^[a-f0-9]{64}$/.test(checkpointSha256 ?? '')
    || !/^[a-z][a-z0-9-]{0,63}$/.test(name ?? ''))
  throw new Error('Usage: node scripts/model3-head-to-head.mjs <prepared.json> <absolute-final-PPO.pt> <final-sha256> <fresh-run-name>');
const prepared = read(preparedPath), protocol = read(join(root, 'learning/model-three-frozen-evaluation.json'));
if (protocol.schema !== 'agentpult-model3-head-to-head/1' || protocol.limits.plannedGames !== 8
    || fileHash(checkpoint) !== checkpointSha256) throw new Error('immutable final checkpoint and eight-game protocol required');
const runtime = resolve(prepared.sourceRoot);
const load = path => import(pathToFileURL(join(runtime, path)));
const [{ runAuditedEpisode }, { verifyLocalInputs }, { PpoModelClient }, { CardActionModelClient },
  { supportsCardSelection, rankedPromptAnswers }] = await Promise.all([
  load('integrations/local-worker/audit-runner.mjs'), load('integrations/local-worker/probe.mjs'),
  load('integrations/local-worker/ppo-model.mjs'), load('integrations/local-worker/card-action-model.mjs'),
  load('integrations/local-worker/card-action-policy.mjs')]);
const nativeConfig = read(prepared.nativeConfig), inputs = verifyLocalInputs(nativeConfig);
if (fileHash(prepared.nativeConfig) !== prepared.nativeConfigSha256 || nativeConfig.buildConfiguration !== 'Release'
    || nativeConfig.projectionCopyMode !== 'projection-turn-v1' || inputs.selected.some(deck => hash(JSON.stringify(deck)) !== protocol.decks.orderedMechanicsSha256PerSeat))
  throw new Error('both seats must receive the pinned exact AgentPult sixty');
const two = read(prepared.modelTwoConfig), selection = read(prepared.selectionConfig);
if (fileHash(two.checkpoint) !== protocol.modelTwo.checkpointSha256 || fileHash(selection.checkpoint) !== prepared.selectionSha256
    || selection.device !== 'cpu' || two.device !== 'cpu') throw new Error('frozen Model2 and CPU BC selection identity required');
const output = join(root, 'runs', name); mkdirSync(output);
const fixed = (config, label) => {
  const target = join(output, `${label}.pt`), sha256 = fileHash(config.checkpoint);
  copyFileSync(config.checkpoint, target);
  if (fileHash(target) !== sha256) throw new Error('checkpoint changed during snapshot');
  return { ...config, checkpoint: target, modelRoot: output, device: 'cpu' };
};
const ppoConfig = fixed({ ...selection, checkpoint, frozenSelectionSha256: prepared.selectionSha256 }, 'model-three');
const selectionConfig = fixed(selection, 'frozen-selection'), twoConfig = fixed(two, 'model-two');
const sourcePaths = ['integrations/local-worker/audit-runner.mjs', 'integrations/local-worker/probe.mjs',
  'integrations/local-worker/policy-view.mjs', 'integrations/local-worker/semantic-state.mjs', 'integrations/local-worker/decision-domain.mjs',
  'integrations/local-worker/ppo-model.mjs', 'integrations/local-worker/card-action-model.mjs', 'integrations/local-worker/learning-model.mjs',
  'integrations/local-worker/card-action-policy.mjs', 'integrations/local-worker/learning-features.mjs',
  'learning/ppo_runtime.py', 'learning/masked_ppo.py', 'learning/card_action_torch.py', 'learning/native_torch.py', 'learning/card-action-features.mjs'];
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, fileHash(join(runtime, path))]));
for (const path of ['integrations/local-worker/learning-model.mjs', 'integrations/local-worker/learning-features.mjs', 'learning/native_torch.py'])
  if (fileHash(join(root, path)) !== sourceHashes[path]) throw new Error('local Model2 runtime must retain identical original source bytes');
for (const path of sourcePaths) {
  const target = join(output, 'source-snapshot', path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(runtime, path), target);
  if (fileHash(target) !== sourceHashes[path]) throw new Error('source changed during snapshot');
}
copyFileSync(fileURLToPath(import.meta.url), join(output, 'comparison-command.mjs'));
copyFileSync(inputs.decisions, join(output, 'helper-policy.mjs'));
save(join(output, 'protocol.json'), protocol); save(join(output, 'prepared.json'), prepared); save(join(output, 'native-config.json'), nativeConfig);
const checkpointPins = { modelThree: checkpointSha256, modelTwo: protocol.modelTwo.checkpointSha256, frozenSelection: prepared.selectionSha256 };
const assertFixed = () => {
  if (fileHash(checkpoint) !== checkpointPins.modelThree || fileHash(ppoConfig.checkpoint) !== checkpointPins.modelThree
      || fileHash(two.checkpoint) !== checkpointPins.modelTwo || fileHash(twoConfig.checkpoint) !== checkpointPins.modelTwo
      || fileHash(selection.checkpoint) !== checkpointPins.frozenSelection || fileHash(selectionConfig.checkpoint) !== checkpointPins.frozenSelection
      || fileHash(prepared.nativeConfig) !== prepared.nativeConfigSha256 || fileHash(inputs.decisions) !== nativeConfig.policySha256
      || sourcePaths.some(path => fileHash(join(runtime, path)) !== sourceHashes[path])) throw new Error('frozen comparison inputs changed');
};
const tasks = protocol.heldoutSeeds.flatMap(seed => protocol.casesPerSeed.map(role => ({ ...role, seed, id: `${seed}-${role.modelThreeSeat}` })));
const outcomes = [], sessions = [{}, {}], clients = [], started = Date.now(), deadline = started + 1200000;
let cursor = 0, cancellation = null;
const cancel = reason => { cancellation ??= reason; sessions.forEach(session => session.worker?.close()); clients.forEach(client => client.close()); };
const timer = setTimeout(() => cancel('global-wall-budget'), 1200000);
const interrupt = () => cancel('operator-interrupted'); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
async function reap(session) {
  const child = session.worker?.child; session.worker?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) await new Promise(accept => child.once('exit', accept));
}
async function lane(index) {
  const ppo = new PpoModelClient(ppoConfig), bc = new CardActionModelClient(selectionConfig), modelTwo = new NativeModelClient(twoConfig);
  clients.push(ppo, bc, modelTwo);
  try {
    const infos = await Promise.all([ppo.verify(), bc.verify(), modelTwo.verify()]);
    save(join(output, `lane-${index}-models.json`), infos);
    while (!cancellation && cursor < tasks.length && Date.now() < deadline) {
      const task = tasks[cursor++], directory = join(output, task.id); mkdirSync(directory);
      const before = [ppo.requests, bc.requests, modelTwo.requests];
      const counts = { modelThreeOrdinary: 0, modelThreeLearnedSelection: 0, modelThreeHelper: 0, modelTwoOrdinary: 0, modelTwoHelper: 0 };
      let outcome;
      try {
        assertFixed(); verifyLocalInputs(nativeConfig);
        const result = await runAuditedEpisode(nativeConfig, { seed: task.seed, seatOrder: task.seatOrder, session: sessions[index],
          maxCommands: 500, maxSeconds: Math.max(1, Math.min(240, Math.floor((deadline - Date.now()) / 1000))), boundaryEvery: 1, strictCommands: true,
          decideOrdinary: ({ seat, view }) => seat === task.modelThreeSeat ? ppo.decide({ view }) : modelTwo.decide({ view }),
          decidePrompt: async ({ seat, view }) => seat === task.modelThreeSeat && view.status === 'playing' && supportsCardSelection(view)
            ? rankedPromptAnswers(view, await bc.rankChoices({ view, prompt: view.prompts[0] })) : null,
          onFrame: ({ entry }) => appendFileSync(join(directory, 'progress.jsonl'), JSON.stringify(entry) + '\n'),
          onAcceptedDecision: ({ seat, view, decision, ordinaryPolicyUsed, promptPolicyUsed }) => {
            const source = seat === task.modelThreeSeat ? ordinaryPolicyUsed ? 'modelThreeOrdinary' : promptPolicyUsed ? 'modelThreeLearnedSelection' : 'modelThreeHelper'
              : ordinaryPolicyUsed ? 'modelTwoOrdinary' : 'modelTwoHelper';
            counts[source]++; appendFileSync(join(directory, 'decisions.jsonl'), JSON.stringify({ seat, source, view, decision }) + '\n');
          } });
        save(join(directory, 'journal.json'), result.journal);
        assertFixed();
        const summary = result.summary, checks = summary.boundaryChecks.filter(value => value.permutedSlots !== undefined);
        if (!summary.completedNaturally || summary.rejected || checks.length !== summary.commands * 2 || !checks.some(value => value.opponentHandExchanged)
            || !['human', 'opponent', null].includes(summary.winnerSeat)
            || !isDeepStrictEqual([ppo.requests - before[0], bc.requests - before[1], modelTwo.requests - before[2]],
              [counts.modelThreeOrdinary, counts.modelThreeLearnedSelection, counts.modelTwoOrdinary])) throw new Error('native completion/privacy/inference accounting failed');
        save(join(directory, 'case-receipt.json'), { ...summary, checkpointPins, counts });
        outcome = { ...task, status: 'completed', winnerSeat: summary.winnerSeat,
          modelThreeWin: summary.winnerSeat === null ? null : summary.winnerSeat === task.modelThreeSeat, counts,
          commands: summary.commands, terminalStateHash: summary.terminalStateHash, journalSha256: fileHash(join(directory, 'journal.json')) };
      } catch (error) {
        const closed = ['worker closed or request already pending', 'local worker closed', 'model service closed', 'PPO model closed', 'card/action model closed'].includes(error.message);
        const status = error.code === 'NATIVE_EPISODE_COMMAND_BUDGET' ? 'command-truncation' : error.code === 'NATIVE_EPISODE_TIME_BUDGET'
          || (closed && cancellation === 'global-wall-budget') ? 'capacity-timeout' : closed && cancellation ? 'cancelled' : 'fatal';
        outcome = { ...task, status, reason: error.message, code: error.code ?? null, counts };
        save(join(directory, 'failure.json'), outcome); await reap(sessions[index]); sessions[index] = {};
        if (status === 'fatal') cancel('fatal-peer');
      }
      outcomes.push(outcome); save(join(directory, 'outcome.json'), outcome); console.log(JSON.stringify(outcome));
    }
  } catch (error) { outcomes.push({ status: 'fatal', lane: index, reason: error.message }); cancel('fatal-peer'); }
  finally { await reap(sessions[index]); await Promise.all([ppo.shutdown(), bc.shutdown(), modelTwo.shutdown()]); }
}
try { await Promise.all([lane(0), lane(1)]); }
finally { clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
try { assertFixed(); verifyLocalInputs(nativeConfig); } catch (error) { outcomes.push({ status: 'fatal', phase: 'final-provenance', reason: error.message }); }
const unattempted = tasks.filter(task => !outcomes.some(outcome => outcome.id === task.id));
const receipt = { schema: 'model3-model2-head-to-head/1', complete: true, checkpointPins, sourceHashes, outcomes, unattempted,
  counts: { modelThreeWins: outcomes.filter(value => value.modelThreeWin === true).length, modelTwoWins: outcomes.filter(value => value.modelThreeWin === false).length,
    terminalWithoutWinner: outcomes.filter(value => value.status === 'completed' && value.modelThreeWin === null).length,
    commandTruncations: outcomes.filter(value => value.status === 'command-truncation').length, timeouts: outcomes.filter(value => value.status === 'capacity-timeout').length,
    cancelled: outcomes.filter(value => value.status === 'cancelled').length, fatalErrors: outcomes.filter(value => value.status === 'fatal').length, unattempted: unattempted.length },
  elapsedSeconds: (Date.now() - started) / 1000, stopReason: cancellation ?? 'eight-cases-finished',
  interpretation: 'Eight direct games; four paired seed clusters, substantial uncertainty. Unknown and incomplete outcomes are never losses or draws. Complete policy packages differ in selection helpers; no causal PPO-only or Elo claim.' };
save(join(output, 'receipt.json'), receipt); console.log(JSON.stringify(receipt.counts));
if (receipt.counts.fatalErrors) process.exitCode = 2;
