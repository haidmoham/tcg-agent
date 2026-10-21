import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeAtomicJson} from './model7-atomic-json.mjs';

const [snapshotPath,journalPath,rootsPath]=process.argv.slice(2);
if(process.argv.length!==5)throw Error('Usage: adopt-model7-search <qualified-source-snapshot> <retained-journal> <retained-roots>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const snapshot=read(snapshotPath),protocol=read(snapshot.protocol),root=path.dirname(path.resolve(snapshotPath));
const run=snapshot.outputDirectory,statusPath=path.join(run,'status.json'),state=read(statusPath);
if(protocol.version!==5||state.state!=='failed'||state.batchIndex!==5||state.nextBatch!==5
  ||state.manifestSha256!==snapshot.adoptionSnapshot.previousManifestSha256||state.lastAnnouncement?.batchIndex!==4
  ||state.completedBatchUpdates<2||state.pendingUpdate||state.checkpointSha256!==state.lastAnnouncement.checkpointSha256)
  throw Error('Admitted batch4 and inspected intentional preflight pause required');
for(const pid of [state.pid,state.activeChildPid])if(pid){try{process.kill(pid,0);throw Error(`Old process ${pid} still running`);}catch(error){if(error.code!=='ESRCH')throw error;}}
const guarded=path.join(run,'batch-5'),entries=fs.readdirSync(guarded),markerPath=path.join(guarded,'boundary-pause-request.json');
if(entries.length!==1||entries[0]!=='boundary-pause-request.json')throw Error('Batch5 contains actual work; do not discard it for adoption');
const marker=read(markerPath),stderr=path.join(run,'batch-5-collection.stderr.log');
if(marker.guardedBatchIndex!==5||marker.afterBatchIndex!==4||!fs.readFileSync(stderr,'utf8').includes('Predeclared sixteen-game plan and fresh output required'))
  throw Error('Intentional zero-game preflight guard proof missing');
const batch4=read(path.join(run,'batch-4/receipt.json'));
if(!batch4.completed||batch4.naturalGames!==16)throw Error('Usable batch4 must finish and fit before adoption');
const trained=state.checkpoint,trainedSha=hash(trained),trainedReceipt=trained.replace(/\.pt$/,'.receipt.json');
if(trainedSha!==state.checkpointSha256||hash(trainedReceipt)!==state.lastAnnouncement.receiptSha256
  ||read(trainedReceipt).updateCount!==state.completedBatchUpdates||!read(trainedReceipt).reloadPolicyValueExact)
  throw Error('Last trained state identity/reload proof differs');
for(const [file,digest]of Object.entries(snapshot.filePins))if(hash(file)!==digest)throw Error(`Adoption input changed: ${file}`);
const alias=path.join(snapshot.modelDirectory,'alphazero-adoption-v5.pt'),replay=path.join(run,'batch-4-replay.jsonl');
const resealed=spawnSync(snapshot.python,['-u','scripts/reseal-model7-alphazero.py',trained,alias,
  '--catalog',snapshot.catalog,'--probe-records',replay,'--protocol-sha256',snapshot.protocolSha256,'--allow-trained'],
  {cwd:snapshot.runtimeRoot,windowsHide:true,encoding:'utf8',env:{...process.env,PTCG_AGENT_MODEL_ROOT:snapshot.modelDirectory}});
if(resealed.status!==0)throw Error(`Trained-state reseal failed: ${resealed.stderr}`);
const aliasReceipt=alias.replace(/\.pt$/,'.receipt.json'),preserved=read(aliasReceipt);
if(!preserved.metadataOnlyReseal||!preserved.reloadPolicyValueExact||preserved.fits!==0
  ||preserved.updateCount!==state.completedBatchUpdates||Object.values(preserved.unchangedTrainingStateFields).some(value=>value!==true)
  ||preserved.metadataResealParentSha256!==trainedSha||preserved.checkpointSha256!==hash(alias))
  throw Error('Trained model/optimizer/RNG preservation failed');
const filePins={...snapshot.filePins,[path.resolve(snapshotPath)]:hash(snapshotPath),[trained]:trainedSha,
  [trainedReceipt]:hash(trainedReceipt),[alias]:hash(alias),[aliasReceipt]:hash(aliasReceipt)};
const modelConfig={...snapshot.modelConfig,runtimeRoot:snapshot.runtimeRoot,checkpoint:alias,checkpointSha256:hash(alias)};
const episodeModule=path.join(snapshot.runtimeRoot,'integrations/local-worker/alphazero-training-episode.mjs');
const episodeRunner={module:episodeModule,sha256:hash(episodeModule),maximumGameSeconds:3600,
  sourcePins:Object.fromEntries(Object.entries(snapshot.sourcePins).filter(([file])=>file.startsWith(snapshot.runtimeRoot+path.sep)))};
const prepared={...snapshot,startPolicy:protocol.training.startPolicy,initialCheckpoint:alias,initialCheckpointSha256:hash(alias),
  initializationReceiptSha256:hash(aliasReceipt),modelConfig,filePins,episodeRunner,
  sourceAdoption:{originalTrainedCheckpointSha256:trainedSha,metadataResealedCheckpointSha256:hash(alias),fits:0,
    completedBatchUpdates:state.completedBatchUpdates,metadataResealReceiptSha256:hash(aliasReceipt)},
  collectionPlan:{...snapshot.collectionPlan,modelConfig,filePins,
    playerConfig:{...snapshot.playerConfig,searchOptions:{...snapshot.playerConfig.searchOptions,temperature:1,rootNoise:true}}}};
const draft=path.join(root,'search-adoption-v5-qualified-inputs.json');save(draft,prepared);
const qualification=path.join(root,'search-adoption-v5-boundary-qualification.json');
const checked=spawnSync(process.execPath,['scripts/qualify-model7-search-adoption.mjs',draft,alias,hash(alias),path.resolve(journalPath),path.resolve(rootsPath),qualification],
  {cwd:snapshot.runtimeRoot,windowsHide:true,encoding:'utf8',timeout:600000});
if(checked.status!==0)throw Error(`Archived trained-player qualification failed: ${checked.stderr}\n${checked.stdout}`);
const proof=read(qualification);
if(!proof.complete||proof.roots!==109||proof.knownBottomConstraintRoots!==44||proof.searchProofs.length!==3
  ||!proof.incompleteLedgerFallbackWithoutTargets||proof.checkpointSha256!==hash(alias)||hash(trained)!==trainedSha)
  throw Error('Actual archived player qualification is incomplete');
const manifest={...prepared,filePins:{...filePins,[draft]:hash(draft),[qualification]:hash(qualification)},
  sourceAdoption:{...prepared.sourceAdoption,qualificationReceiptSha256:hash(qualification),qualifiedInputsSha256:hash(draft)}};
manifest.collectionPlan.filePins=manifest.filePins;
const destination=path.join(root,'alphazero-manifest-v5.json');save(destination,manifest);
const archive=path.join(run,'intentional-boundary-pause-005');fs.renameSync(guarded,archive);
for(const [source,name]of [[path.join(run,'batch-5-plan.json'),'preflight-plan.json'],[stderr,'preflight.stderr.log'],
  [path.join(run,'batch-5-collection.stdout.log'),'preflight.stdout.log']])fs.renameSync(source,path.join(archive,name));
fs.copyFileSync(statusPath,path.join(run,'status-before-source-adoption-v5.json'),fs.constants.COPYFILE_EXCL);
fs.copyFileSync(path.join(run,'player-runtime.json'),path.join(run,'player-runtime-v4.json'),fs.constants.COPYFILE_EXCL);
const adoption={schema:'model7-source-adoption/1',at:new Date().toISOString(),manifest:destination,manifestSha256:hash(destination),
  oldCheckpointSha256:trainedSha,newCheckpointSha256:hash(alias),metadataOnly:true,fits:0,
  completedBatchUpdates:state.completedBatchUpdates,optimizerSteps:state.optimizerSteps,
  trainingStartedAtUtc:state.trainingStartedAtUtc,deadlineUtc:state.deadlineUtc,beliefScope:manifest.beliefScope,
  lastLearningAnnouncementPreserved:true,qualificationReceiptSha256:hash(qualification),resealReceiptSha256:hash(aliasReceipt),
  intentionalPause:{guardedBatchIndex:5,markerSha256:hash(path.join(archive,'boundary-pause-request.json')),preflightStderrSha256:hash(path.join(archive,'preflight.stderr.log')),actualGamesStarted:0,seedsUnused:true}};
save(path.join(root,'source-adoption-v5.json'),adoption);
state.manifestSha256=hash(destination);state.protocolSha256=manifest.protocolSha256;state.checkpoint=alias;state.checkpointSha256=hash(alias);
state.state='paused';state.phase='between-batches';state.nextBatch=4;
state.skippedBatches=state.skippedBatches.filter(batch=>batch.batchIndex!==5);
state.failures=state.failures.map(failure=>failure.reason.startsWith('Whole batch excluded')?{...failure,resolvedAs:'intentional-prelaunch-boundary-pause',gameFailure:false}:failure);
state.sourceAdoptions=[...(state.sourceAdoptions??[]),adoption];writeAtomicJson(statusPath,state);
fs.appendFileSync(path.join(run,'events.jsonl'),JSON.stringify({type:'metadata-only-player-adoption',...adoption})+'\n');
console.log(JSON.stringify(adoption));
