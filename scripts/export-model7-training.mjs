import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const [manifestPath,destination]=process.argv.slice(2);
if(!manifestPath || !destination || process.argv.length!==4)throw Error('Usage: export-model7-training <private-manifest> <sanitized-result.json>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest=read(manifestPath),protocol=read(manifest.protocol),state=read(path.join(manifest.outputDirectory,'status.json'));
if(hash(manifestPath)!==state.manifestSha256 || hash(manifest.protocol)!==state.protocolSha256)throw Error('Execution identity changed');
const groups=new Map(),batches=[];
for(const name of fs.readdirSync(manifest.outputDirectory).filter(name=>/^batch-\d+-audit\.json$/.test(name))) {
  const audit=read(path.join(manifest.outputDirectory,name)), admitted=state.batches.some(row=>row.batchIndex===audit.batchIndex);
  const skipped=state.skippedBatches.find(row=>row.batchIndex===audit.batchIndex), counts={attemptedGames:0,naturalGames:0,
    admittedGames:0,discardedNaturalGames:0,decisions:0,partialDecisions:0,admittedDecisions:0};
  for(const episode of audit.episodes.filter(row=>row.seed!==undefined)) {
    counts.attemptedGames++;counts.naturalGames+=Number(episode.natural);counts.admittedGames+=Number(admitted&&episode.natural);
    counts.discardedNaturalGames+=Number(!admitted&&episode.natural);counts.decisions+=episode.decisions;
    counts.partialDecisions+=episode.partialDecisions;counts.admittedDecisions+=admitted?episode.decisions:0;
    const reason=admitted?'admitted':/^NATIVE_[A-Z_]+$/.test(episode.errorCode??'')?episode.errorCode
      :episode.natural?skipped?.reason??'pending':episode.status==='fatal'?'collection-fatal':episode.status==='excluded'?'collection-excluded':'incomplete';
    const key=JSON.stringify([audit.batchIndex,audit.parentCheckpointSha256,episode.opponentPolicy,episode.policySeat,reason]);
    const group=groups.get(key)??{batchIndex:audit.batchIndex,parentCheckpointSha256:audit.parentCheckpointSha256,
      opponent:episode.opponentPolicy,seat:episode.policySeat,reason,admitted,games:0,naturalGames:0,decisions:0,partialDecisions:0};
    group.games++;group.naturalGames+=Number(episode.natural);group.decisions+=episode.decisions;group.partialDecisions+=episode.partialDecisions;
    groups.set(key,group);
  }
  batches.push({batchIndex:audit.batchIndex,parentCheckpointSha256:audit.parentCheckpointSha256,admitted,
    reason:admitted?'admitted':skipped?.reason??'pending',counts,collection:audit.collection});
}
batches.sort((a,b)=>a.batchIndex-b.batchIndex);
const total=Object.fromEntries(['attemptedGames','naturalGames','admittedGames','discardedNaturalGames','decisions','partialDecisions','admittedDecisions']
  .map(key=>[key,batches.reduce((sum,batch)=>sum+batch.counts[key],0)]));
const sourceHashes=Object.fromEntries(Object.entries(manifest.filePins).filter(([file])=>file.startsWith(manifest.runtimeRoot+path.sep))
  .map(([file,digest])=>[path.relative(manifest.runtimeRoot,file).replaceAll('\\','/'),digest]));
const result={schema:'model7-overnight-training-result/1',experiment:protocol.experiment,state:state.state,
  protocolSha256:state.protocolSha256,executionManifestSha256:state.manifestSha256,sourceHashes,
  startUtc:state.startUtc,deadlineUtc:state.deadlineUtc,trainingStartedAtUtc:state.trainingStartedAtUtc??null,finishedAtUtc:state.finishedAtUtc??null,
  completedTrainingGames:state.completedTrainingGames,completedBatchUpdates:state.completedBatchUpdates,optimizerSteps:state.optimizerSteps,
  collectionSeconds:state.collectionSeconds,fittingSeconds:state.fittingSeconds,counts:total,batches,
  exclusionBreakdown:[...groups.values()],checkpoints:state.batches.map(({checkpoint,...row})=>row),
  initialCheckpointSha256:manifest.initialCheckpointSha256,finalCheckpointSha256:state.checkpointSha256,
  selectionSha256:protocol.initialization.selectionSha256,ppoConfig:protocol.ppoConfig,reward:protocol.reward,
  failures:state.failures.map(({at,phase})=>({at,phase,detail:'See preserved private receipt'})),
  strength:'Training evidence only; no strength inference or promotion. Separate fresh gameplay confirmation is required.',
  limitation:'Whole-batch exclusion can select the training distribution and discard valid trajectories. Admitted data are not claimed unbiased.',promoted:false};
fs.writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({destination,sha256:hash(destination),state:result.state,completedBatchUpdates:result.completedBatchUpdates}));
