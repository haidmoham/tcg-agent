import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';

const [manifestPath, resume] = process.argv.slice(2);
if (!manifestPath || process.argv.length > 4 || resume && resume !== '--resume')
  throw Error('Usage: run-model7-overnight <private-manifest> [--resume]');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = read(manifestPath), manifestSha256 = hash(manifestPath), protocol = read(manifest.protocol);
if (manifest.schema !== 'model7-overnight-execution/1' || manifest.approval !== 'approved'
    || protocol.schema !== 'model7-overnight-design/1' || hash(manifest.protocol) !== manifest.protocolSha256)
  throw Error('Frozen approved overnight manifest required');
const output = manifest.outputDirectory, start = Date.parse(protocol.training.startUtc), deadline = Date.parse(protocol.training.deadlineUtc);
if (!Number.isFinite(start) || deadline - start !== 21600000) throw Error('Fixed six-hour window required');
if (!resume && fs.existsSync(output)) throw Error('Fresh output required; inspect prior effects before --resume');
fs.mkdirSync(output, {recursive:true});
const save = (name, value) => {
  const file = path.join(output, name), temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value,null,2)+'\n'); fs.renameSync(temporary,file);
};
const event = value => fs.appendFileSync(path.join(output,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...value})+'\n');
const state = resume ? read(path.join(output,'status.json')) : {
  schema:'model7-overnight-status/1', manifestSha256, protocolSha256:manifest.protocolSha256,
  state:'scheduled', phase:'waiting', startUtc:protocol.training.startUtc, deadlineUtc:protocol.training.deadlineUtc,
  checkpoint:manifest.initialCheckpoint, checkpointSha256:manifest.initialCheckpointSha256,
  completedTrainingGames:0, collectedNaturalGames:0, completedBatchUpdates:0, optimizerSteps:0,
  collectionSeconds:0, fittingSeconds:0, nextBatch:0, batches:[], skippedBatches:[], failures:[], promoted:false};
if (state.manifestSha256 !== manifestSha256 || state.protocolSha256 !== manifest.protocolSha256
    || state.state === 'completed') throw Error('Resume identity mismatch or already completed');
const ownerPath=path.join(output,'supervisor-owner.json');
if(fs.existsSync(ownerPath)) {
  const previous=read(ownerPath);
  try {process.kill(previous.pid,0);throw Error('Existing supervisor is still running');}
  catch(error) {if(error.code!=='ESRCH')throw error;}
  if(!resume) throw Error('Inspect interrupted supervisor before --resume');
  fs.unlinkSync(ownerPath);
}
fs.writeFileSync(ownerPath,JSON.stringify({pid:process.pid,manifestSha256}),{flag:'wx'});
const remaining = () => Math.max(0,Math.floor((deadline-Date.now())/1000));
let activeChild = null, cancelled = false;
const status = () => {state.at=new Date().toISOString();state.pid=process.pid;state.activeChildPid=activeChild?.pid??null;save('status.json',state);};
const assertPins = () => {
  if(hash(manifestPath)!==manifestSha256) throw Error('Execution manifest changed');
  for(const [file,digest] of Object.entries(manifest.filePins)) if(hash(file)!==digest) throw Error(`Pinned input changed: ${file}`);
  if(hash(state.checkpoint)!==state.checkpointSha256) throw Error('Last admitted checkpoint changed');
};
const stopChild = child => process.platform === 'win32'
  ? spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}) : child.kill('SIGTERM');
const interrupt = () => {cancelled=true;if(activeChild)stopChild(activeChild);};
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
async function command(executable,args,label,seconds) {
  const begin=Date.now(), stdout=fs.openSync(path.join(output,`${label}.stdout.log`),'ax'), stderr=fs.openSync(path.join(output,`${label}.stderr.log`),'ax');
  let expired=false;
  activeChild=spawn(executable,args,{cwd:manifest.runtimeRoot,windowsHide:true,stdio:['ignore',stdout,stderr],
    env:{...process.env,PYTHONUNBUFFERED:'1',PTCG_AGENT_MODEL_ROOT:manifest.modelDirectory}});
  const child=activeChild;status();event({type:'child-start',label,pid:child.pid,maximumSeconds:seconds});
  const timer=setTimeout(()=>{expired=true;stopChild(child);},Math.max(1,Math.min(seconds,remaining()))*1000);
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    return {code,expired,seconds:(Date.now()-begin)/1000,startedAtUtc:new Date(begin).toISOString(),completedAtUtc:new Date().toISOString()};
  } finally {clearTimeout(timer);fs.closeSync(stdout);fs.closeSync(stderr);activeChild=null;status();}
}
function adoptUpdate(batch, checkpoint, parent, completedAtUtc) {
  const receiptPath=checkpoint.replace(/\.pt$/,'.receipt.json'), update=read(receiptPath);
  if (Date.parse(completedAtUtc)>deadline || update.checkpointSha256!==hash(checkpoint)
      || update.parentCheckpointSha256!==parent || update.reloadLogitsExact!==true || update.reloadValuesExact!==true
      || update.updateCount!==24+state.completedBatchUpdates || !isDeepStrictEqual(update.ppoConfig,protocol.ppoConfig))
    throw Error('Update lineage/config/reload/deadline admission failed');
  state.checkpoint=checkpoint;state.checkpointSha256=update.checkpointSha256;state.completedBatchUpdates++;
  state.completedTrainingGames+=64;state.optimizerSteps+=update.metrics.optimizerSteps;
  const announcement={checkpoint,checkpointSha256:state.checkpointSha256,completedAtUtc,
    completedTrainingGames:state.completedTrainingGames,completedBatchUpdates:state.completedBatchUpdates,
    optimizerSteps:state.optimizerSteps,reloadVerified:true,batchIndex:batch.index,parentCheckpointSha256:parent,
    updateCount:update.updateCount,receiptSha256:hash(receiptPath)};
  const announcementsPath=path.join(output,'checkpoint-announcements.jsonl');
  const announced=fs.existsSync(announcementsPath)?fs.readFileSync(announcementsPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  if(!announced.some(row=>row.checkpointSha256===announcement.checkpointSha256))
    fs.appendFileSync(announcementsPath,JSON.stringify(announcement)+'\n');
  state.lastAnnouncement=announcement;
  state.batches.push({...announcement,metrics:update.metrics});status();event({type:'checkpoint-admitted',...announcement});
}
const pulse=setInterval(status,15000);
try {
  assertPins();
  if(resume && state.phase==='fitting' && state.pendingUpdate) {
    const pending=state.pendingUpdate, receiptPath=pending.checkpoint.replace(/\.pt$/,'.receipt.json');
    if(state.checkpoint!==pending.checkpoint && fs.existsSync(receiptPath)) adoptUpdate({index:pending.batchIndex},pending.checkpoint,pending.parent,
      fs.statSync(receiptPath).mtime.toISOString());
    else if(state.checkpoint!==pending.checkpoint) {state.skippedBatches.push({batchIndex:pending.batchIndex,reason:'interrupted-update-without-reload-receipt'});event({type:'unadmitted-update-preserved',...pending});}
    delete state.pendingUpdate;
  } else if(resume && state.phase==='collection') {
    state.skippedBatches.push({batchIndex:state.nextBatch,reason:'interrupted-collection-whole-batch-discarded'});
  }
  event({type:resume?'supervisor-resumed':'supervisor-scheduled',startUtc:state.startUtc,deadlineUtc:state.deadlineUtc});status();
  while(Date.now()<start && !cancelled) await new Promise(resolve=>setTimeout(resolve,Math.min(15000,start-Date.now())));
  if(cancelled) throw Error('operator-interrupted');
  state.state='running';state.trainingStartedAtUtc??=new Date().toISOString();status();assertPins();
  for(let index=state.nextBatch;index<protocol.training.batches.length && remaining()>1 && !cancelled;index++) {
    const batch=protocol.training.batches[index], tag=`model7-overnight-001-batch-${batch.index}`;
    state.nextBatch=index+1;state.phase='collection';state.batchIndex=batch.index;status();assertPins();
    const ppoConfig=path.join(output,`batch-${batch.index}-ppo.json`), planPath=path.join(output,`batch-${batch.index}-plan.json`);
    save(`batch-${batch.index}-ppo.json`,{...manifest.ordinaryConfig,checkpoint:state.checkpoint});
    const wall=Math.min(protocol.training.maximumCollectionSecondsPerBatch,Math.max(1,remaining()-5));
    save(`batch-${batch.index}-plan.json`,{...manifest.collectionPlan,ppoConfig,tasks:batch.tasks,
      maximumWallSeconds:wall,maximumGameSeconds:protocol.training.maximumGameSeconds,maximumGameCommands:protocol.training.maximumGameCommands});
    const collected=await command(process.execPath,['scripts/entity-ppo-rollout.mjs',manifest.nativeConfig,tag,planPath],`batch-${batch.index}-collection`,wall+4);
    state.collectionSeconds+=collected.seconds;assertPins();
    const rolloutDirectory=path.join(manifest.runtimeRoot,'runs',tag), receiptPath=path.join(rolloutDirectory,'receipt.json');
    const receipt=fs.existsSync(receiptPath)?read(receiptPath):null;
    const episodes=receipt?.episodes??(fs.existsSync(rolloutDirectory)?fs.readdirSync(rolloutDirectory,{withFileTypes:true}):[]).filter(entry=>entry.isDirectory())
      .flatMap(entry=>{const file=path.join(rolloutDirectory,entry.name,'receipt.json');return fs.existsSync(file)?[read(file)]:[];});
    save(`batch-${batch.index}-audit.json`,{batchIndex:batch.index,parentCheckpointSha256:state.checkpointSha256,
      rolloutReceipt:receiptPath,collection:collected,episodes:episodes.map(episode=>({episodeId:episode.episodeId,
        seed:episode.seed,opponentPolicy:episode.opponentPolicy,policySeat:episode.policySeat,status:episode.status,
        result:episode.result,natural:episode.completedNaturally===true,decisions:episode.recordsCount??0,
        partialDecisions:episode.partialRecords??0,errorCode:episode.errorCode??null,reason:episode.exclusionReason??episode.reason??null})),
      plannedTasks:batch.tasks,gradientAdmission:'pending; see final batch-admission events and admitted checkpoint rows'});
    const natural=episodes.filter(episode=>episode.completedNaturally===true).length;
    state.collectedNaturalGames+=natural;
    event({type:'collection-complete',batchIndex:batch.index,...collected,counts:receipt?.counts??null});
    if(receipt?.episodes?.some(episode=>/privacy|source|hash|pin|integrity|frozen|catalog|checkpoint/i.test(episode.reason??episode.exclusionReason??'')))
      throw Error('Collection integrity/privacy failure; operator inspection required');
    if(collected.code!==0 || collected.expired || receipt?.fatal || natural!==64 || receipt.unattempted.length
        || receipt.counts.excluded || receipt.counts.errors || receipt.counts.rejected || receipt.deterministic!==false
        || receipt.rewardVersion!==protocol.reward.version || receipt.recordsCount>protocol.ppoConfig.max_records) {
      state.skippedBatches.push({batchIndex:batch.index,naturalGames:natural,reason:'whole-batch-admission-failed',counts:receipt?.counts??null});status();
      event({type:'batch-discarded',batchIndex:batch.index,parentCheckpointSha256:state.checkpointSha256,reason:'whole-batch-admission-failed'});
      if(remaining()<2 || cancelled) break;
      continue;
    }
    if(remaining()<2 || cancelled) {state.skippedBatches.push({batchIndex:batch.index,reason:'deadline-before-fit'});break;}
    const checkpoint=path.join(manifest.modelDirectory,`overnight-batch-${batch.index}.pt`), parent=state.checkpointSha256;
    state.phase='fitting';state.pendingUpdate={batchIndex:batch.index,checkpoint,parent};status();
    const fitted=await command(manifest.python,['-u','-m','learning.entity_ppo_runtime','update',state.checkpoint,
      rolloutDirectory,checkpoint,'--catalog',manifest.catalog,'--device','cuda'],`batch-${batch.index}-update`,remaining());
    state.fittingSeconds+=fitted.seconds;assertPins();event({type:'fitting-complete',batchIndex:batch.index,...fitted});
    if(fitted.code===0 && !fitted.expired && Date.now()<=deadline) adoptUpdate(batch,checkpoint,parent,fitted.completedAtUtc);
    else {state.skippedBatches.push({batchIndex:batch.index,reason:'update-not-admitted',...fitted});status();}
    delete state.pendingUpdate;state.phase='between-batches';status();
  }
  if(cancelled) throw Error('operator-interrupted');
  assertPins();state.state='completed';state.phase='finished';state.finishedAtUtc=new Date().toISOString();
  state.stopReason=remaining()<2?'training-deadline':'predeclared-batch-guard';
  save('final-candidate.json',{schema:'model7-overnight-final-candidate/1',available:state.completedBatchUpdates>0,
    checkpoint:state.checkpoint,checkpointSha256:state.checkpointSha256,selectionSha256:protocol.initialization.selectionSha256,
    completedAtUtc:state.lastAnnouncement?.completedAtUtc??null,
    completedTrainingGames:state.completedTrainingGames,completedBatchUpdates:state.completedBatchUpdates,
    optimizerSteps:state.optimizerSteps,manifestSha256,protocolSha256:manifest.protocolSha256,
    decisionRule:'Last fully admitted reload-verified update completed before the fixed deadline; no selection by wins',
    strength:'unmeasured; fresh independent gameplay confirmation required',promoted:false});
} catch(error) {state.state='failed';state.failures.push({at:new Date().toISOString(),phase:state.phase,reason:error.message});event({type:'supervisor-failed',reason:error.message});process.exitCode=2;}
finally {clearInterval(pulse);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);status();save('receipt.json',state);
  if(read(ownerPath).pid===process.pid)fs.unlinkSync(ownerPath);}
