import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const [manifestPath,protocolPath,handoffPath,sourceRoot]=process.argv.slice(2);
if(process.argv.length!==6)throw Error('Usage: snapshot-model7-search-adoption <current-manifest> <protocol-v5> <qualified-factory-handoff> <execution-source>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const previous=read(manifestPath),protocol=read(protocolPath),handoff=read(handoffPath),root=path.dirname(path.resolve(manifestPath));
if(protocol.version!==5||hash(protocolPath)!=='d0431cd3db68576e7aa59dffd281c320b06a2d2b6f0873b0325f139b900a8d64'
  ||handoff.source.factorySha256!==protocol.adoption.factorySha256||handoff.source.ledgerSha256!==protocol.adoption.ledgerSha256
  ||handoff.nativeWorkerSha256!==protocol.adoption.searchWorkerSha256||hash(previous.factoryModule)!==protocol.adoption.parentFactorySha256)
  throw Error('Exact approved player/belief amendment and qualified parent required');
for(const [file,digest]of Object.entries(previous.filePins))if(hash(file)!==digest)throw Error(`Preserved input changed: ${file}`);
const runtime=path.join(root,'alphazero-runtime-v5'),pack=path.join(root,'search-native-pack-032'),control=path.join(root,'execution-control-003');
if([runtime,pack,control].some(file=>fs.existsSync(file)))throw Error('Fresh adoption snapshot required; inspect prior effects before retry');
fs.cpSync(previous.runtimeRoot,runtime,{recursive:true,errorOnExist:true,force:false,
  filter:file=>!file.split(path.sep).includes('__pycache__')&&!file.endsWith('.pyc')});
for(const [source,relative,digest]of [[handoff.source.factory,'agents/alphazero-agent.mjs',protocol.adoption.factorySha256],
  [handoff.source.ledger,'integrations/local-worker/actor-deck-knowledge.mjs',protocol.adoption.ledgerSha256]]){
  if(hash(source)!==digest)throw Error('Qualified composition source changed');fs.copyFileSync(source,path.join(runtime,relative));}
for(const relative of ['scripts/reseal-model7-alphazero.py','scripts/qualify-model7-search-adoption.mjs'])
  fs.copyFileSync(path.join(sourceRoot,relative),path.join(runtime,relative));
fs.mkdirSync(path.join(control,'scripts'),{recursive:true});
for(const relative of ['scripts/run-model7-alphazero.mjs','scripts/model7-atomic-json.mjs'])fs.copyFileSync(path.join(sourceRoot,relative),path.join(control,relative));
const priorNative=previous.playerConfig.providerOptions.nativeConfig,newBuild=read(handoff.nativeConfig),native={...priorNative};
for(const key of ['worker','workerSha256','workerSourceRoot','workerSourceSha256','implementationVersion','referenceWorkerSha256'])
  if(newBuild[key]!==undefined)native[key]=newBuild[key];
fs.cpSync(path.dirname(native.worker),path.join(pack,'bin'),{recursive:true,errorOnExist:true,force:false});
fs.cpSync(native.workerSourceRoot,path.join(pack,'source'),{recursive:true,errorOnExist:true,force:false});
native.worker=path.join(pack,'bin',path.basename(native.worker));native.workerSourceRoot=path.join(pack,'source');
const {verifyLocalInputs}=await import(pathToFileURL(path.join(runtime,'integrations/local-worker/probe.mjs')));
verifyLocalInputs(native);
const nativePath=path.join(root,'search-native-032.json'),localProtocol=path.join(root,'alphazero-protocol-v5.json'),localHandoff=path.join(root,'search-factory-ledger-handoff.json');
fs.writeFileSync(nativePath,JSON.stringify(native,null,2)+'\n',{flag:'wx'});
fs.copyFileSync(protocolPath,localProtocol,fs.constants.COPYFILE_EXCL);fs.copyFileSync(handoffPath,localHandoff,fs.constants.COPYFILE_EXCL);
const oldPack=path.dirname(path.dirname(priorNative.worker)),under=(file,directory)=>file.startsWith(directory+path.sep);
const sourcePins=Object.fromEntries(Object.entries(previous.sourcePins).filter(([file])=>!under(file,previous.runtimeRoot)&&!under(file,oldPack)&&file!==path.join(root,'search-native.json')));
const filePins={...previous.filePins};
function pinTree(directory,behavior){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);if(entry.isDirectory()){if(entry.name!=='__pycache__')pinTree(file,behavior);}
  else if(!entry.name.endsWith('.pyc')){filePins[file]=hash(file);if(behavior&&!under(file,path.join(runtime,'scripts')))sourcePins[file]=hash(file);}}}
pinTree(runtime,true);pinTree(pack,true);pinTree(control,false);
for(const file of [nativePath,localProtocol,localHandoff])filePins[file]=hash(file);sourcePins[nativePath]=hash(nativePath);
const snapshot={...previous,protocol:localProtocol,protocolSha256:hash(localProtocol),runtimeRoot:runtime,
  factoryModule:path.join(runtime,'agents/alphazero-agent.mjs'),sourcePins,filePins,
  beliefScope:'actor-history-constrained-declared-deck/1',
  playerConfig:{...previous.playerConfig,providerOptions:{...previous.playerConfig.providerOptions,nativeConfig:native}},
  executionController:{module:path.join(control,'scripts/run-model7-alphazero.mjs'),sourcePins:Object.fromEntries(Object.entries(filePins).filter(([file])=>under(file,control)))},
  adoptionSnapshot:{at:new Date().toISOString(),previousManifest:path.resolve(manifestPath),previousManifestSha256:hash(manifestPath),
    qualifiedHandoffSha256:hash(localHandoff),fits:0,games:0},
  collectionPlan:{...previous.collectionPlan,runtimeRoot:runtime,filePins}};
const destination=path.join(root,'search-adoption-v5-snapshot.json');fs.writeFileSync(destination,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({snapshot:destination,sha256:hash(destination),fits:0,games:0,activePlayerUnchanged:true}));
