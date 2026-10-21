import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {verifyLocalInputs} from './probe.mjs';

const [referencePath,outputArgument]=process.argv.slice(2);
if(process.argv.length!==4)throw Error('Usage: prepare-native-search <qualified-state-copy-config> <fresh-private-output>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digest=text=>createHash('sha256').update(text).digest('hex');
const reference=read(referencePath),output=path.resolve(outputArgument),repository=fileURLToPath(new URL('../../',import.meta.url));
verifyLocalInputs(reference);
const relative=path.relative(repository,output);
if(!path.isAbsolute(outputArgument)||fs.existsSync(output)||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)
  ||reference.implementationVersion!=='native-state-copy/1.0.0'||!reference.workerSourceRoot||!reference.workerSourceSha256)
  throw Error('Qualified state-copy source and fresh absolute output outside the checkout required');
const source=path.join(output,'source');fs.mkdirSync(source,{recursive:true});
for(const [name,expected]of Object.entries(reference.workerSourceSha256)){
  if(path.basename(name)!==name||hash(path.join(reference.workerSourceRoot,name))!==expected)throw Error('Reference source pin differs');
  fs.copyFileSync(path.join(reference.workerSourceRoot,name),path.join(source,name));
}
const replaceOnce=(text,before,after)=>{if(text.split(before).length!==2)throw Error('Qualified source entry point differs');return text.replace(before,after);};
const match=path.join(source,'MatchWorker.cs'),program=path.join(source,'Program.cs');
const wire=replaceOnce(fs.readFileSync(match,'utf8'),'        if (IsStopped) throw new InvalidOperationException("worker stopped");',
  '        if (IsStopped) throw new InvalidOperationException("worker stopped");\r\n        if (method != null && method.StartsWith("search-", StringComparison.Ordinal)) return SearchDispatch(method, RequireObject(payload));')+'\r\n';
const diagnostics=replaceOnce(fs.readFileSync(program,'utf8'),'Console.Error.WriteLine($"engine worker stopped: {error.GetType().Name}: {error.Message}");',
  'Console.Error.WriteLine($"engine worker stopped: {error}");')+'\r\n';
if(digest(wire)!=='fb92a08511de028ebc2cb3216520cc74480ed5300ddd26528c2dded405e25cd5'
  ||digest(diagnostics)!=='8273096eb0d3b3cede16cdebc42dcc6f9b650b1254fa8abb38a1e286b96d664b')throw Error('Native search dispatch differs from qualified source');
fs.writeFileSync(match,wire);fs.writeFileSync(program,diagnostics);
const searchSource=fs.readFileSync(new URL('MatchWorker.InformationSearch.cs',import.meta.url),'utf8');
if(digest(searchSource)!=='6a9b10ab3b8bb3fa864e0a5e08e4c93fd09ceea5a4f48e1e9560f2eef37185c2')throw Error('Qualified search source changed');
fs.writeFileSync(path.join(source,'MatchWorker.InformationSearch.cs'),searchSource);
const buildArguments=['build',path.join(source,'Indigo.Live.Engine.csproj'),'-c','Release','-o',path.join(output,'bin'),
  '-m:1','-p:UseSharedCompilation=false',`-p:LiveRuntimeRoot=${path.dirname(reference.worker)}`];
const built=spawnSync(reference.executable,buildArguments,{windowsHide:true,encoding:'utf8',timeout:120000,
  env:{...process.env,DOTNET_CLI_HOME:path.join(output,'.dotnet-home'),DOTNET_NOLOGO:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1',
    DOTNET_ADD_GLOBAL_TOOLS_TO_PATH:'false',DOTNET_GENERATE_ASPNET_CERTIFICATE:'false',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1'}});
fs.writeFileSync(path.join(output,'build.log'),`${built.stdout??''}\n${built.stderr??''}`);
if(built.status!==0)throw Error(`Native search build failed; inspect ${path.join(output,'build.log')}`);
const worker=path.join(output,'bin/Indigo.Live.Engine.dll'),configuration={...reference,worker,workerSha256:hash(worker),
  workerSourceRoot:source,workerSourceSha256:Object.fromEntries(fs.readdirSync(source).filter(name=>/\.(cs|csproj)$/.test(name)).map(name=>[name,hash(path.join(source,name))])),
  implementationVersion:'information-search/0.4.0-offer-snapshot-candidate',referenceWorkerSha256:reference.workerSha256};
verifyLocalInputs(configuration);
fs.writeFileSync(path.join(output,'native-config.json'),JSON.stringify(configuration,null,2)+'\n');
fs.writeFileSync(path.join(output,'build-receipt.json'),JSON.stringify({schema:'native-search-build/1',at:new Date().toISOString(),
  referenceConfigSha256:hash(referencePath),workerSha256:configuration.workerSha256,sourceHashes:configuration.workerSourceSha256,
  buildArguments,referenceModified:false,games:0,fits:0},null,2)+'\n');
console.log(JSON.stringify({configuration:path.join(output,'native-config.json'),workerSha256:configuration.workerSha256,games:0,fits:0}));
