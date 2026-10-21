import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeAtomicJson} from './model7-atomic-json.mjs';

const [manifestPath,sourceRoot,errorLog]=process.argv.slice(2);
if(process.argv.length!==5)throw Error('Usage: recover-model7-controller <sealed-manifest> <source-root> <preserved-error-log>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original=read(manifestPath),statusPath=path.join(original.outputDirectory,'status.json'),state=read(statusPath);
if(state.manifestSha256!==hash(manifestPath)||state.phase!=='collection'||state.completedBatchUpdates!==0
  ||state.nextBatch!==2||!fs.readFileSync(errorLog,'utf8').includes('EPERM: operation not permitted, rename'))
  throw Error('Inspected pre-fit batch-two status-writer failure required');
for(const pid of [state.pid,state.activeChildPid])if(pid){
  try{process.kill(pid,0);throw Error(`Process ${pid} is still running`);}catch(error){if(error.code!=='ESRCH')throw error;}}
for(const [file,digest]of Object.entries(original.filePins))if(hash(file)!==digest)throw Error(`Pinned input changed: ${file}`);
const root=path.dirname(path.resolve(manifestPath)),controllerRoot=path.join(root,'execution-control-002');
if(fs.existsSync(controllerRoot))throw Error('Controller recovery already prepared; inspect outcome before retry');
fs.mkdirSync(path.join(controllerRoot,'scripts'),{recursive:true});
const pins={};for(const relative of ['scripts/run-model7-alphazero.mjs','scripts/model7-atomic-json.mjs']){
  const file=path.join(controllerRoot,relative);fs.copyFileSync(path.join(sourceRoot,relative),file);pins[file]=hash(file);}
const manifest={...original,filePins:{...original.filePins,...pins},
  executionController:{module:path.join(controllerRoot,'scripts/run-model7-alphazero.mjs'),sourcePins:pins,
    reason:'Windows status sharing-lock recovery; no player, model, search, optimizer, seed or timing change'}};
const destination=path.join(root,'alphazero-manifest-v4-controller-002.json');
fs.writeFileSync(destination,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const before=path.join(original.outputDirectory,'status-before-controller-recovery-002.json');
fs.copyFileSync(statusPath,before,fs.constants.COPYFILE_EXCL);
const evidence={schema:'model7-controller-recovery/1',at:new Date().toISOString(),previousManifestSha256:hash(manifestPath),
  executionManifest:destination,executionManifestSha256:hash(destination),controller:manifest.executionController,
  errorLogSha256:hash(errorLog),observedCrashLogAtUtc:fs.statSync(errorLog).mtime.toISOString(),
  excludedBatchIndex:2,nextUnusedBatchIndex:3,checkpointSha256:state.checkpointSha256,
  playerRuntimeSha256:hash(path.join(original.outputDirectory,'player-runtime.json')),
  trainingStartedAtUtc:state.trainingStartedAtUtc,deadlineUtc:state.deadlineUtc,fits:0,
  limitation:'The heartbeat failure left one natural completion and interrupted four active games; all available artifacts remain excluded with the whole batch.'};
fs.writeFileSync(path.join(root,'controller-recovery-002.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
state.manifestSha256=hash(destination);state.state='paused';state.phase='between-batches';state.activeChildPid=null;
state.skippedBatches.push({batchIndex:2,reason:'controller-status-write-interruption',
  evidenceDirectory:path.join(original.outputDirectory,'batch-2')});
state.failures.push({at:evidence.observedCrashLogAtUtc,phase:'collection',reason:'Windows EPERM atomic status rename; whole batch excluded'});
state.controllerRecovery=evidence;writeAtomicJson(statusPath,state);
console.log(JSON.stringify(evidence));
