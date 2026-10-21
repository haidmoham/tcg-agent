import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const [originalPath,protocolPath,sourceRoot,probeRecords]=process.argv.slice(2);
if(process.argv.length!==6)throw Error('Usage: prepare-model7-alphazero-recovery <original-manifest> <protocol-v4> <qualified-source-root> <probe-records>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const previous=read(originalPath),protocol=read(protocolPath),root=path.dirname(path.resolve(originalPath));
const statusPath=path.join(previous.outputDirectory,'status.json'),status=read(statusPath);
const originalManifestSha256=hash(originalPath),protocolSha256=hash(protocolPath);
if(protocol.version!==4||protocolSha256!=='123abf9442f2413a155a934a8f5970254ec3cbc43f53eeac9549642e8c91c7f3'
  ||status.manifestSha256!==originalManifestSha256||status.state!=='paused'||status.completedBatchUpdates!==0
  ||status.checkpointSha256!==previous.initialCheckpointSha256||status.nextBatch!==1
  ||status.trainingStartedAtUtc!==protocol.training.startUtc||status.deadlineUtc!==protocol.training.deadlineUtc)
  throw Error('Exact pre-fit paused lineage and version-four recovery required');
try {process.kill(status.pid,0);throw Error('Old supervisor is still running');}catch(error){if(error.code!=='ESRCH')throw error;}
for(const [file,digest]of Object.entries(previous.filePins))if(hash(file)!==digest)throw Error(`Original sealed input changed: ${file}`);
const runtime=path.join(root,'alphazero-runtime-v4'),destination=path.join(root,'alphazero-manifest-v4.json');
if(fs.existsSync(runtime)||fs.existsSync(destination))throw Error('Fresh recovery preparation required; inspect any prior effects');
fs.cpSync(previous.runtimeRoot,runtime,{recursive:true,errorOnExist:true,force:false,
  filter:file=>!file.split(path.sep).includes('__pycache__')&&!file.endsWith('.pyc')});
const overrides=['learning/alphazero-search.mjs','agents/alphazero-agent.mjs',
  'integrations/local-worker/alphazero-training-episode.mjs','scripts/alphazero-selfplay.mjs',
  'scripts/run-model7-alphazero.mjs','scripts/model7-atomic-json.mjs','scripts/reseal-model7-alphazero.py','scripts/profile-alphazero-collection.mjs'];
const sourceChanges=[];
for(const relative of overrides){const source=path.join(sourceRoot,relative),target=path.join(runtime,relative);
  sourceChanges.push({relative,before:fs.existsSync(target)?hash(target):null,after:hash(source)});fs.copyFileSync(source,target);}
if(hash(path.join(runtime,'learning/alphazero-search.mjs'))===hash(path.join(previous.runtimeRoot,'learning/alphazero-search.mjs')))
  throw Error('Qualified empty-domain source repair has not been supplied');
const localProtocol=path.join(root,'alphazero-protocol-v4.json');
if(fs.existsSync(localProtocol)){if(hash(localProtocol)!==protocolSha256)throw Error('Existing recovery protocol differs');}
else fs.copyFileSync(protocolPath,localProtocol,fs.constants.COPYFILE_EXCL);
const checkpoint=path.join(previous.modelDirectory,'alphazero-initial-recovery-v4.pt');
const result=spawnSync(previous.python,['-u','scripts/reseal-model7-alphazero.py',status.checkpoint,checkpoint,
  '--catalog',previous.catalog,'--probe-records',path.resolve(probeRecords),'--protocol-sha256',protocolSha256],
  {cwd:runtime,windowsHide:true,encoding:'utf8',env:{...process.env,PTCG_AGENT_MODEL_ROOT:previous.modelDirectory}});
if(result.status!==0)throw Error(`Metadata-only recovery reseal failed: ${result.stderr}`);
const receiptPath=checkpoint.replace(/\.pt$/,'.receipt.json'),receipt=read(receiptPath);
if(!receipt.metadataOnlyReseal||!receipt.reloadPolicyValueExact||receipt.updateCount!==0||receipt.fits!==0
  ||Object.values(receipt.unchangedTrainingStateFields).some(value=>value!==true)
  ||receipt.metadataResealParentSha256!==status.checkpointSha256||receipt.checkpointSha256!==hash(checkpoint))
  throw Error('Recovery changed initialized training state');
const isOldRuntime=file=>file.startsWith(previous.runtimeRoot+path.sep);
const filePins=Object.fromEntries(Object.entries(previous.filePins).filter(([file])=>!isOldRuntime(file)));
const sourcePins=Object.fromEntries(Object.entries(previous.sourcePins).filter(([file])=>!isOldRuntime(file)));
function pinTree(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);if(entry.isDirectory()){if(entry.name!=='__pycache__')pinTree(file);}
  else if(!entry.name.endsWith('.pyc')){filePins[file]=hash(file);sourcePins[file]=hash(file);}}}
pinTree(runtime);
Object.assign(filePins,{[localProtocol]:protocolSha256,[checkpoint]:hash(checkpoint),[receiptPath]:hash(receiptPath)});
const episodeModule=path.join(runtime,'integrations/local-worker/alphazero-training-episode.mjs');
const episodeRunner={module:episodeModule,sha256:hash(episodeModule),
  sourcePins:Object.fromEntries(Object.entries(sourcePins).filter(([file])=>file.startsWith(runtime+path.sep))),maximumGameSeconds:3600};
const modelConfig={...previous.modelConfig,runtimeRoot:runtime,checkpoint,checkpointSha256:hash(checkpoint)};
const manifest={...previous,at:new Date().toISOString(),protocol:localProtocol,protocolSha256,
  startPolicy:protocol.training.startPolicy,runtimeRoot:runtime,initialCheckpoint:checkpoint,initialCheckpointSha256:hash(checkpoint),
  initializationReceiptSha256:hash(receiptPath),factoryModule:path.join(runtime,'agents/alphazero-agent.mjs'),
  modelConfig,filePins,sourcePins,episodeRunner,
  recovery:{originalManifest:path.resolve(originalPath),originalManifestSha256,originalInitializationSha256:previous.initialCheckpointSha256,
    sourceChanges,metadataOnlyResealReceiptSha256:hash(receiptPath),excludedBatchIndices:[1],nextBatchIndex:2,
    trainingStartedAtUtc:status.trainingStartedAtUtc,deadlineUtc:status.deadlineUtc},
  collectionPlan:{...previous.collectionPlan,runtimeRoot:runtime,maximumGameSeconds:3600,filePins,modelConfig}};
save(destination,manifest);
save(path.join(previous.outputDirectory,'status-before-recovery-v4.json'),status);
const next={...status,manifestSha256:hash(destination),protocolSha256,state:'paused',phase:'between-batches',
  checkpoint,checkpointSha256:hash(checkpoint),skippedBatches:[...status.skippedBatches,{batchIndex:1,
    reason:'engineering-recovery-whole-batch-excluded',evidenceDirectory:path.join(previous.outputDirectory,'batch-1')}],
  recovery:manifest.recovery,at:new Date().toISOString()};
const temp=`${statusPath}.recovery.tmp`;save(temp,next);fs.renameSync(temp,statusPath);
save(path.join(root,'recovery-v4-preparation-receipt.json'),{at:new Date().toISOString(),manifest:destination,
  manifestSha256:hash(destination),checkpoint,checkpointSha256:hash(checkpoint),sourceChanges,
  noFits:true,metadataOnlyReseal:true,trainingStartedAtUtc:status.trainingStartedAtUtc,deadlineUtc:status.deadlineUtc});
console.log(JSON.stringify({manifest:destination,manifestSha256:hash(destination),checkpointSha256:hash(checkpoint),noFits:true}));
