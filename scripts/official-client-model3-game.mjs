import { spawn } from 'node:child_process';
import { readFile, appendFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';
import { projectRuntimeMatch, chooseSetupAction, chooseTextPrompt } from '../integrations/official-client/runtime-policy.mjs';
import { agentPult } from '../integrations/official-client/compatibility.mjs';
import { PpoModelClient } from '../integrations/local-worker/ppo-model.mjs';
import { CardActionModelClient } from '../integrations/local-worker/card-action-model.mjs';
import { createDecisionRecording } from '../integrations/official-client/decision-recording.mjs';
import { createBattleLogRecorder } from '../integrations/official-client/battle-log.mjs';
import { encodeCardActionDecision, encodeCardChoiceDecision } from '../learning/card-action-features.mjs';

const root = resolve(import.meta.dirname, '..');
const sessionStartedAt = Date.now();
let driverRequestMilliseconds = 0;
const model4 = process.argv.includes('--model4'), candidate = model4 ? 'model4' : 'model3';
const mode = process.argv.slice(2).filter(value => value !== '--model4').join(' '), resume = mode === '--resume-built-in-ai --arm --step';
if (!resume && mode !== '--one-built-in-ai --arm --step') throw new Error('explicit-single-ai-step-required');
const config = JSON.parse(await readFile(join(root, '.cache/client-ui-config.json')));
const frozen = JSON.parse(await readFile(join(root, '.cache/official-client-frozen-config.json')));
const localFile = key => {
 if (typeof frozen[key] !== 'string' || !frozen[key]) throw new Error('explicit-frozen-local-file-required:' + key);
 return resolve(root, frozen[key]);
};
const modelConfig = JSON.parse(await readFile(localFile(model4 ? 'model4Config' : 'model3Config')));
const selectionConfig = JSON.parse(await readFile(localFile('selectionConfig')));
const sha = value => createHash('sha256').update(value).digest('hex');
const checkpointSha256 = model4 ? '38a6e726d528d8de3cc9924285c8d67c2700a8dde1cb64f6e388d99ae37ce8b5' : '8a2a98a8dad933cf5a1d273d89ccc3e54c99b5ed686edc4238e7b1dd6188828b';
if (sha(await readFile(modelConfig.checkpoint)) !== checkpointSha256
 || sha(await readFile(selectionConfig.checkpoint)) !== '6d3a5510e36a17610de6cbd099a3deac5a3efde02181213358b49ecab65afff2') throw new Error('frozen-model3-hash-mismatch');
const frozenHelperFile = localFile('frozenHelper');
if (sha(await readFile(frozenHelperFile)) !== '40acf530ca787caaf446f515173b1ed0fd9cd6353e8313f44ac015d705d288b1') throw new Error('frozen-native-helper-hash-mismatch');
const { livePracticeDecisions: frozenPromptHelper } = await import(pathToFileURL(frozenHelperFile));
const latestFile = join(root, `.cache/${candidate}-live-latest.json`);
const prior = resume ? JSON.parse(await readFile(latestFile)) : null;
const id = prior?.id ?? randomUUID(), folder = join(root, '.cache', `${candidate}-live-${id}`);
if (prior && prior.folder !== folder) throw new Error('owned-model3-folder-required');
if (!resume) await mkdir(folder);
await writeFile(latestFile, JSON.stringify({ id, folder, candidate }));
const log = async value => { const event = { at: Date.now(), ...value }; await appendFile(join(folder, 'events.jsonl'), JSON.stringify(event) + '\n'); process.stdout.write(JSON.stringify(event) + '\n'); };
const corpus = (await readFile(localFile('cardCorpus'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const sources = new Map(corpus.map(card => [card.cardSourceID, card]));
const deckBundle = JSON.parse(await readFile(localFile('deckBundle')));
const deckRows = Object.values(deckBundle).flatMap(value => value.sourceRows ?? []);
const rows = deckRows.filter(value => value?.cardSourceID && value?.printingId);
if (!rows.length) throw new Error('native-printing-map-missing');
const ignored = new Set(['cardSourceID', 'logicSourceID', 'releaseDate', 'actionGuid']);
const mechanics = value => Array.isArray(value) ? value.map(mechanics) : value && typeof value === 'object'
 ? Object.fromEntries(Object.keys(value).filter(key => !ignored.has(key)).sort().map(key => [key, mechanics(value[key])])) : value;
const signature = value => sha(JSON.stringify(mechanics(value)));
const canonical = new Map();
for (const row of rows) { const card = sources.get(row.cardSourceID); if (card) canonical.set(signature(card), row); }
const lookup = source => sources.get(source) ?? sources.get(source.replace(/_(?:m?ph)\d*$/, ''));
const normalized = new Map();
const rowFor = source => {
 if (!normalized.has(source)) { const card = lookup(source); normalized.set(source, card ? canonical.get(signature(card)) ?? null : null); }
 return normalized.get(source);
};
const mapping = { printing: card => rowFor(card.source)?.printingId ?? card.source,
 definition: source => rowFor(source)?.cardSourceID ?? source.replace(/_(?:m?ph)\d*$/, '') };
const pinFiles = {
 encoder: 'learning/card-action-features.mjs', baseEncoder: 'integrations/local-worker/learning-features.mjs',
 actorProjection: 'integrations/local-worker/policy-view.mjs', runtimeProjection: 'integrations/official-client/runtime-policy.mjs',
 ordinaryLoader: model4 ? 'integrations/local-worker/card-action-model.mjs' : 'integrations/local-worker/ppo-model.mjs',
 selectionLoader: 'integrations/local-worker/card-action-model.mjs',
 ordinaryRuntime: model4 ? 'learning/card_action_torch.py' : 'learning/ppo_runtime.py',
 runtimeAgent: 'integrations/official-client/runtime-agent.js', runtimeDriver: 'scripts/official-client-runtime.py',
 controller: 'scripts/official-client-model3-game.mjs', recordingContract: 'integrations/official-client/decision-recording.mjs',
 battleLogContract: 'integrations/official-client/battle-log.mjs',
};
const pins = { ordinaryCheckpointSha256: checkpointSha256, selectionCheckpointSha256: sha(await readFile(selectionConfig.checkpoint)),
 helperSha256: sha(await readFile(frozenHelperFile)), ordinaryConfigSha256: sha(JSON.stringify(modelConfig)), selectionConfigSha256: sha(JSON.stringify(selectionConfig)),
 inferencePolicy: { ordinarySeed: modelConfig.seed ?? 1729, selectionSeed: selectionConfig.seed ?? 1729,
  ordinaryDeterministic: true, selection: 'rank-all-then-existing-group-resolution' },
 cardCorpusSha256: sha(await readFile(localFile('cardCorpus'))), deckBundleSha256: sha(await readFile(localFile('deckBundle'))),
 featureContract: { schema: 'native-card-action-features/1', stateDimensions: 224, candidateDimensions: 191 },
 sourceSha256: Object.fromEntries(await Promise.all(Object.entries(pinFiles).map(async ([key, file]) => [key, sha(await readFile(join(root, file)))]))) };
const recording = await createDecisionRecording(folder, { gameId: id, candidate, pins });
const battleLogOutput = join(folder, `private-battle-log-latest-${recording.sessionId}.json`);
const battleLogRecorder = await createBattleLogRecorder(folder, join(folder, `private-battle-log-${recording.sessionId}`));
const model = model4 ? new CardActionModelClient(modelConfig) : new PpoModelClient(modelConfig), selection = new CardActionModelClient(selectionConfig);
let preObservationId = null, proposedDecisionId = null, decisionTrace = null;
let terminalEvidence = { status: 'not-observed', finalReason: null, unknowns: ['terminal export not yet requested'] };
const projector = new PolicyView();
const child = spawn(config.python, [join(root, 'scripts/official-client-runtime.py'), '--pid', String(config.processId), '--window', String(config.windowId),
 '--permit-scoped-adapter', '--permit-input-probe', '--supervised-test-game', '--battle-log-output', battleLogOutput, '--battle-log-terminal-only',
 ...(resume ? ['--resume-owned-test-game'] : [])], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', waiting, sequence = 0, readyAccept, readyReject;
const ready = new Promise((accept, reject) => { readyAccept = accept; readyReject = reject; });
child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {});
function fail(error) { readyReject(error); if (waiting) { clearTimeout(waiting.timer); waiting.reject(error); waiting = null; } }
child.on('error', () => fail(new Error('runtime-unavailable'))); child.on('exit', () => fail(new Error('runtime-ended')));
child.stdin.on('error', () => fail(new Error('runtime-input-ended')));
child.stdout.on('data', chunk => {
 buffer += chunk;
 if (buffer.length > 2000000) { fail(new Error('runtime-response-budget')); child.kill(); return; }
 let end;
 while ((end = buffer.indexOf('\n')) >= 0) {
  const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
  try { const value = JSON.parse(line);
   if (value.schema === 'official-client-runtime-ready/1') { readyAccept(value); continue; }
   if (value.ok === false) throw new Error(`runtime-${value.stage}-${value.error}`);
   if (!waiting || waiting.id !== value.id) throw new Error('runtime-uncorrelated-reply');
   const pending = waiting; waiting = null; clearTimeout(pending.timer);
   if (!value.ok) pending.reject(new Error(`runtime-${value.stage}-${value.error}`)); else pending.accept(value);
  } catch (error) { fail(error); }
 }
});
async function request(op, values = {}, decisionId = null) {
 if (waiting) throw new Error('runtime-request-pending');
 const requestStartedAt = performance.now();
 const requestId = `model3-${++sequence}`;
 const payload = { id: requestId, op, ...values, ...(!['observe', 'close', 'battle_log'].includes(op) ? { armed: true, step: requestId } : {}) };
 if (decisionId) await recording.dispatch(decisionId, payload);
 let response;
 try {
 response = await new Promise((accept, reject) => {
  const timer = setTimeout(() => { fail(new Error('runtime-timeout-uncertain-no-retry')); child.kill(); }, 10000);
  waiting = { id: requestId, accept, reject, timer };
  child.stdin.write(JSON.stringify(payload) + '\n');
 });
 } catch (error) {
  if (decisionId) await recording.result(decisionId, { status: 'request-failed', errorCode: error.message, execution: 'uncertain; do not replay automatically', executionVerified: false });
  throw error;
 } finally { driverRequestMilliseconds += performance.now() - requestStartedAt; }
 // A journal failure after a returned action is not a runtime request failure.
 if (decisionId) await recording.result(decisionId, { status: 'returned', response, executionVerified: false });
 return response;
}
const delay = ms => new Promise(accept => setTimeout(accept, ms));
const stats = { ordinaryDecisions: 0, selectionDecisions: 0, helperDecisions: 0, evolutionOpportunities: 0, evolutionIntents: 0,
 phantomDiveIntents: 0, transitions: 0, rejectedActions: 0, gameLaunches: 0, previousSampleLeft: false };
let revision = 0, lastHash, pending = null, outcome = 'incomplete', winner = null, launchedAt = null, failure = null, stopped = false;
async function checkKill() { for (const marker of ['official-client-input.kill', 'official-client-runtime.kill', 'official-client.kill']) {
 try { await access(join(root, '.cache', marker)); throw new Error('user-paused'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
} }
async function observe() {
 await checkKill(); const response = await request('observe');
 await appendFile(join(folder, 'private-observations.jsonl'), JSON.stringify({ at: Date.now(), ...response }) + '\n');
 if (response.snapshotHash !== lastHash) { lastHash = response.snapshotHash; revision++; }
 preObservationId = await recording.observe(response, { revision, afterDecisionId: pending?.decisionId ?? null });
 return response;
}
async function captureTerminalEvidence(observation) {
 // Disarm before the bounded read-only terminal capture. Preserve human stops.
 try { await writeFile(join(root, '.cache/official-client-input.kill'), `session-ended:${id}\n`, { flag: 'wx' }); }
 catch (error) { if (error.code !== 'EEXIST') throw error; }
 let lastExport = null;
 try {
  for (let attempt = 0; attempt < 3; attempt++) {
   await checkKillForTerminalRead();
   await request('battle_log');
   const value = JSON.parse(await readFile(battleLogOutput, 'utf8'));
   await battleLogRecorder.record(value); lastExport = value;
   if (value.terminalReason?.status === 'observed') break;
   await delay(200);
  }
  terminalEvidence = { status: 'recorded', battleLogReceipt: battleLogRecorder.receipt(),
   exportSha256: sha(JSON.stringify(lastExport)), finalReason: lastExport?.terminalReason ?? observation.result.terminalReason ?? observation.result.match?.finalReason ?? null,
   unknowns: lastExport?.terminalReason?.status === 'observed' ? [] : ['displayed final reason not observed; no inference from deck/prize counters'] };
 } catch (error) {
  terminalEvidence = { status: lastExport ? 'partial' : 'unavailable', errorCode: error.message,
   battleLogReceipt: battleLogRecorder.receipt(), finalReason: lastExport?.terminalReason ?? observation.result.terminalReason ?? observation.result.match?.finalReason ?? null,
   unknowns: ['terminal capture incomplete; game outcome alone does not establish final reason'] };
 }
 await recording.terminal({ observationId: preObservationId, outcome, winner,
  evidence: terminalEvidence, trainingEligible: false });
}
async function checkKillForTerminalRead() {
 for (const marker of ['official-client.kill', 'official-client-runtime.kill']) {
  try { await access(join(root, '.cache', marker)); throw new Error('terminal-read-paused'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
 }
 const marker = await readFile(join(root, '.cache/official-client-input.kill'), 'utf8');
 if (marker !== `session-ended:${id}\n`) throw new Error('terminal-read-human-pause-preserved');
}
function verifyDeck(deck) {
 if (deck?.displayName !== 'AgentPult' || !deck.standardValid || !deck.testDeckInteractable || !deck.exactCards) throw new Error('agent-pult-not-ready');
 const names = new Map();
 const name = value => ({ 'Basic {R} Energy': 'Fire Energy', 'Basic {D} Energy': 'Darkness Energy', 'Basic {P} Energy': 'Psychic Energy' })[value] ?? value;
 for (const [source, count] of Object.entries(deck.exactCards)) {
  const card = lookup(source); if (!card || !rowFor(source)) throw new Error('loaded-card-mechanics-not-in-training-profile');
  names.set(name(card.cardName), (names.get(name(card.cardName)) ?? 0) + count);
 }
 if (Object.values(deck.exactCards).reduce((a,b) => a+b,0) !== 60 || agentPult.cards.some(card => names.get(card.name) !== card.count) || names.size !== agentPult.cards.length)
  throw new Error('exact-agent-pult-composition-mismatch');
}
async function chooseEntities(value) {
 const prompt = value.match.prompt;
 if (prompt.selectionMethod === 8) throw new Error('allocation-prompt-requires-mapping');
 const raw = projectRuntimeMatch({ ...value, match: { ...value.match, menu: null, operationProcessing: false, actions: [] } }, sources, revision, mapping);
 const kind = [3,13].includes(prompt.selectionMethod) ? 'pokemon' : prompt.selectionMethod === 9 ? 'prizes' : 'cards';
 raw.prompts = [{ id: 'visible-card-prompt', kind, min: prompt.min, max: prompt.max, cancelable: false, ordered: false,
  groups: prompt.groups.map(group => ({ id: group.id, min: group.min, max: group.max })),
  choices: prompt.groups.flatMap(group => group.choices.map(choice => ({ id: choice.id, group: group.id,
   card: { instanceId: choice.identity, printingId: mapping.printing(choice), category: choice.category }, instanceId: choice.identity }))) }];
 const view = projector.project(raw), projected = view.prompts[0];
 if (!projected.choices.length) {
  const answer = [...frozenPromptHelper(view)][0];
  if (!answer || answer.choiceIds.length) throw new Error('empty-visible-options-cannot-meet-minimum');
  stats.helperDecisions++;
  decisionTrace = { kind: 'helper', actorKind: 'helper', policyInput: view, decision: answer };
  return { choiceIds: projector.resolve(answer).choiceIds, label: 'Confirm empty visible-card search', policy: 'frozen-native-teacher-empty-prompt' };
 }
 const ranking = await selection.rankChoices({ view });
 const choices = ranking.map(index => projected.choices[index]), picked = [], identities = new Set();
 for (const group of projected.groups) {
  for (const choice of choices.filter(choice => choice.group === group.id)) {
   if (picked.filter(item => item.group === group.id).length >= group.max || picked.length >= projected.max) break;
   if (!prompt.reparent && identities.has(choice.card.instanceId)) continue;
   picked.push(choice); identities.add(choice.card.instanceId);
  }
  if (picked.filter(item => item.group === group.id).length < group.min) throw new Error('model-selection-group-unsatisfied');
 }
 if (picked.length < projected.min) throw new Error('model-selection-total-unsatisfied');
 const resolved = projector.resolve({ promptId: projected.id, choiceIds: picked.map(choice => choice.id) });
 decisionTrace = { kind: 'selection', actorKind: 'model', policyInput: view,
  encodedInput: encodeCardChoiceDecision(view, projected, { printingAliases: selectionConfig.printingAliases }),
  decision: { promptId: projected.id, choiceIds: picked.map(choice => choice.id) }, ranking };
 stats.selectionDecisions++;
 return { choiceIds: resolved.choiceIds, label: 'Select ' + resolved.choiceIds.map(id => prompt.groups.flatMap(group => group.choices).find(choice => choice.id === id).name).join(', ') };
}
try {
 const runtimeReady = await ready;
 await recording.note({ runtimeContract: { admittedReadOperations: runtimeReady.admittedReadOperations,
  terminalUiCaptureAvailable: runtimeReady.terminalUiCaptureAvailable === true } });
 const ordinaryInfo = await model.verify(), selectionInfo = await selection.verify();
 const contractInfo = info => Object.fromEntries(['schema', 'stateDim', 'candidateDim', 'contractSha256', 'device', 'samplingSeed', 'checkpointSha256', 'frozenSelectionSha256', 'printingAliases'].filter(key => info[key] !== undefined).map(key => [key, info[key]]));
 await recording.note({ ordinaryContract: contractInfo(ordinaryInfo), selectionContract: contractInfo(selectionInfo) });
 await log({ event: 'model-ready', model: model4 ? 'frozen-model4-bc' : 'frozen-model3-ppo-039', checkpointSha256, stateDimensions: 224, candidateDimensions: 191 });
 let observation = await observe();
 if (resume) {
  const previous = JSON.parse(await readFile(join(folder, 'receipt.json'))), launch = JSON.parse(await readFile(join(folder, 'launch-intent.json')));
  if (launch.id !== id || previous.gameLaunches !== 1 || !observation.result.match?.offline || observation.result.match.gameOver) throw new Error('same-owned-model3-game-required');
  for (const key of Object.keys(stats)) stats[key] = previous[key];
  launchedAt = launch.launchedAt;
  await log({ event: 'same-ai-game-resumed', gameAttempts: 1, repair: 'visible active-promotion mapping' });
 } else {
 if (observation.result.match) {
  if (!observation.result.match.offline || observation.result.match.gameOver) throw new Error('previous-match-not-active-owned-ai');
  await log({ event: 'leave-previous-interrupted-diagnostic-sample', excludedFromQualification: true });
  await request('leave_previous_test', { expected: observation.snapshotHash }); stats.previousSampleLeft = true;
  const deadline = Date.now() + 60000;
  do { await delay(2200); observation = await observe(); } while (observation.result.match && Date.now() < deadline);
  if (observation.result.match) throw new Error('previous-sample-exit-timeout');
 }
 if (observation.result.screen?.code === 0) {
  await request('open_decks', { expected: observation.snapshotHash }); await delay(2400); observation = await observe();
 }
 if (observation.result.screen?.code !== 1) throw new Error('decks-screen-not-present');
 verifyDeck(observation.result.selectedDeck);
 await writeFile(join(folder, 'private-selected-deck.json'), JSON.stringify(observation.result.selectedDeck));
 await log({ event: 'deck-ready', displayName: 'AgentPult', cards: 60, mechanicsVerifiedAgainstFrozenProfile: true });
 await writeFile(join(folder, 'launch-intent.json'), JSON.stringify({ id, mode: 'provided-ai', launchedAt: Date.now() }), { flag: 'wx' });
 launchedAt = Date.now(); stats.gameLaunches++;
 await writeFile(join(root, '.cache/official-client-test-game-attempt.json'), JSON.stringify({ id, mode: 'provided-ai', startedAt: launchedAt / 1000, candidate }));
 await request('start_test_deck', { expected: observation.snapshotHash });
 await log({ event: 'ai-game-launch-sent', gameAttempts: 1 });
 }
 let progressAt = Date.now();
 while (Date.now() - launchedAt < 1700000) {
  await delay(2200); const oldHash = lastHash; observation = await observe(); const value = observation.result;
  if (lastHash !== oldHash) progressAt = Date.now();
  if (!value.match) {
   if (value.terminalReason?.terminalObserved === true && typeof value.terminalReason.localWon === 'boolean') {
    outcome = 'completed'; winner = value.terminalReason.localWon ? 'you' : 'opponent';
    if (pending) await recording.link(pending.decisionId, preObservationId, 'terminal-ui-observed');
    pending = null; proposedDecisionId = null;
    await captureTerminalEvidence(observation);
    await log({ event: 'game-finished', winner, outcomeSource: 'terminal-ui-presentation', elapsedSeconds: (Date.now()-launchedAt)/1000, ...stats }); break;
   }
   if (Date.now() - launchedAt < 45000) continue; throw new Error('match-disappeared-without-result');
  }
  if (!value.match.offline) throw new Error('non-ai-match-rejected');
  if (value.match.gameOver) {
   outcome = 'completed'; winner = value.match.winner;
   if (pending) await recording.link(pending.decisionId, preObservationId, 'terminal-observation');
   pending = null; proposedDecisionId = null;
   await captureTerminalEvidence(observation);
   await log({ event: 'game-finished', winner, elapsedSeconds: (Date.now()-launchedAt)/1000, terminalExportStatus: terminalEvidence.status, ...stats }); break;
  }
  if (pending) {
   if (observation.snapshotHash !== pending.hash && (!value.match.operationProcessing || value.match.prompt || value.match.acknowledgement)) {
    stats.transitions++; await recording.link(pending.decisionId, preObservationId, 'subsequent-state-observed');
    await log({ event: 'transition-observed', policy: pending.policy, label: pending.label }); pending = null; proposedDecisionId = null;
   } else { if (Date.now() - pending.at > 60000) throw new Error('action-transition-timeout'); continue; }
  }
  if (Date.now() - progressAt > 90000) throw new Error(value.match.isMyTurn ? 'policy-no-progress-timeout' : 'opponent-client-no-progress-timeout');
  let op, data, policy, label;
  decisionTrace = null;
  if (value.match.acknowledgement === 'mulligan-done') {
   op = 'acknowledge_mulligan'; data = {}; policy = 'client-driver'; label = 'Acknowledge mulligan display';
   decisionTrace = { kind: 'driver', actorKind: 'driver', policyInput: null, decision: { acknowledgement: value.match.acknowledgement } };
  } else if (value.match.prompt) {
   if (value.match.prompt.kind === 'allocation') {
    const prompt = value.match.prompt;
    const raw = projectRuntimeMatch({ ...value, match: { ...value.match, menu: null, operationProcessing: false, actions: [] } }, sources, revision, mapping);
    raw.prompts = [{ id: 'visible-damage-allocation', kind: 'allocation', min: prompt.min, max: prompt.max, cancelable: false, ordered: false,
      groups: prompt.groups, allocationUnit: prompt.allocationUnit, allocationMode: 'final', choices: prompt.choices.map(choice => ({
       id: choice.id, group: choice.group, instanceId: choice.identity, card: { instanceId: choice.identity, printingId: mapping.printing(choice), category: choice.category },
       minAmount: choice.minAmount, maxAmount: choice.maxAmount, initialAmount: choice.initialAmount })) }];
    const view = projector.project(raw), answer = [...frozenPromptHelper(view)][0];
    if (!answer?.amounts) throw new Error('frozen-helper-no-allocation-answer');
    decisionTrace = { kind: 'helper', actorKind: 'helper', policyInput: view, decision: answer };
    data = { amounts: projector.resolve(answer).amounts }; op = 'answer_allocation'; label = 'Apply frozen helper damage allocation'; policy = 'frozen-native-teacher-allocation'; stats.helperDecisions++;
   } else if (value.match.prompt.kind === 'prizes') {
    const prompt = value.match.prompt;
    const raw = projectRuntimeMatch({ ...value, match: { ...value.match, menu: null, operationProcessing: false, actions: [] } }, sources, revision, mapping);
    raw.prompts = [{ id: 'opaque-prizes', kind: 'prizes', min: prompt.min, max: prompt.max, cancelable: false, ordered: false, groups: [], choices: prompt.choices }];
    const view = projector.project(raw), answer = [...frozenPromptHelper(view)][0];
    if (!answer) throw new Error('frozen-helper-no-prize-answer');
    decisionTrace = { kind: 'helper', actorKind: 'helper', policyInput: view, decision: answer };
    data = { choiceIds: projector.resolve(answer).choiceIds }; op = 'answer_prizes'; label = `Take ${data.choiceIds.length} face-down prize slot(s)`;
    policy = 'frozen-native-teacher-opaque-prizes'; stats.helperDecisions++;
   } else if (value.match.prompt.kind === 'entities') { const answer = await chooseEntities(value); op = 'answer_entities'; data = { choiceIds: answer.choiceIds }; label = answer.label; policy = answer.policy ?? 'frozen-model3-bc-selection'; }
   else { const answer = chooseTextPrompt(value.match.prompt); op = 'answer_text'; data = { choiceId: answer.choiceId }; label = value.match.prompt.choices.find(choice => choice.id === answer.choiceId).label; policy = answer.attribution.id; stats.helperDecisions++;
    decisionTrace = { kind: 'helper', actorKind: 'helper', policyInput: { prompt: value.match.prompt }, decision: answer }; }
  } else if (value.match.uiTransitionPending) continue;
  else if (value.match.menu) throw new Error('unsupported-visible-prompt:' + value.match.menu);
  else if (value.match.operationProcessing || !value.match.actions.length) continue;
  else {
   const raw = projectRuntimeMatch(value, sources, revision, mapping); let selected;
   if (raw.status === 'setup') { const answer = chooseSetupAction(raw); selected = raw.actions.find(action => action.id === answer.actionId); policy = answer.attribution.id; stats.helperDecisions++;
    decisionTrace = { kind: 'helper', actorKind: 'helper', policyInput: raw, decision: answer }; }
   else {
    if (raw.turn !== 'you') continue;
    const view = projector.project(raw), decision = await model.decide({ view });
    decisionTrace = { kind: 'ordinary', actorKind: 'model', policyInput: view,
      encodedInput: encodeCardActionDecision(view, null, { printingAliases: modelConfig.printingAliases }), decision };
    selected = raw.actions.find(action => action.id === projector.resolve(decision).actionId);
    if (!selected) throw new Error('model-choice-not-legal');
    stats.ordinaryDecisions++; policy = model4 ? 'model4-frozen-bc' : 'model3-frozen-ppo';
    const evolved = raw.actions.filter(action => action.label.startsWith('Evolve '));
    if (evolved.length) stats.evolutionOpportunities++;
    if (selected.label.startsWith('Evolve ')) stats.evolutionIntents++;
    if (selected.attackName === 'Phantom Dive') stats.phantomDiveIntents++;
    await appendFile(join(folder, 'private-policy-decisions.jsonl'), JSON.stringify({ at: Date.now(), view, decision, selectedLabel: selected.label }) + '\n');
   }
   op = 'act'; data = { actionId: selected.id }; label = selected.label;
  }
  if (!decisionTrace) throw new Error('decision-recording-context-missing');
  proposedDecisionId = await recording.propose({ ...decisionTrace, preObservationId,
    attribution: { kind: decisionTrace.actorKind, id: policy, pinsRef: recording.sessionId },
    resolvedDecision: { op, data }, offered: { actions: value.match.actions, prompt: value.match.prompt, acknowledgement: value.match.acknowledgement } });
  await log({ event: 'proposed', policy, label });
  try { await request(op, { expected: observation.snapshotHash, data }, proposedDecisionId); } catch (error) { stats.rejectedActions++; throw error; }
  pending = { hash: observation.snapshotHash, at: Date.now(), policy, label, decisionId: proposedDecisionId };
 }
 if (outcome !== 'completed') throw new Error('single-game-time-budget');
} catch (error) {
 failure = error.message; process.exitCode = 2;
 await log({ event: 'paused', reason: failure, result: outcome, ...stats });
} finally {
 // Stopping the owned runtime must not depend on journal/receipt availability.
 const cleanupErrors = [];
 const cleanup = async (name, action) => { try { await action(); } catch { cleanupErrors.push(name); process.exitCode = 2; } };
 for (const marker of ['official-client-input.kill', 'official-client-runtime.kill']) {
  await cleanup(marker, async () => {
   try { await writeFile(join(root, '.cache', marker), `session-ended:${id}\n`, { flag: 'wx' }); }
   catch (error) { if (error.code !== 'EEXIST') throw error; } // Preserve a human stop.
  });
 }
 if (waiting) { clearTimeout(waiting.timer); waiting = null; }
 await cleanup('runtime-input-close', async () => child.stdin.end());
 await cleanup('runtime-stop', async () => {
  if (child.exitCode === null && child.signalCode === null) {
   await delay(400);
   if (child.exitCode === null && child.signalCode === null) { child.kill(); await delay(400); }
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error('runtime-exit-unconfirmed');
 });
 const modelStops = await Promise.allSettled([model.shutdown(), selection.shutdown()]);
 stopped = child.exitCode !== null || child.signalCode !== null;
 if (modelStops.some(value => value.status === 'rejected')) { cleanupErrors.push('model-stop'); process.exitCode = 2; }
 await cleanup('decision-final-link', async () => {
  if (pending?.decisionId || proposedDecisionId) await recording.link(pending?.decisionId ?? proposedDecisionId, preObservationId, 'unresolved-at-session-end');
 });
 await cleanup('decision-terminal', async () => {
  if (outcome !== 'completed') await recording.terminal({ observationId: preObservationId, outcome, failure, evidence: terminalEvidence, trainingEligible: false });
 });
 const sessionEndedAt = Date.now();
 const timing = { sessionStartedAt, sessionEndedAt, driverRequestMilliseconds,
  modelInferenceMilliseconds: model.inferenceMilliseconds + selection.inferenceMilliseconds,
  note: 'Session includes gameplay/animation waits; repair gaps occur between session records. Inference is measured separately. Earlier diagnostic sessions predate timing instrumentation.' };
 await cleanup('timing-write', () => appendFile(join(folder, 'timing-sessions.jsonl'), JSON.stringify(timing) + '\n'));
 await cleanup('battle-log-close', () => battleLogRecorder.close());
 await cleanup('decision-recording-close', () => recording.close());
 await cleanup('receipt-write', () => writeFile(join(folder, 'receipt.json'), JSON.stringify({ schema: 'official-client-frozen-game/1', candidate, checkpointSha256, id, outcome, winner, failure,
  elapsedSeconds: launchedAt ? (Date.now()-launchedAt)/1000 : null, timing, ...stats, recordingSessionId: recording.sessionId,
  terminalEvidence: { status: terminalEvidence.status, finalReasonObserved: terminalEvidence.finalReason?.status === 'observed', rawTextIncluded: false }, frozenCheckpointChanged: false,
  focusActivationCalls: 0, sharedInputCalls: 0, publicMatchmakingCalls: 0, rawLogsPrivate: true, inputStopped: stopped,
  recordingComplete: cleanupErrors.length === 0, cleanupErrors }, null, 2)));
 await cleanup('final-event-write', () => log({ event: 'detached-and-paused', evidenceFolder: folder, inputStopped: stopped, cleanupErrors }));
}
