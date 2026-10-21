import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const [manifestPath,targetPath]=process.argv.slice(2);
if(process.argv.length!==4)throw Error('Usage: preserve-model7-alphazero <private-manifest> <fresh-private-archive>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest=read(manifestPath),source=path.dirname(path.resolve(manifestPath)),target=path.resolve(targetPath),started=Date.now();
if(fs.existsSync(target)||target.startsWith(source+path.sep))throw Error('Fresh archive outside execution source required');
const receipt=read(path.join(manifest.outputDirectory,'receipt.json'));
if(receipt.state!=='completed')throw Error('Finished training receipt required for a stable final archive');
for(const [file,digest]of Object.entries(manifest.filePins))if(hash(file)!==digest)throw Error(`Pinned input changed before preservation: ${file}`);
fs.mkdirSync(target,{recursive:true});const files=[];
function copy(file,destination,relative) {
  fs.mkdirSync(path.dirname(destination),{recursive:true});const digest=hash(file);fs.copyFileSync(file,destination);
  if(hash(destination)!==digest||hash(file)!==digest)throw Error('Private archive copy changed or failed verification');
  files.push({path:relative.replaceAll('\\','/'),sha256:digest,bytes:fs.statSync(destination).size});
}
function copyTree(directory,relative='') {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    if(entry.name==='__pycache__'||entry.name.endsWith('.tmp')||entry.name==='supervisor-owner.json')continue;
    const file=path.join(directory,entry.name),name=path.join(relative,entry.name);
    if(entry.isDirectory())copyTree(file,name);else copy(file,path.join(target,'execution',name),path.join('execution',name));
  }
}
copyTree(source);
const externalPins=[];
for(const [file,digest]of Object.entries(manifest.filePins)) {
  if(file===source||file.startsWith(source+path.sep))continue;
  const relative=path.join('external-inputs',digest,path.basename(file));
  const destination=path.join(target,relative);
  if(!fs.existsSync(destination))copy(file,destination,relative);
  externalPins.push({originalPath:file,archivedPath:relative.replaceAll('\\','/'),sha256:digest});
}
const preservation={schema:'model7-alphazero-private-preservation/1',at:new Date().toISOString(),
  executionManifestSha256:hash(manifestPath),finalCheckpointSha256:receipt.checkpointSha256,
  completedTrainingGames:receipt.completedTrainingGames,completedBatchUpdates:receipt.completedBatchUpdates,
  elapsedSeconds:(Date.now()-started)/1000,files,externalPins,private:true,published:false};
fs.writeFileSync(path.join(target,'drive-preservation-manifest.json'),JSON.stringify(preservation,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({archive:target,verifiedFiles:files.length,elapsedSeconds:preservation.elapsedSeconds,
  manifestSha256:hash(path.join(target,'drive-preservation-manifest.json'))}));
