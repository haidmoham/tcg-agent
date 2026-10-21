// Preparation only: no process spawning, game, inference, or fitting.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {verifyLocalInputs} from '../integrations/local-worker/probe.mjs';
const [configPath,durationsPath,output]=process.argv.slice(2);
if(!output||process.argv.length!==5)throw Error('usage: prepare-bootstrap-evaluation <human-config> <retained-duration-evidence> <fresh-private-output>');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const hash=b=>createHash('sha256').update(b).digest('hex');
const fileHash=p=>hash(fs.readFileSync(p));
const config=read(configPath),inputs=verifyLocalInputs(config.native),evidence=read(durationsPath);
if(fs.existsSync(output))throw Error('fresh private evaluation preparation required');
const root=path.resolve(output);fs.mkdirSync(path.join(root,'bundle'),{recursive:true});
const save=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for(const row of inputs.manifest.files)fs.copyFileSync(path.join(inputs.root,row.path),path.join(root,'bundle',row.path));
const decks=read(path.join(root,'bundle/decks.json'));
const hammer=inputs.selected[0],deckSha256=hash(JSON.stringify(hammer));
if(deckSha256!==config.deckSha256.learner)throw Error('exact Hammerpult recipe mismatch');
decks.zoroarkDeckRows=structuredClone(decks.realDeckRows);
fs.writeFileSync(path.join(root,'bundle/decks.json'),JSON.stringify(decks,null,2)+'\n');
const manifest=structuredClone(inputs.manifest);
manifest.bundleId=`hammerpult-mirror-${deckSha256.slice(0,16)}`;
for(const row of manifest.files)row.sha256=fileHash(path.join(root,'bundle',row.path));
save('bundle/manifest.json',manifest);
const native={...config.native,bundleRoot:path.join(root,'bundle'),manifestSha256:fileHash(path.join(root,'bundle/manifest.json'))};
save('native-config.json',native);
const mirrored=verifyLocalInputs(native);
if(!mirrored.selected.every(d=>hash(JSON.stringify(d))===deckSha256))throw Error('both seats must have exact same sixty');
const usedSeeds=new Set(evidence.map(r=>r.seed));
for(const game of fs.readdirSync(config.recordsRoot)){
  const file=path.join(config.recordsRoot,game,'manifest.json');if(fs.existsSync(file))usedSeeds.add(read(file).pins.seed);
}
// Also exclude seeds in retained local campaign plans, without reading model weights.
function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.isDirectory()&&!['.git','node_modules','.venv'].includes(entry.name))scan(path.join(dir,entry.name));
  else if(entry.isFile()&&/^plan.*\.json$/.test(entry.name)){
    const p=path.join(dir,entry.name);try{const walk=v=>{if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){
      if(k==='seed'&&Number.isSafeInteger(x))usedSeeds.add(x);else walk(x);}};walk(read(p));}catch{/* malformed unrelated plan is not authority */}
  }
}}
if(config.version?.sourceRoot&&fs.existsSync(path.join(config.version.sourceRoot,'runs')))scan(path.join(config.version.sourceRoot,'runs'));
const seeds=[];while(seeds.length<40){const seed=randomBytes(4).readUInt32LE();if(!usedSeeds.has(seed)){seeds.push(seed);usedSeeds.add(seed);}}
const seconds=evidence.map(r=>r.seconds).sort((a,b)=>a-b),n=seconds.length;
const durationBasis={evidenceSha256:fileHash(durationsPath),completedGames:n,
  medianSeconds:n%2?seconds[(n-1)/2]:(seconds[n/2-1]+seconds[n/2])/2,
  meanSeconds:seconds.reduce((a,b)=>a+b,0)/n,p95NearestRankSeconds:seconds[Math.ceil(.95*n)-1],
  maximumSeconds:seconds.at(-1),scope:'retained mixed-deck simulator games; not a measured Hammerpult-mirror estimate'};
const paths=['learning/model6_torch.py','learning/entity_torch.py','learning/entity_ppo.py','learning/entity_ppo_runtime.py',
  'learning/model6-features.mjs','learning/entity-features.mjs','learning/model6-contract.json','learning/entity-contract.json',
  'integrations/local-worker/model6-training-episode.mjs','integrations/local-worker/model6-policy-view.mjs',
  'integrations/local-worker/policy-view.mjs','integrations/local-worker/entity-ppo-model.mjs',
  'integrations/local-worker/model6-model.mjs','integrations/local-worker/card-action-policy.mjs',
  'integrations/local-worker/probe.mjs','integrations/local-worker/semantic-state.mjs'];
const runtimeSourceHashes=Object.fromEntries(paths.map(p=>[p,fileHash(path.join(config.runtimeRoot,p))]));
const protocol={schema:'bootstrap-mirror-evaluation/1',status:'predeclared',at:new Date().toISOString(),
  baseline:{ordinarySha256:config.checkpointSha256,selectionSha256:config.model.frozenSelectionSha256},
  catalogSha256:config.model.catalogSha256,contractSha256:read(path.join(config.recordsRoot,fs.readdirSync(config.recordsRoot).find(g=>fs.existsSync(path.join(config.recordsRoot,g,'manifest.json'))),'manifest.json')).pins.contractSha256,
  candidate:'one fixed final two-head BC bundle; hashes sealed before any game',
  fit:{totalUpdates:100,maximumTrainingSeconds:120,optimizer:'Adam',learningRate:1e-4,batchSize:8,seed:1729,device:'cpu',
    checkpointSelection:'fixed final; no development/gameplay checkpoint fishing'},
  deckSha256,bothSeatsSameSixty:true,nativeConfigSha256:fileHash(path.join(root,'native-config.json')),
  nativeWorkerSha256:native.workerSha256,bundleManifestSha256:native.manifestSha256,helperSha256:native.policySha256,
  runtimeSourceHashes,blocks:seeds.slice(0,32).map((seed,index)=>({index,seed})),
  replacementBlocks:seeds.slice(32).map((seed,index)=>({index:32+index,seed})),gamesPerBlock:2,
  seatCases:[{candidateSeat:'human',baselineSeat:'opponent'},{candidateSeat:'opponent',baselineSeat:'human'}],
  policyRoute:'ordinary and mandatory singleton -> respective PPO actor; optional/multicard -> respective selection ranker; common pinned helper otherwise',
  limits:{workers:2,maximumWallSeconds:5400,maximumGameSeconds:240,maximumGameCommands:600,maximumInvalidBlocks:8},
  timing:{...durationBasis,meanProjectionSeconds:64*durationBasis.meanSeconds/2,
    p95ProjectionSeconds:64*durationBasis.p95NearestRankSeconds/2,
    hardBudgetRationale:'90 minutes allows about double retained mean projection; mirror duration/concurrent load can differ. Stop incomplete at budget.'},
  scoring:{win:1,naturalDraw:.5,loss:0,commandCapDraw:.5,policySpecificFailure:'forfeit by failing bundle',
    sharedHarnessFailure:'invalidate whole seed block; retain receipts; take next predeclared reservoir block',
    ambiguousFailure:'do not award win; invalidate block or stop if systematic',wallBudget:'incomplete, no extension'},
  analysis:{unit:'mean candidate score of both games in one seed block',independentUnits:32,
    interval:'95% two-sided Hoeffding bounded-mean interval over 32 independent seed-block scores',
    formula:'mean +/- sqrt(log(2/0.05)/(2*n)), clipped [0,1]',
    decision:'completed 32 blocks AND score >=0.60 AND lower95 >0.50; otherwise inconclusive or not improved',
    incomplete:'descriptive only; no strength decision',operationalCheckpointBlocks:8,
    checkpointMeaning:'timing/health only; no early strength claim, tuning, or success stop',
    allWinsIntervalLower:1-Math.sqrt(Math.log(40)/(2*32)),
    futureCandidateSelection:'fresh confirmation seeds required after any candidate selection'},
  noRanked:true,noPpoTraining:true,noPromotion:true,sourceBuilderSha256:fileHash(new URL(import.meta.url))};
save('protocol.json',protocol);
save('private-execution-inputs.json',{configPath:path.resolve(configPath),nativeConfig:path.join(root,'native-config.json'),runtimeRoot:config.runtimeRoot,
  ordinary:config.model,selection:config.selection,protocolSha256:fileHash(path.join(root,'protocol.json'))});
console.log(JSON.stringify({output:root,protocolSha256:fileHash(path.join(root,'protocol.json')),baseline:protocol.baseline,
  deckSha256,limits:protocol.limits,timing:protocol.timing,blocks:32,games:64,launched:false},null,2));
