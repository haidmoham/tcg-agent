// Offline, human-offer-only admission. Never copy generic acceptance receipts:
// opponent receipts can contain the opponent actor's private hand.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {pathToFileURL} from 'node:url';

const [configFile, directory, eventsSha, manifestSha, target] = process.argv.slice(2);
if (!target || process.argv.length !== 7) throw Error('usage: prepare-human-bc <config> <game> <events-sha> <manifest-sha> <fresh-output>');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const require = (value, reason) => { if (!value) throw Error(reason); };
const config = read(configFile), manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json')),
  eventsBytes = fs.readFileSync(path.join(directory, 'events.jsonl')), manifest = JSON.parse(manifestBytes);
require(hash(manifestBytes) === manifestSha && hash(eventsBytes) === eventsSha, 'owner-verified-journal-pins-required');
require(manifest.schema === 'human-demonstration-manifest/1' && manifest.provenance === 'human'
  && manifest.eligibleForPpo === false && manifest.pinsSha256 === hash(JSON.stringify(manifest.pins)), 'real-human-manifest-required');
require(manifest.pins.checkpointSha256 === config.checkpointSha256
  && equal(manifest.pins.privateInputs, config.pins) && equal(manifest.pins.deckSha256, config.deckSha256)
  && equal(manifest.pins.seatOrder, ['human', 'opponent']), 'session-config-pins-mismatch');
for (const [relative, sha] of Object.entries(config.pins))
  require(hash(fs.readFileSync(path.join(config.pinRoot, relative))) === sha, 'changed-private-input:' + relative);
const events = eventsBytes.toString('utf8');
require(events.endsWith('\n') && eventsBytes.length < 128 * 1024 * 1024, 'complete-bounded-journal-required');
const rows = events.trimEnd().split('\n').map(JSON.parse);
rows.forEach((row, index) => require(row.schema === 'human-demonstration-event/1' && row.gameId === manifest.gameId
  && row.sequence === index && row.pinsSha256 === manifest.pinsSha256, 'contiguous-pinned-human-journal-required'));
const endings = rows.filter(row => row.type === 'game-ended'), ending = endings[0];
require(endings.length === 1 && ending.interruptionStatus === 'completed' && ending.reason === 'native-terminal'
  && rows.slice(ending.sequence + 1).every(row => row.type === 'human-visible-after-command'), 'closed-natural-journal-required');
const features = await import(pathToFileURL(path.join(config.runtimeRoot, 'learning/model6-features.mjs')));
const catalogBytes = fs.readFileSync(config.model.catalogPath), catalog = JSON.parse(catalogBytes);
require(hash(catalogBytes) === config.model.catalogSha256 && features.model6ContractSha256 === manifest.pins.contractSha256,
  'catalog-or-feature-pin-mismatch');
const offers = new Map(rows.filter(r => r.type === 'human-decision-offered' && r.actor === 'human' && r.seat === 0).map(r => [r.decisionId, r]));
const submissions = rows.filter(r => r.type === 'human-submitted' && r.actor === 'human');
const results = new Map(rows.filter(r => r.type === 'decision-result' && r.actor === 'human').map(r => [r.submissionId, r]));
const resolutions = new Map(rows.filter(r => r.type === 'decision-resolved' && r.actor === 'human').map(r => [r.submissionId, r]));
const encodedKeys = ['schema','kind','globals','entities','entityCardIds','entityParents','candidates','candidateSources',
  'candidateTargets','candidateActors','candidateActionIds','originActionId','originSourceIndex','energyEntities','energyCandidates',
  'energyAttacks','energyAttackEntities','energyAttackActionIds','energyCandidateAttacks','energyCandidateAttackCandidates','energyCandidateAttackActionIds'];
const training = [], retainedSelections = [], observations = [], skipped = [], coverage = {};
let accepted = 0, exactEncodings = 0;
for (const submission of submissions) {
  const result = results.get(submission.submissionId), offer = offers.get(submission.decisionId), resolved = resolutions.get(submission.submissionId);
  const skip = reason => skipped.push({submissionId: submission.submissionId, decisionId: submission.decisionId, reason});
  if (result?.acceptance !== 'accepted') { skip('rejected-or-uncertain'); continue; }
  accepted++;
  require(offer && resolved && submission.behaviorSource === 'human' && submission.behaviorLogProbability === null
    && submission.eligibleForPpo === false && submission.observationHash === offer.observationHash
    && result.imitationLabelEligible === true && result.rawSemanticLabelComplete === true
    && result.nativeReceipt?.status === 'accepted' && result.nativeReceipt.commandId === resolved.commandId
    && equal(result.resolvedArguments, resolved.resolvedArguments), 'unbound-human-label');
  require(hash(JSON.stringify({rawObservation: offer.rawObservation, view: offer.projectedObservation,
    presentation: offer.playerVisiblePresentation})) === offer.observationHash, 'human-observation-digest-mismatch');
  require(offer.rawObservation.opponent?.hand == null && offer.projectedObservation.opponent?.hand == null,
    'opponent-private-faces-in-human-observation');
  // Explicit whitelist: no result.nativeReceipt.view, model offer or model observation.
  observations.push({gameId: manifest.gameId, decisionId: offer.decisionId, submissionId: submission.submissionId,
    observationHash: offer.observationHash, rawObservation: offer.rawObservation, projectedObservation: offer.projectedObservation,
    playerVisiblePresentation: offer.playerVisiblePresentation, encodedContract: offer.encodedContract,
    orderedCandidates: offer.orderedCandidates, candidateMask: offer.candidateMask, promptContext: offer.promptContext,
    selectedSemanticAction: submission.selectedSemanticAction, selectedCandidateIndices: result.selectedCandidateIndices,
    resolvedArguments: resolved.resolvedArguments, nativeCommandId: resolved.commandId, acceptance: 'accepted',
    behaviorLogProbability: null, eligibleForPpo: false});
  if (!offer.encodedInput) { skip('unencoded'); continue; }
  require(offer.encodedContract.sha256 === features.model6ContractSha256
    && equal(features.encodeModel6Decision(offer.projectedObservation, {catalog}), offer.encodedInput), 'human-encoding-changed');
  exactEncodings++;
  if (result.currentEncoderLabelEligible !== true) { skip('unsupported-categorical-label'); continue; }
  const indices = result.selectedCandidateIndices, candidates = offer.orderedCandidates;
  require(indices.length === 1 && Number.isSafeInteger(indices[0]) && indices[0] >= 0 && indices[0] < candidates.length
    && candidates.length === offer.encodedInput.candidates.length, 'label-candidate-binding-mismatch');
  const decision = submission.selectedSemanticAction;
  if (offer.encodedInput.kind === 'ordinary') {
    require(candidates[indices[0]].id === decision.actionId && offer.candidateMask.every(x => x === true), 'ordinary-binding-or-mask-mismatch');
  } else {
    require(offer.promptContext?.min === 1 && offer.promptContext?.max === 1 && !offer.promptContext.ordered
      && !decision.cancel && !decision.amounts && equal(decision.choiceIds, [candidates[indices[0]].id]), 'singleton-selection-binding-mismatch');
  }
  require(Object.keys(offer.encodedInput).every(key => encodedKeys.includes(key)), 'unexpected-encoded-field');
  const record = Object.fromEntries(encodedKeys.map(key => [key, offer.encodedInput[key]]));
  record.label = indices[0];
  if (record.kind === 'selection') record.labels = indices;
  record.humanLabel = {gameId: manifest.gameId, decisionId: offer.decisionId, submissionId: submission.submissionId,
    actor: 'human', observationHash: offer.observationHash, actionKind: candidates[indices[0]].kind ?? 'selection',
    behaviorLogProbability: null, eligibleForPpo: false};
  if (record.kind === 'selection') { retainedSelections.push(record); skip('selection-head-explicitly-excluded'); continue; }
  if (record.humanLabel.actionKind === 'retreat') { skip('cohort-retreat-facts-unqualified'); continue; }
  training.push(record); const kind = record.humanLabel.actionKind; coverage[kind] = (coverage[kind] ?? 0) + 1;
}
require(training.length > 0, 'no-ordinary-human-labels');
const root = path.resolve(import.meta.dirname, '..');
const sources = ['learning/human_bc.py','learning/train_model6.py','learning/model6_torch.py','learning/model6-contract.json',
  'learning/model6-features.mjs','learning/entity_torch.py','learning/entity-contract.json','learning/entity-features.mjs',
  'learning/entity_ppo.py','learning/card_action_torch.py','scripts/prepare-human-bc.mjs'];
const sourceHashes = Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
require(!fs.existsSync(target), 'fresh-admission-output-required'); fs.mkdirSync(target, {recursive:true});
const writeLines = (name, values) => { const bytes = values.map(x => JSON.stringify(x) + '\n').join('');
  fs.writeFileSync(path.join(target,name), bytes, {flag:'wx'}); return hash(bytes); };
const files = {recordsSha256: writeLines('records.jsonl',training), selectionsSha256: writeLines('excluded-selections.jsonl',retainedSelections),
  observationsSha256: writeLines('human-observations.jsonl',observations)};
fs.writeFileSync(path.join(target,'catalog.json'),catalogBytes,{flag:'wx'});
fs.copyFileSync(config.model.checkpoint,path.join(target,'baseline-copy.pt'),fs.constants.COPYFILE_EXCL);
require(hash(fs.readFileSync(path.join(target,'baseline-copy.pt'))) === config.checkpointSha256, 'baseline-copy-mismatch');
const receipt = {schema:'model6-human-bc-dataset/1',scope:'localized-fit-only/1',featureContract:features.model6FeatureContract,
  contractSha256:features.model6ContractSha256,catalogSha256:config.model.catalogSha256,sourceHashes,
  gameId:manifest.gameId,seed:manifest.pins.seed,baselineSha256:config.checkpointSha256,baselineUpdates:23,
  originalJournal:{directory:path.resolve(directory),eventsSha256:eventsSha,manifestSha256:manifestSha},
  recordsPath:'records.jsonl',...files,trainingRecords:training.length,validationRecords:0,
  humanSubmissions:submissions.length,acceptedHumanCommands:accepted,exactAcceptedEncodings:exactEncodings,
  retainedSelectionLabels:retainedSelections.length,coverage,skipped,
  privacyBoundary:'human-decision-offered observations only; no receipt views or opponent observations',
  eligibleForPpo:false,heldOutTransferClaim:false,retreatLimitation:'cohort retreat facts remain explicitly unknown'};
fs.writeFileSync(path.join(target,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:path.resolve(target),trainingRecords:training.length,retainedSelectionLabels:retainedSelections.length,
  acceptedHumanCommands:accepted,exactAcceptedEncodings:exactEncodings,coverage,skipped:skipped.length}));
