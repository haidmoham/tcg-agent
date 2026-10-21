// Offline human-label admission. No worker, model, native preview or UI access.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {pathToFileURL} from 'node:url';

const [configFile, planFile, output] = process.argv.slice(2);
if (!output || process.argv.length !== 5) throw Error('usage: prepare-supervised-bootstrap <private-config> <private-plan> <fresh-output>');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const check = (value, reason) => { if (!value) throw Error(reason); };
const config = read(configFile), plan = read(planFile);
check(plan.schema === 'human-bootstrap-plan/1' && Array.isArray(plan.trainingGames)
  && Array.isArray(plan.evaluationGames) && !fs.existsSync(output), 'explicit-fresh-bootstrap-plan-required');
const features = await import(pathToFileURL(path.join(config.runtimeRoot, 'learning/model6-features.mjs')));
const {PolicyView} = await import(pathToFileURL(path.join(config.runtimeRoot, 'integrations/local-worker/model6-policy-view.mjs')));
const catalogBytes = fs.readFileSync(config.model.catalogPath), catalog = JSON.parse(catalogBytes);
check(sha(catalogBytes) === config.model.catalogSha256, 'catalog-pin-mismatch');
const notesBytes = fs.readFileSync(plan.puzzleReview.path), notes = JSON.parse(notesBytes);
check(sha(notesBytes) === plan.puzzleReview.sha256 && notes.integrity.allFourPresentAndBound === true,
  'verified-puzzle-review-required');
const replayBytes=fs.readFileSync(plan.publicReplayProof.path),replay=JSON.parse(replayBytes);
check(sha(replayBytes)===plan.publicReplayProof.sha256,'replay-proof-pin-mismatch');
let evaluationProtocol=null;
if(plan.simulatorEvaluation){
  const bytes=fs.readFileSync(plan.simulatorEvaluation.path),p=JSON.parse(bytes);
  check(sha(bytes)===plan.simulatorEvaluation.sha256&&p.schema==='bootstrap-mirror-evaluation/1'
    &&p.status==='predeclared'&&p.blocks.length===32&&p.gamesPerBlock===2
    &&p.baseline.ordinarySha256===config.checkpointSha256&&p.baseline.selectionSha256===config.model.frozenSelectionSha256
    &&p.catalogSha256===config.model.catalogSha256,'invalid-predeclared-simulator-evaluation');
  evaluationProtocol={path:path.resolve(plan.simulatorEvaluation.path),sha256:sha(bytes),protocol:p};
}
const annotations = new Map(notes.results.map(note => [`${note.source.sessionId}/${note.source.decisionId}`, note]));
const keys = ['schema','kind','globals','entities','entityCardIds','entityParents','candidates','candidateSources',
  'candidateTargets','candidateActors','candidateActionIds','originActionId','originSourceIndex','energyEntities',
  'energyCandidates','energyAttacks','energyAttackEntities','energyAttackActionIds','energyCandidateAttacks',
  'energyCandidateAttackCandidates','energyCandidateAttackActionIds'];
const records = {train:[], evaluation:[]}, exclusions = [], sessions = [], seen = new Set(), usedAnnotations = new Set();
const seeds=new Set();
for (const [split, games] of [['train',plan.trainingGames],['evaluation',plan.evaluationGames]]) for (const game of games) {
  const mb = fs.readFileSync(path.join(game.directory,'manifest.json'));
  const eb = fs.readFileSync(path.join(game.directory,'events.jsonl'));
  const m = JSON.parse(mb), text = eb.toString('utf8');
  check(sha(mb) === game.manifestSha256 && sha(eb) === game.eventsSha256, 'journal-pin-mismatch');
  check(m.schema === 'human-demonstration-manifest/1' && m.provenance === 'human' && m.eligibleForPpo === false
    && m.pinsSha256 === sha(JSON.stringify(m.pins)) && text.endsWith('\n'), 'complete-human-journal-required');
  check(!seen.has(m.gameId), 'whole-game-split-overlap'); seen.add(m.gameId);
  check(!seeds.has(m.pins.seed),'duplicate-whole-game-seed');seeds.add(m.pins.seed);
  check(m.pins.contractSha256 === features.model6ContractSha256 && m.pins.checkpointSha256 === config.checkpointSha256
    && equal(m.pins.privateInputs,config.pins) && equal(m.pins.deckSha256,config.deckSha256), 'session-contract-pins-mismatch');
  if (split === 'evaluation') check(!notes.results.some(n=>n.source.sessionId===m.gameId)
    && !(plan.previouslyInspectedGameIds ?? []).includes(m.gameId), 'evaluation-game-already-inspected-or-tuned');
  const rows = text.trimEnd().split('\n').map(JSON.parse);
  rows.forEach((r,i)=>check(r.schema==='human-demonstration-event/1'&&r.gameId===m.gameId
    &&r.sequence===i&&r.pinsSha256===m.pinsSha256,'journal-sequence-mismatch'));
  const endings = rows.filter(r=>r.type==='game-ended');
  check(endings.length===1&&endings[0].interruptionStatus==='completed'&&endings[0].reason==='native-terminal', 'natural-complete-game-required');
  check(rows.slice(endings[0].sequence+1).every(r=>r.type==='human-visible-after-command'),'command-after-terminal');
  const offers = new Map(rows.filter(r=>r.type==='human-decision-offered'&&r.actor==='human'&&r.seat===0).map(r=>[r.decisionId,r]));
  const resultRows=rows.filter(r=>r.type==='decision-result'&&r.actor==='human');
  const results = new Map(resultRows.map(r=>[r.submissionId,r]));
  check(results.size===resultRows.length,'duplicate-human-command-results');
  const resolutions = new Map(rows.filter(r=>r.type==='decision-resolved'&&r.actor==='human').map(r=>[r.submissionId,r]));
  const summary = {gameId:m.gameId, split, seed:m.pins.seed, eventsSha256:sha(eb),manifestSha256:sha(mb),
    accepted:0, ordinary:0, selectionRanking:0, annotated:0, excluded:0};
  const decisionIds = new Set();
  for (const s of rows.filter(r=>r.type==='human-submitted'&&r.actor==='human')) {
    const r=results.get(s.submissionId),o=offers.get(s.decisionId),resolved=resolutions.get(s.submissionId);
    const skip = reason => { exclusions.push({gameId:m.gameId,decisionId:s.decisionId,reason}); summary.excluded++; };
    if(r?.acceptance!=='accepted'){skip('rejected-or-uncertain');continue;} summary.accepted++;
    check(o&&resolved&&!decisionIds.has(o.decisionId)&&s.behaviorSource==='human'&&s.behaviorLogProbability===null
      &&s.eligibleForPpo===false&&s.observationHash===o.observationHash&&r.imitationLabelEligible===true
      &&r.rawSemanticLabelComplete===true&&r.nativeReceipt?.status==='accepted'
      &&r.nativeReceipt.commandId===resolved.commandId&&equal(r.resolvedArguments,resolved.resolvedArguments),'unbound-human-command');
    decisionIds.add(o.decisionId);
    check(sha(JSON.stringify({rawObservation:o.rawObservation,view:o.projectedObservation,presentation:o.playerVisiblePresentation}))
      ===o.observationHash,'observation-digest-mismatch');
    check(o.rawObservation.opponent?.hand==null&&o.rawObservation.opponent?.deck==null
      &&o.projectedObservation.opponent?.hand==null,'opponent-private-faces');
    const projector=new PolicyView(); projector.project(o.rawObservation);
    check(equal(projector.resolve(s.selectedSemanticAction),resolved.resolvedArguments),'semantic-native-binding-mismatch');
    if(!o.encodedInput){skip('unencoded-setup-or-noncard');continue;}
    check(o.encodedContract.sha256===features.model6ContractSha256
      &&equal(features.encodeModel6Decision(o.projectedObservation,{catalog}),o.encodedInput),'changed-encoding');
    const p=o.promptContext,choices=o.orderedCandidates,indices=r.selectedCandidateIndices,decision=s.selectedSemanticAction;
    check(choices.length===o.encodedInput.candidates.length&&Array.isArray(indices)
      &&indices.every(i=>Number.isSafeInteger(i)&&i>=0&&i<choices.length),'candidate-index-binding');
    let task;
    if(!p){
      check(indices.length===1&&choices[indices[0]].id===decision.actionId&&o.candidateMask.every(v=>v===true),'ordinary-mask-binding');
      if(choices[indices[0]].kind==='retreat'){skip('unqualified-retreat-facts');continue;}
      task='ordinary-choice';summary.ordinary++;
    }else{
      if(decision.amounts||p.kind==='allocation'){skip('allocation-not-card-ranking');continue;}
      if(p.ordered||!['cards','pokemon','select'].includes(p.kind)||decision.cancel){skip('unsupported-prompt-kind-order-or-cancel');continue;}
      if(!indices.length){skip('empty-selection-cardinality-not-learned-by-ranker');continue;}
      if(!choices.every(c=>c.card?.printingId||c.instanceId)){skip('noncard-choice-pool');continue;}
      check(equal(decision.choiceIds,indices.map(i=>choices[i].id)),'prompt-choice-binding');
      task='selection-ranking';summary.selectionRanking++;
    }
    const note=split==='train'?annotations.get(`${m.gameId}/${o.decisionId}`):null;
    let acceptableSets=[indices];
    if(note){
      check(note.source.observationHash===o.observationHash&&note.actionLabelComplete&&!note.needsMoreInformation,'incomplete-puzzle-annotation');
      const answers=[...note.selected,...note.acceptableAlternatives];
      acceptableSets=answers.map(answer=>{
        const d=answer.decision;
        const ids=d.actionId?[d.actionId]:d.choiceIds;
        check(Array.isArray(ids)&&ids.length>0&&!d.amounts&&!d.cancel,'unsupported-reviewed-answer');
        return ids.map(id=>{const i=choices.findIndex(c=>c.id===id);check(i>=0,'reviewed-answer-not-offered');return i;});
      });
      usedAnnotations.add(note.puzzleId);summary.annotated++;
    }
    const record=Object.fromEntries(keys.map(k=>[k,o.encodedInput[k]]));
    record.label=acceptableSets[0][0]; if(record.kind==='selection')record.labels=acceptableSets[0];
    record.bootstrap={task,gameId:m.gameId,decisionId:o.decisionId,observationHash:o.observationHash,
      head:!p||(p.min===1&&p.max===1&&!p.ordered&&choices.every(c=>c.minAmount==null&&c.maxAmount==null&&c.initialAmount==null))
        ?'ordinary-choice':'selection-ranking',
      behaviorLogProbability:null,eligibleForPpo:false,observedIndices:indices,acceptableIndexSets:acceptableSets,
      explicitAcceptableSet:!!note,judgment:'observed behavior or explicit retrospective preference; other choices not graded bad',
      supportMeaning:p?'complete offered-option pool for ranking; joint legality unknown':'complete native legal action list',
      recordedChoiceMask:o.candidateMask,puzzleId:note?.puzzleId??null,
      rationale:note?.reasoningVerbatim??null,notAnInventedTrajectory:true};
    records[split].push(record);
  }
  sessions.push(summary);
}
check(usedAnnotations.size===notes.results.length,'not-all-puzzle-answers-bound');
check(records.train.some(r=>r.bootstrap.task==='ordinary-choice')&&records.train.some(r=>r.bootstrap.task==='selection-ranking'),'both-policy-heads-required');
const dir=path.resolve(output);fs.mkdirSync(dir,{recursive:true});
const write=(name,bytes)=>{fs.writeFileSync(path.join(dir,name),bytes,{flag:'wx'});return sha(bytes);};
const trainSha=write('train.jsonl',records.train.map(r=>JSON.stringify(r)+'\n').join(''));
const evalSha=write('evaluation.jsonl',records.evaluation.map(r=>JSON.stringify(r)+'\n').join(''));
write('catalog.json',catalogBytes);
if(evaluationProtocol)check([...evaluationProtocol.protocol.blocks,...evaluationProtocol.protocol.replacementBlocks]
  .every(b=>!seeds.has(b.seed)),'evaluation-seed-overlaps-human-game');
const ready=!!evaluationProtocol||(plan.evaluationGames.length>0&&records.evaluation.length>0);
const report={schema:'supervised-bootstrap-admission/1',at:new Date().toISOString(),sessions,
  trainRecords:records.train.length,evaluationRecords:records.evaluation.length,trainSha256:trainSha,evaluationSha256:evalSha,
  catalogSha256:sha(catalogBytes),contractSha256:features.model6ContractSha256,
  baselineSha256:config.checkpointSha256,selectionSha256:config.model.frozenSelectionSha256,
  trainingGames:sessions.filter(s=>s.split==='train').map(s=>s.gameId),evaluationGames:sessions.filter(s=>s.split==='evaluation').map(s=>s.gameId),
  puzzleReviewSha256:sha(notesBytes),annotationsBound:[...usedAnnotations],exclusions,
  publicReplay:{partialSemanticLabels:replay.mappings.filter(r=>r.admitted).length,proofSha256:sha(replayBytes),
    ordinaryPolicyRecords:0,selectionRecords:0,reason:'partial observations; no complete legal set'},
  evaluationProtocol,
  fitGate:{ready,reason:evaluationProtocol?'fresh paired simulator seeds predeclared; no new human evaluation required'
    :ready?'whole-game evaluation reserved before any fit':'fresh whole-game evaluation not yet reserved'},
  masks:{ordinary:'native legal actions',selection:'offered-pool ranking only; joint legality remains unknown'},
  source:{path:'scripts/prepare-supervised-bootstrap.mjs',sha256:sha(fs.readFileSync(new URL(import.meta.url)))},
  trainingStarted:false,optimizerSteps:0,promotion:false,coachingMaterialIncluded:false};
write('admission.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output:dir,sessions,trainRecords:records.train.length,evaluationRecords:records.evaluation.length,
  annotationsBound:report.annotationsBound,fitGate:report.fitGate,trainingStarted:false},null,2));
