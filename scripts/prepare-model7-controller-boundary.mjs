import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeAtomicJson} from './model7-atomic-json.mjs';

const [manifestPath,sourceRoot,name]=process.argv.slice(2);
if(process.argv.length!==5||!/^execution-control-\d+$/.test(name))
  throw Error('Usage: prepare-model7-controller-boundary <sealed-manifest> <source-root> <fresh-execution-control-NNN>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest=read(manifestPath),run=manifest.outputDirectory,statusPath=path.join(run,'status.json'),state=read(statusPath);
const request=path.join(run,'pause-before-next-batch.json');
if(state.manifestSha256!==hash(manifestPath)||state.state!=='paused'||state.phase!=='operator-boundary-pause'
  ||state.pendingUpdate||!fs.existsSync(request)||state.checkpointSha256!==state.lastAnnouncement?.checkpointSha256)
  throw Error('Verified operator pause after an admitted update required');
for(const pid of [state.pid,state.activeChildPid])if(pid){
  try{process.kill(pid,0);throw Error(`Old process ${pid} still running`);}catch(error){if(error.code!=='ESRCH')throw error;}}
for(const [file,digest]of Object.entries(manifest.filePins))if(hash(file)!==digest)throw Error(`Pinned input changed: ${file}`);
if(hash(state.checkpoint)!==state.checkpointSha256)throw Error('Last admitted checkpoint changed');
const root=path.dirname(path.resolve(manifestPath)),control=path.join(root,name),pins={};
if(fs.existsSync(control))throw Error('Fresh execution controller directory required');
fs.mkdirSync(path.join(control,'scripts'),{recursive:true});
for(const relative of ['scripts/run-model7-alphazero.mjs','scripts/model7-atomic-json.mjs']){
  const target=path.join(control,relative);fs.copyFileSync(path.join(sourceRoot,relative),target);pins[target]=hash(target);}
const prepared={...manifest,filePins:{...manifest.filePins,...pins},executionController:{module:path.join(control,'scripts/run-model7-alphazero.mjs'),sourcePins:pins,
  reason:'Deadline finalization only; no player, model, optimizer, seed or timing change'}};
const destination=path.join(root,`alphazero-manifest-${name}.json`);
fs.writeFileSync(destination,JSON.stringify(prepared,null,2)+'\n',{flag:'wx'});
const evidence={schema:'model7-controller-boundary-update/1',at:new Date().toISOString(),previousManifestSha256:hash(manifestPath),
  manifest:destination,manifestSha256:hash(destination),controller:prepared.executionController,
  pauseRequestSha256:hash(request),nextUnusedBatchIndex:state.nextBatch+1,checkpointSha256:state.checkpointSha256,
  playerRuntimeSha256:hash(path.join(run,'player-runtime.json')),completedBatchUpdates:state.completedBatchUpdates,
  completedTrainingGames:state.completedTrainingGames,optimizerSteps:state.optimizerSteps,
  trainingStartedAtUtc:state.trainingStartedAtUtc,deadlineUtc:state.deadlineUtc,fits:0};
fs.copyFileSync(statusPath,path.join(run,`status-before-${name}.json`),fs.constants.COPYFILE_EXCL);
fs.renameSync(request,path.join(control,'boundary-pause-request.json'));
state.manifestSha256=hash(destination);state.phase='between-batches';
state.controllerUpdates=[...(state.controllerUpdates??[]),evidence];writeAtomicJson(statusPath,state);
fs.writeFileSync(path.join(control,'boundary-update.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(evidence));
