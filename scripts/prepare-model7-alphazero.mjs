import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const [inputsPath,protocolPath]=process.argv.slice(2);
if(process.argv.length!==4)throw Error('Usage: prepare-model7-alphazero <private-inputs> <qualified-protocol-v3>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs=read(inputsPath),protocol=read(protocolPath),prepared=read(inputs.preparedManifest);
const root=path.dirname(path.resolve(inputs.preparedManifest)),repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(protocol.version!==3||protocol.training.batchGames!==16||protocol.training.allocatedSeconds!==21600
  ||prepared.initialCheckpointSha256!==protocol.initialization.originalOrdinarySha256
  ||prepared.selectionCheckpointSha256!==protocol.initialization.selectorSha256)throw Error('Selected AlphaZero design and preserved baseline required');
for(const [file,digest]of Object.entries(prepared.filePins))if(hash(file)!==digest)throw Error(`Original prepared artifact changed: ${file}`);
const runtime=path.join(root,'alphazero-runtime'),initial=path.join(prepared.modelDirectory,'alphazero-initial.pt');
if(fs.existsSync(runtime)||fs.existsSync(initial))throw Error('Fresh AlphaZero runtime required; inspect prior effects before retry');
fs.mkdirSync(runtime);
for(const directory of ['agents','learning','integrations','environment','scripts','src'])
  fs.cpSync(path.join(inputs.sourceRoot??repo,directory),path.join(runtime,directory),{recursive:true,
    filter:file=>!file.split(path.sep).includes('__pycache__')&&!file.endsWith('.pyc')});
const performance=read(inputs.performanceConfig),originalNative=read(prepared.nativeConfig),native={...originalNative};
for(const key of ['worker','workerSha256','workerSourceRoot','workerSourceSha256','implementationVersion','referenceWorkerSha256'])native[key]=performance[key];
if(native.workerSha256!=='7a85f20df1616cc3d7b041f437b8a9c066800570a40bcf41e7ae34236507b83b'
  ||native.implementationVersion!=='native-state-copy/1.0.0')throw Error('Qualified state-copy worker required');
const {verifyLocalInputs}=await import(pathToFileURL(path.join(runtime,'integrations/local-worker/probe.mjs')));
const sourcePins={},filePins={...prepared.filePins};
const frozenEnvironment=read(inputs.environmentConfig);
Object.assign(filePins,frozenEnvironment.filePins,{[path.resolve(inputs.environmentConfig)]:hash(inputs.environmentConfig),
  [path.resolve(inputs.performanceHandoff)]:hash(inputs.performanceHandoff)});
function pinTree(directory,sources=false,allBehavior=false) {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()){if(!['__pycache__','runs'].includes(entry.name))pinTree(file,sources,allBehavior);}
    else if(!entry.name.endsWith('.pyc')){filePins[file]=hash(file);if(sources&&(allBehavior||/\.(mjs|py|json|cs)$/.test(file)))sourcePins[file]=hash(file);}
  }
}
function snapshotNative(config,name) {
  const folder=path.join(root,name);
  fs.cpSync(path.dirname(config.worker),path.join(folder,'bin'),{recursive:true,errorOnExist:true,force:false});
  fs.cpSync(config.workerSourceRoot,path.join(folder,'source'),{recursive:true,errorOnExist:true,force:false});
  config.worker=path.join(folder,'bin',path.basename(config.worker));config.workerSourceRoot=path.join(folder,'source');
  verifyLocalInputs(config);pinTree(folder,true,true);
}
snapshotNative(native,'actual-native-pack');
const actualNative=path.join(root,'actual-native-state-copy.json');fs.writeFileSync(actualNative,JSON.stringify(native,null,2)+'\n',{flag:'wx'});
const searchNative={...originalNative},searchBuild=read(inputs.searchNativeConfig);
for(const key of ['worker','workerSha256','workerSourceRoot','workerSourceSha256','implementationVersion','referenceWorkerSha256'])
  if(searchBuild[key]!==undefined)searchNative[key]=searchBuild[key];
snapshotNative(searchNative,'search-native-pack');
const searchNativePath=path.join(root,'search-native.json');fs.writeFileSync(searchNativePath,JSON.stringify(searchNative,null,2)+'\n',{flag:'wx'});
for(const config of [native,searchNative]) {
  filePins[config.worker]=hash(config.worker);filePins[config.executable]=hash(config.executable);
  for(const [relative,digest]of Object.entries(config.workerSourceSha256??{})) {
    const file=path.join(config.workerSourceRoot,relative);if(hash(file)!==digest)throw Error('Native authored source changed');
    filePins[file]=digest;sourcePins[file]=digest;
  }
  pinTree(path.dirname(config.worker));
}
filePins[actualNative]=hash(actualNative);sourcePins[actualNative]=hash(actualNative);
filePins[searchNativePath]=hash(searchNativePath);sourcePins[searchNativePath]=hash(searchNativePath);
for(const config of [native,searchNative]) {
  const bundleManifest=path.join(config.bundleRoot,'manifest.json');sourcePins[bundleManifest]=hash(bundleManifest);
  for(const row of read(bundleManifest).files){const file=path.join(config.bundleRoot,row.path);sourcePins[file]=hash(file);}
  sourcePins[config.policyModule]=hash(config.policyModule);
}
const init=spawnSync(prepared.python,['-u','-m','learning.alphazero_runtime','init',prepared.initialCheckpoint,initial,
  '--catalog',prepared.catalog,'--probe-records',inputs.probeRecords],{cwd:runtime,windowsHide:true,encoding:'utf8',
  env:{...process.env,PYTHONUNBUFFERED:'1',PTCG_AGENT_MODEL_ROOT:prepared.modelDirectory}});
if(init.status!==0)throw Error(`AlphaZero warm start failed: ${init.stderr}`);
const initReceipt=initial.replace(/\.pt$/,'.receipt.json'),initialized=read(initReceipt);
if(initialized.warmStartAllTensorsExact!==true||initialized.optimizerResetForNewObjective!==true||initialized.reloadPolicyValueExact!==true
  ||initialized.updateCount!==0||initialized.checkpointSha256!==hash(initial))throw Error('AlphaZero initialization proof incomplete');
filePins[initial]=hash(initial);filePins[initReceipt]=hash(initReceipt);pinTree(runtime,true);
const localProtocol=path.join(root,'alphazero-protocol-v3.json');fs.copyFileSync(protocolPath,localProtocol,fs.constants.COPYFILE_EXCL);filePins[localProtocol]=hash(localProtocol);
const knownDecks=Object.fromEntries(['human','opponent'].map((seat,index)=>[seat,verifyLocalInputs(originalNative).selected[index]]));
const searchOptions={determinizations:protocol.search.determinizations,simulations:protocol.search.simulationsPerWorld,
  maxDepth:protocol.search.maximumDepth,cPuct:protocol.search.cPuct,temperature:0,rootNoise:false};
const playerConfig={providerOptions:{nativeConfig:searchNative,...(inputs.providerOptions??{})},knownDecks,searchOptions};
const modelConfig={...prepared.ordinaryConfig,runtimeRoot:runtime,checkpoint:initial,checkpointSha256:hash(initial)};
const manifest={schema:'model7-alphazero-execution/1',at:new Date().toISOString(),protocol:localProtocol,protocolSha256:hash(localProtocol),
  startPolicy:protocol.training.startPolicy??'fixed-window',
  archiveDirectory:inputs.archiveDirectory??null,
  runtimeRoot:runtime,outputDirectory:path.join(root,'overnight-run'),modelDirectory:prepared.modelDirectory,python:prepared.python,
  catalog:prepared.catalog,initialCheckpoint:initial,initialCheckpointSha256:hash(initial),initializationReceiptSha256:hash(initReceipt),
  factoryModule:path.join(runtime,'agents/alphazero-agent.mjs'),sourcePins,playerConfig,filePins,modelConfig,
  sourceCommits:inputs.sourceCommits??{},performanceAdoption:{implementationVersion:native.implementationVersion,workerSha256:native.workerSha256,
    referenceWorkerSha256:native.referenceWorkerSha256,handoffSha256:hash(inputs.performanceHandoff)},
  collectionPlan:{schema:'alphazero-selfplay-plan/1',runtimeRoot:runtime,environmentConfig:inputs.environmentConfig,nativeConfig:actualNative,
    teacherCatalogPath:path.join(root,'teacher-catalog.json'),workers:protocol.training.workers,
    maximumGameSeconds:protocol.training.maximumGameSeconds,maximumGameCommands:protocol.training.maximumGameCommands,
    filePins,playerConfig:{...playerConfig,searchOptions:{...searchOptions,temperature:1,rootNoise:true}}}};
const destination=path.join(root,'alphazero-manifest.json');fs.writeFileSync(destination,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({manifest:destination,manifestSha256:hash(destination),protocolSha256:manifest.protocolSha256,
  checkpointSha256:manifest.initialCheckpointSha256,initializationReceiptSha256:hash(initReceipt),games:0,fits:0}));
