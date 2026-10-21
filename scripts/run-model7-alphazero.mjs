import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';

const [manifestPath,resume]=process.argv.slice(2);
if(!manifestPath||process.argv.length>4||resume&&resume!=='--resume')throw Error('Usage: run-model7-alphazero <private-manifest> [--resume]');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest=read(manifestPath),protocol=read(manifest.protocol),manifestSha256=hash(manifestPath),root=manifest.outputDirectory;
if(manifest.schema!=='model7-alphazero-execution/1'||![3,4].includes(protocol.version)||hash(manifest.protocol)!==manifest.protocolSha256)
  throw Error('Pinned AlphaZero version-three execution required');
if(!resume&&fs.existsSync(root))throw Error('Fresh run required; inspect prior effects before resume');
fs.mkdirSync(root,{recursive:true});
const save=(name,value)=>{const file=path.join(root,name),temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file);};
const event=value=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...value})+'\n');
const asap=manifest.startPolicy==='asap-after-qualification';
let start=Date.parse(protocol.training.startUtc),deadline=Date.parse(protocol.training.deadlineUtc);
if(protocol.training.allocatedSeconds!==21600||!asap&&deadline-start!==21600000)throw Error('Exact six-hour training allocation required');
const state=resume?read(path.join(root,'status.json')):{schema:'model7-alphazero-status/1',manifestSha256,
  protocolSha256:manifest.protocolSha256,state:'scheduled',phase:'waiting',startUtc:asap?null:protocol.training.startUtc,
  deadlineUtc:asap?null:protocol.training.deadlineUtc,checkpoint:manifest.initialCheckpoint,checkpointSha256:manifest.initialCheckpointSha256,
  completedTrainingGames:0,completedBatchUpdates:0,optimizerSteps:0,collectionSeconds:0,fittingSeconds:0,
  nextBatch:0,batches:[],skippedBatches:[],failures:[],replayBatches:[],promoted:false};
if(state.manifestSha256!==manifestSha256||state.state==='completed')throw Error('Mismatched or completed execution');
if(resume&&state.trainingStartedAtUtc){start=Date.parse(state.trainingStartedAtUtc);deadline=Date.parse(state.deadlineUtc);}
const ownerPath=path.join(root,'supervisor-owner.json');
if(fs.existsSync(ownerPath)) {
  const owner=read(ownerPath);try{process.kill(owner.pid,0);throw Error('Existing supervisor is still running');}
  catch(error){if(error.code!=='ESRCH')throw error;}
  if(!resume)throw Error('Interrupted supervisor requires inspected resume');fs.unlinkSync(ownerPath);
}
fs.writeFileSync(ownerPath,JSON.stringify({pid:process.pid,manifestSha256}),{flag:'wx'});
let child=null,cancelled=false;
const remaining=()=>asap&&!state.trainingStartedAtUtc?21600:Math.max(0,Math.floor((deadline-Date.now())/1000));
const status=()=>{state.at=new Date().toISOString();state.pid=process.pid;state.activeChildPid=child?.pid??null;save('status.json',state);};
const assertPins=()=>{if(hash(manifestPath)!==manifestSha256)throw Error('Execution manifest changed');
  for(const [file,digest]of Object.entries(manifest.filePins))if(hash(file)!==digest)throw Error(`Pinned source/input changed: ${file}`);
  if(hash(state.checkpoint)!==state.checkpointSha256)throw Error('Last admitted checkpoint changed');};
const stop=processObject=>process.platform==='win32'?spawn('taskkill',['/PID',String(processObject.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}):processObject.kill();
const interrupt=()=>{cancelled=true;if(child)stop(child);};process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
async function execute(executable,args,label,seconds) {
  const stdout=fs.openSync(path.join(root,`${label}.stdout.log`),'ax'),stderr=fs.openSync(path.join(root,`${label}.stderr.log`),'ax'),began=Date.now();
  if(label.endsWith('-collection')&&!state.trainingStartedAtUtc) {
    start=began;deadline=asap?began+21600000:deadline;
    state.trainingStartedAtUtc=new Date(began).toISOString();state.startUtc=state.trainingStartedAtUtc;
    state.deadlineUtc=new Date(deadline).toISOString();event({type:'actual-collection-start',trainingStartedAtUtc:state.trainingStartedAtUtc,deadlineUtc:state.deadlineUtc});
  }
  child=spawn(executable,args,{cwd:manifest.runtimeRoot,windowsHide:true,stdio:['ignore',stdout,stderr],
    env:{...process.env,PYTHONUNBUFFERED:'1',PTCG_AGENT_MODEL_ROOT:manifest.modelDirectory}});
  const current=child;let expired=false;status();
  event({type:'child-start',label,pid:child.pid,seconds});
  const timer=setTimeout(()=>{expired=true;stop(current);},Math.max(1,Math.min(seconds,remaining()))*1000);
  try {const code=await new Promise((resolve,reject)=>{current.once('error',reject);current.once('exit',resolve);});
    return {code,expired,startedAtUtc:new Date(began).toISOString(),completedAtUtc:new Date().toISOString(),seconds:(Date.now()-began)/1000};
  } finally {clearTimeout(timer);fs.closeSync(stdout);fs.closeSync(stderr);child=null;status();}
}
function admit(pending,completedAtUtc) {
  const receiptPath=pending.checkpoint.replace(/\.pt$/,'.receipt.json'),receipt=read(receiptPath);
  if(Date.parse(completedAtUtc)>deadline||receipt.reloadPolicyValueExact!==true||receipt.parentCheckpointSha256!==pending.parent
    ||receipt.checkpointSha256!==hash(pending.checkpoint)||receipt.updateCount!==state.completedBatchUpdates+1)
    throw Error('AlphaZero update lineage/reload/deadline admission failed');
  state.checkpoint=pending.checkpoint;state.checkpointSha256=receipt.checkpointSha256;state.completedBatchUpdates++;
  state.replayBatches=pending.replayBatches??state.replayBatches;
  state.completedTrainingGames+=16;state.optimizerSteps+=receipt.metrics.optimizerSteps;
  state.firstSuccessfulUpdateAtUtc??=completedAtUtc;
  const announcement={checkpoint:state.checkpoint,checkpointSha256:state.checkpointSha256,completedAtUtc,
    completedTrainingGames:state.completedTrainingGames,completedBatchUpdates:state.completedBatchUpdates,optimizerSteps:state.optimizerSteps,
    reloadVerified:true,batchIndex:pending.batchIndex,parentCheckpointSha256:pending.parent,receiptSha256:hash(receiptPath),
    updateCount:receipt.updateCount,runtimeRoot:manifest.runtimeRoot,factoryModule:manifest.factoryModule,
    factorySha256:hash(manifest.factoryModule),sourcePins:manifest.sourcePins,playerConfig:manifest.playerConfig,
    factoryExport:'openSearchDistillationPlayer',episodeRunner:manifest.episodeRunner,trainingMethod:'alphazero-search-outcome/1'};
  const announcementsPath=path.join(root,'checkpoint-announcements.jsonl');
  const announced=fs.existsSync(announcementsPath)?fs.readFileSync(announcementsPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  if(!announced.some(row=>row.checkpointSha256===announcement.checkpointSha256))fs.appendFileSync(announcementsPath,JSON.stringify(announcement)+'\n');
  state.lastAnnouncement=announcement;state.batches.push({...announcement,metrics:receipt.metrics,replayRecords:pending.replayRecords});
  status();event({type:'checkpoint-admitted',...announcement});
}
const pulse=setInterval(status,15000);
try {
  assertPins();save('player-runtime.json',{runtimeRoot:manifest.runtimeRoot,factoryModule:manifest.factoryModule,
    factoryExport:'openSearchDistillationPlayer',sourcePins:manifest.sourcePins,playerConfig:manifest.playerConfig,episodeRunner:manifest.episodeRunner});
  if(resume&&state.pendingUpdate) {
    const pending=state.pendingUpdate,receipt=pending.checkpoint.replace(/\.pt$/,'.receipt.json');
    if(state.checkpoint!==pending.checkpoint&&fs.existsSync(receipt))admit(pending,fs.statSync(receipt).mtime.toISOString());
    else if(state.checkpoint!==pending.checkpoint)state.skippedBatches.push({batchIndex:pending.batchIndex,reason:'interrupted-unverified-fit'});
    delete state.pendingUpdate;
  } else if(resume&&state.phase==='collection')state.skippedBatches.push({batchIndex:state.nextBatch,reason:'interrupted-collection'});
  event({type:resume?'supervisor-resumed':'supervisor-scheduled',startUtc:state.startUtc,deadlineUtc:state.deadlineUtc});status();
  while(!asap&&Date.now()<start&&!cancelled)await new Promise(resolve=>setTimeout(resolve,Math.min(15000,start-Date.now())));
  if(cancelled)throw Error('operator-interrupted');state.state='running';status();
  for(let index=state.nextBatch;index<protocol.training.batches.length&&remaining()>1&&!cancelled;index++) {
    const batch=protocol.training.batches[index],directory=path.join(root,`batch-${batch.index}`);
    state.nextBatch=index+1;state.phase='collection';state.batchIndex=batch.index;status();assertPins();
    const planPath=path.join(root,`batch-${batch.index}-plan.json`),wall=Math.min(protocol.training.maximumCollectionSecondsPerBatch,Math.max(1,remaining()-5));
    save(`batch-${batch.index}-plan.json`,{...manifest.collectionPlan,tasks:batch.tasks,maximumWallSeconds:wall,
      modelConfig:{...manifest.modelConfig,checkpoint:state.checkpoint,checkpointSha256:state.checkpointSha256}});
    const collected=await execute(process.execPath,['scripts/alphazero-selfplay.mjs',planPath,directory],`batch-${batch.index}-collection`,wall+4);
    state.collectionSeconds+=collected.seconds;assertPins();
    const receiptPath=path.join(directory,'receipt.json'),receipt=fs.existsSync(receiptPath)?read(receiptPath):null;
    event({type:'collection-complete',batchIndex:batch.index,...collected,naturalGames:receipt?.naturalGames??null,records:receipt?.recordsCount??null});
    if(receipt?.stopReason==='integrity-failure')throw Error('Self-play integrity failure; inspect preserved evidence');
    if(collected.code!==0||collected.expired||receipt?.completed!==true||receipt.naturalGames!==16||receipt.recordsCount<2) {
      state.skippedBatches.push({batchIndex:batch.index,reason:'whole-batch-excluded',receiptSha256:receipt?hash(receiptPath):null});status();
      if(protocol.version>=4)throw Error('Whole batch excluded; diagnose preserved game failure before another collection');
      continue;
    }
    const recordPath=path.join(directory,'records.jsonl');
    if(hash(recordPath)!==receipt.recordsSha256)throw Error('Collected search targets changed');
    const replayBatches=[...state.replayBatches,{batchIndex:batch.index,recordPath,sha256:hash(recordPath)}].slice(-4);
    const rows=replayBatches.flatMap(item=>{if(hash(item.recordPath)!==item.sha256)throw Error('Replay source changed');
      return fs.readFileSync(item.recordPath,'utf8').trim().split('\n').filter(Boolean);}).slice(-16384);
    const replay=path.join(root,`batch-${batch.index}-replay.jsonl`);fs.writeFileSync(replay,rows.join('\n')+'\n',{flag:'wx'});
    if(remaining()<2)break;
    const checkpoint=path.join(manifest.modelDirectory,`alphazero-batch-${batch.index}.pt`);
    state.pendingUpdate={batchIndex:batch.index,checkpoint,parent:state.checkpointSha256,replayRecords:rows.length,replayBatches};state.phase='fitting';status();
    const fitted=await execute(manifest.python,['-u','-m','learning.alphazero_runtime','update',state.checkpoint,replay,checkpoint,
      '--catalog',manifest.catalog,'--device','cuda'],`batch-${batch.index}-update`,remaining());
    state.fittingSeconds+=fitted.seconds;assertPins();event({type:'fit-complete',batchIndex:batch.index,...fitted});
    if(fitted.code===0&&!fitted.expired&&Date.now()<=deadline)admit(state.pendingUpdate,fitted.completedAtUtc);
    else if(!fitted.expired&&remaining()>1)throw Error('AlphaZero fit failed; inspect retained stderr and uncertain output before resume');
    delete state.pendingUpdate;state.phase='between-batches';status();
  }
  if(cancelled)throw Error('operator-interrupted');assertPins();state.state='completed';state.phase='finished';state.finishedAtUtc=new Date().toISOString();
  save('final-candidate.json',{schema:'model7-alphazero-final-candidate/1',available:state.completedBatchUpdates>0,
    ...state.lastAnnouncement,checkpoint:state.checkpoint,checkpointSha256:state.checkpointSha256,
    completedTrainingGames:state.completedTrainingGames,completedBatchUpdates:state.completedBatchUpdates,
    optimizerSteps:state.optimizerSteps,completedAtUtc:state.lastAnnouncement?.completedAtUtc??null,
    manifestSha256,protocolSha256:manifest.protocolSha256,promoted:false,strength:'Unmeasured; separate fresh gameplay confirmation required'});
} catch(error) {state.state='failed';state.failures.push({at:new Date().toISOString(),phase:state.phase,reason:error.message});event({type:'supervisor-failed',reason:error.message});process.exitCode=2;}
finally {clearInterval(pulse);status();save('receipt.json',state);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  if(read(ownerPath).pid===process.pid)fs.unlinkSync(ownerPath);}
if(state.state==='completed'&&manifest.archiveDirectory) {
  const begin=Date.now();
  const result=spawnSync(process.execPath,['scripts/preserve-model7-alphazero.mjs',path.resolve(manifestPath),manifest.archiveDirectory],
    {cwd:manifest.runtimeRoot,windowsHide:true,encoding:'utf8',timeout:1800000});
  save('preservation.json',{at:new Date().toISOString(),state:result.status===0?'verified':'failed',
    archiveDirectory:manifest.archiveDirectory,seconds:(Date.now()-begin)/1000,stdout:result.stdout,stderr:result.stderr,error:result.error?.message??null});
  if(result.status!==0)process.exitCode=3;
}
