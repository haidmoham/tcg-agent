// One approved fixed-deck continuation. No demonstrations, search or client input.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) throw Error('Usage: run-model7-outcome <approved-private-manifest>');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = read(manifestPath), manifestSha256 = hash(manifestPath);
if (manifest.schema !== 'model7-outcome-pilot/1' || manifest.approval !== 'approved'
    || JSON.stringify(manifest.reward) !== JSON.stringify({version:'natural-terminal-w1-d0-lminus1/1',win:1,draw:0,loss:-1,nonterminal:0})
    || manifest.batches.length !== 4 || manifest.batches.some(batch => batch.tasks.length !== 6)) throw Error('Exact approved outcome pilot required');
const runtime = manifest.runtimeRoot, output = manifest.outputDirectory;
if (fs.existsSync(output)) throw Error('Fresh pilot output required; inspect uncertain previous effects before retrying');
fs.mkdirSync(output, {recursive:true});
const save = (name, value) => fs.writeFileSync(path.join(output, name), `${JSON.stringify(value,null,2)}\n`);
const event = value => fs.appendFileSync(path.join(output,'events.jsonl'), `${JSON.stringify({at:new Date().toISOString(),...value})}\n`);
const started = Date.now(), deadline = Math.min(started + 8100000, manifest.approvedDeadlineUtc ? Date.parse(manifest.approvedDeadlineUtc) : Infinity);
if (!Number.isFinite(deadline) || deadline <= started) throw Error('Approved overall deadline expired');
const state = {schema:'model7-outcome-pilot-status/1',at:new Date().toISOString(),startedAtUtc:new Date(started).toISOString(),pid:process.pid,
  state:'running',phase:'preflight',manifestSha256,reward:manifest.reward,completedTrainingGames:0,plannedTrainingGames:24,
  completedBatchUpdates:0,baselineUpdateCount:23,optimizerSteps:0,collectionSeconds:0,fittingSeconds:0,
  checkpoint:manifest.initialCheckpoint,checkpointSha256:manifest.initialCheckpointSha256,validation:null,confirmation:null,
  failures:[],promoted:false};
const status = () => {state.at=new Date().toISOString();state.elapsedSeconds=(Date.now()-started)/1000;save('status.json',state);};
const assertPins = () => {
  if (hash(manifestPath)!==manifestSha256) throw Error('Approved run manifest changed');
  for (const [file,digest] of Object.entries(manifest.filePins)) if(hash(file)!==digest) throw Error('Pinned input/source changed');
};
let activeChild=null, cancelled=null;
const stopChild = child => process.platform==='win32'
  ? spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}) : child.kill();
const interrupt = () => {cancelled='operator-interrupted';if(activeChild)stopChild(activeChild);};
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
const remaining = () => Math.max(0,Math.floor((deadline-Date.now())/1000));
async function command(executable,args,seconds,label,environment={}) {
  if(cancelled||seconds<1||remaining()<1)throw Error(cancelled??'global-wall-budget');
  const begin=Date.now(),log=fs.openSync(path.join(output,`${label}.stdout.log`),'wx'),err=fs.openSync(path.join(output,`${label}.stderr.log`),'wx');
  const child=spawn(executable,args,{cwd:runtime,windowsHide:true,stdio:['ignore',log,err],env:{...process.env,...environment,PYTHONUNBUFFERED:'1'}});
  activeChild=child;state.activeChildPid=child.pid;status();event({type:'child-start',label,pid:child.pid,maximumSeconds:seconds});
  let expired=false;const timer=setTimeout(()=>{expired=true;stopChild(child);},Math.min(seconds,remaining())*1000);
  try{const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',accept);});
    if(expired||cancelled||code!==0)throw Error(expired?`${label}-wall-budget`:cancelled??`${label}-exit-${code}`);
    return (Date.now()-begin)/1000;
  }finally{clearTimeout(timer);fs.closeSync(log);fs.closeSync(err);activeChild=null;delete state.activeChildPid;}
}
const pulse=setInterval(()=>{
  if(state.phase==='collection'&&state.batch){
    const directory=path.join(runtime,'runs',`model7-outcome-001-batch-${state.batch}`);
    let completed=0;for(const task of manifest.batches[state.batch-1].tasks){try{if(read(path.join(directory,task.id,'receipt.json')).completedNaturally===true)completed++;}catch{}}
    state.activeBatchFinishedGames=completed;
  }
  status();
},15000);
status();save('manifest.json',manifest);event({type:'pilot-start',reward:manifest.reward});
try {
  assertPins();
  const {runEntityPpoRollout}=await import(pathToFileURL(path.join(runtime,'scripts/entity-ppo-rollout.mjs')));
  for (let batch=0;batch<4;batch++) {
    if(cancelled||remaining()<1)throw Error(cancelled??'global-wall-budget');
    const collectionRemaining=1800-state.collectionSeconds;
    if(collectionRemaining<1||120-state.fittingSeconds<1)throw Error('training-phase-budget-exhausted');
    assertPins();state.phase='collection';state.batch=batch+1;status();
    const ppoConfig={...manifest.ordinaryConfig,checkpoint:state.checkpoint};
    const configFile=path.join(output,`batch-${batch+1}-ppo.json`);fs.writeFileSync(configFile,JSON.stringify(ppoConfig,null,2));
    const plan={...manifest.collectionPlan,ppoConfig:configFile,tasks:manifest.batches[batch].tasks,
      maximumWallSeconds:Math.min(Math.floor(collectionRemaining),remaining())};
    const planFile=path.join(output,`batch-${batch+1}-plan.json`);fs.writeFileSync(planFile,JSON.stringify(plan,null,2));
    event({type:'collection-start',batch:batch+1,parent:state.checkpointSha256});
    const begin=Date.now(),tag=`model7-outcome-001-batch-${batch+1}`;
    const receipt=await runEntityPpoRollout(manifest.nativeConfig,tag,planFile);
    state.collectionSeconds+=(Date.now()-begin)/1000;
    const natural=receipt.episodes.filter(row=>row.completedNaturally===true);
    state.completedTrainingGames+=natural.length;delete state.activeBatchFinishedGames;state.lastCollection={batch:batch+1,counts:receipt.counts,records:receipt.recordsCount};status();
    event({type:'collection-complete',batch:batch+1,counts:receipt.counts,records:receipt.recordsCount});
    if(receipt.fatal||natural.length!==6||receipt.unattempted.length||receipt.counts.excluded||receipt.counts.errors
        ||receipt.counts.rejected||receipt.deterministic!==false||receipt.rewardVersion!==manifest.reward.version)
      throw Error('incomplete-or-unqualified-training-batch');
    state.phase='fitting';status();
    const checkpoint=path.join(manifest.modelDirectory,`update-${batch+1}.pt`);
    const seconds=await command(manifest.python,['-u','-m','learning.entity_ppo_runtime','update',state.checkpoint,
      path.join(runtime,'runs',tag),checkpoint,'--catalog',manifest.catalog,'--device','cuda'],
      Math.floor(120-state.fittingSeconds),`batch-${batch+1}-update`,{PTCG_AGENT_MODEL_ROOT:manifest.modelDirectory});
    state.fittingSeconds+=seconds;
    const update=read(checkpoint.replace(/\.pt$/,'.receipt.json'));
    if(update.checkpointSha256!==hash(checkpoint)||update.reloadLogitsExact!==true||update.reloadValuesExact!==true
        ||update.parentCheckpointSha256!==state.checkpointSha256||update.updateCount!==24+batch)
      throw Error('updated-checkpoint-lineage-or-reload-proof-failed');
    state.checkpoint=checkpoint;state.checkpointSha256=update.checkpointSha256;state.completedBatchUpdates++;
    state.optimizerSteps+=update.metrics.optimizerSteps;state.lastUpdate=update.metrics;status();
    event({type:'update-complete',batch:batch+1,checkpointSha256:state.checkpointSha256,metrics:update.metrics});assertPins();
  }
  state.phase='validation';status();
  const finalConfig=path.join(output,'final-ppo.json');fs.writeFileSync(finalConfig,JSON.stringify({...manifest.ordinaryConfig,checkpoint:state.checkpoint},null,2));
  const validationPlan={...manifest.collectionPlan,mode:'evaluate',ppoConfig:finalConfig,tasks:manifest.validationTasks,maximumWallSeconds:Math.min(600,remaining())};
  const validationFile=path.join(output,'validation-plan.json');fs.writeFileSync(validationFile,JSON.stringify(validationPlan,null,2));
  const validation=await runEntityPpoRollout(manifest.nativeConfig,'model7-outcome-001-validation',validationFile);
  state.validation={counts:validation.counts,fatal:validation.fatal,unattempted:validation.unattempted.length};status();event({type:'validation-complete',...state.validation});
  if(validation.fatal||validation.episodes.length!==8||validation.episodes.some(row=>row.completedNaturally!==true))throw Error('validation-incomplete-or-failed');
  assertPins();state.phase='confirmation';status();
  const candidate=path.join(output,'final-bundle');fs.mkdirSync(candidate);
  fs.copyFileSync(state.checkpoint,path.join(candidate,'ordinary-candidate.pt'));
  fs.copyFileSync(manifest.selectionCheckpoint,path.join(candidate,'selection-candidate.pt'));
  const protocol=read(manifest.confirmationProtocol),protocolSha=hash(manifest.confirmationProtocol);
  const finalReceipt={schema:'model7-outcome-pilot-final-bundle/1',confirmationMeasured:false,training:'outcome-ppo',
    candidateSha256:{ordinary:state.checkpointSha256,selection:manifest.selectionCheckpointSha256},
    evaluationProtocol:{sha256:protocolSha,protocol},trainingManifestSha256:manifestSha256,batchUpdates:4,
    optimizerSteps:state.optimizerSteps,reward:manifest.reward};
  fs.writeFileSync(path.join(candidate,'receipt.json'),JSON.stringify(finalReceipt,null,2));
  await command(process.execPath,[path.join(runtime,'scripts/compare-bootstrap-mirror.mjs'),path.dirname(manifest.confirmationProtocol),candidate,
    path.join(output,'confirmation')],Math.min(5400,remaining()),'confirmation');
  const confirmation=read(path.join(output,'confirmation/receipt.json'));
  state.confirmation={state:confirmation.state,validBlocks:confirmation.validBlocks,completedGames:confirmation.completedScoredGames,
    invalidBlocks:confirmation.invalidBlocks,analysis:confirmation.analysis,receiptSha256:hash(path.join(output,'confirmation/receipt.json'))};
  assertPins();if(confirmation.state!=='completed')throw Error('confirmation-incomplete');
  state.state='completed';state.phase='finished';event({type:'pilot-complete',confirmation:state.confirmation});
} catch(error) {
  state.state='incomplete';state.failures.push({at:new Date().toISOString(),phase:state.phase,reason:error.message});
  event({type:'pilot-stopped',phase:state.phase,reason:error.message});process.exitCode=2;
} finally {
  clearInterval(pulse);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);status();save('receipt.json',state);
}
