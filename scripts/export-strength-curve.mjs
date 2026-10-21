import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const [evaluationDirectory,outputPath]=process.argv.slice(2);
assert(evaluationDirectory&&outputPath&&process.argv.length===4,
  'usage: export-strength-curve <completed-private-evaluation> <public-result.json>');
const readJson=name=>JSON.parse(fs.readFileSync(path.join(evaluationDirectory,name),'utf8').replace(/^\uFEFF/,''));
const hashFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const curve=readJson('strength-curve.json'),summary=readJson('strength-summary.json');
const protocol=readJson('protocol.json'),pins=readJson('pins.json');
assert.equal(curve.state,'completed');assert.equal(curve.stopReason,null);
assert.equal(summary.at,curve.at);assert.equal(curve.points.length,protocol.snapshots.length);
assert.equal(curve.manifestSha256,pins.manifestSha256);

const points=curve.points.map(point=>{
  assert.equal(point.state,'completed');assert.equal(point.blocks.length,protocol.seeds.length);
  const snapshot=protocol.snapshots.find(snapshot=>snapshot.id===point.id);
  assert.equal(point.checkpointSha256,snapshot.sha256);
  const slots=new Set(),blocks=point.blocks.map(block=>{
    assert.equal(block.status,'completed');assert.equal(block.seed,protocol.seeds[block.slot]);
    assert(!slots.has(block.slot));slots.add(block.slot);
    assert.equal(block.outcomes.length,2);
    assert.deepEqual(new Set(block.outcomes.map(game=>game.candidateSeat)),new Set(['human','opponent']));
    for(const game of block.outcomes){
      assert(['natural','policy-forfeit','command-cap-draw'].includes(game.status));
      assert([0,.5,1].includes(game.score));
      if(game.status==='natural'){assert.equal(game.summary.completedNaturally,true);assert.equal(game.summary.rejected,0);}
    }
    assert.equal(block.score,block.outcomes.reduce((total,game)=>total+game.score,0)/2);
    if(block.outcomes.every(game=>game.status==='natural')){
      const first=readJson(`${point.id}-block-${block.slot}-human-journal.json`);
      const second=readJson(`${point.id}-block-${block.slot}-opponent-journal.json`);
      assert.deepEqual(first.header,second.header);assert.deepEqual(first.frames[0],second.frames[0]);
    }
    return {slot:block.slot,seed:block.seed,score:block.score,statuses:block.outcomes.map(game=>game.status)};
  });
  const games=point.blocks.flatMap(block=>block.outcomes),score=blocks.reduce((total,block)=>total+block.score,0)/blocks.length;
  assert.equal(point.score,score);
  const compact=summary.points.find(candidate=>candidate.id===point.id);
  return {id:point.id,trainingGames:point.trainingGames,optimizerSteps:point.optimizerSteps,
    checkpointSha256:point.checkpointSha256,games:games.length,independentSeedBlocks:blocks.length,
    wins:games.filter(game=>game.score===1).length,losses:games.filter(game=>game.score===0).length,
    draws:games.filter(game=>game.score===.5).length,score,interval95:point.interval95,
    naturalGames:compact.naturalGames,policyForfeits:compact.policyForfeits,commandCapDraws:compact.commandCapDraws,
    sharedInvalid:compact.sharedInvalid,routes:compact.routes,summedGameSeconds:compact.summedGameSeconds,
    privacyChecks:games.reduce((total,game)=>total+(game.summary?.privacyChecks??0),0),blocks};
});

let unscoredCompletedGameSeconds=0;
if(curve.recovery){
  const priorCurve=JSON.parse(fs.readFileSync(path.join(curve.recovery.directory,'strength-curve.json'),'utf8'));
  const retainedLabels=new Set(priorCurve.points.flatMap(point=>point.blocks.flatMap(block=>
    block.outcomes.map(game=>`${point.id}-block-${block.slot}-${game.candidateSeat}-outcome.json`))));
  for(const name of fs.readdirSync(curve.recovery.directory)){
    if(!name.endsWith('-outcome.json')||retainedLabels.has(name))continue;
    const game=JSON.parse(fs.readFileSync(path.join(curve.recovery.directory,name),'utf8'));
    unscoredCompletedGameSeconds+=game.seconds;
  }
}

const result={schema:'training-strength-curve-public-result/1',status:'completed',
  sourceFoundationCommit:protocol.foundationSourceCommit,environmentVersion:curve.environmentVersion,
  environmentLockSha256:curve.environmentLockSha256,opponent:'first-baseline',selection:'same frozen selector for every player',
  history:'complete-game',runnerSha256:pins.runnerSha256,privateManifestSha256:curve.manifestSha256,
  privateCurveSha256:hashFile(path.join(evaluationDirectory,'strength-curve.json')),
  seedPanel:protocol.seeds,dataRole:curve.dataRole,
  intervalMethod:'per-snapshot two-sided 95% Hoeffding over independent paired seed blocks; exploratory, no multiplicity-adjusted claim',
  points,actualCost:{currentAttemptWallSeconds:curve.elapsedSeconds,campaignWallSeconds:curve.campaignWallSeconds,
    summedScoredGameSeconds:points.reduce((total,point)=>total+point.summedGameSeconds,0),
    unscoredCompletedGameSeconds,interruptedGameCpuCostMeasured:false,
    workers:protocol.workers,device:'CPU',cpuCoreSeconds:null,trainingUpdates:0},
  recovery:curve.recovery?{retainedSeedPairs:curve.recovery.completedSeedPairsRetained,
    unscoredOriginalNaturalGames:curve.recovery.unpairedNaturalGames,interruptedGameAttempts:curve.recovery.interruptedGameAttempts,
    originalDeadline:curve.recovery.absoluteDeadline,deadlineExtended:false,
    priorCurveSha256:curve.recovery.curveSha256}:null,
  conclusion:'Development measurements across four fixed checkpoints, not checkpoint selection or a promotion test. Final confirmation remains separate.',
  promotion:false};
fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({points:points.length,games:points.reduce((total,point)=>total+point.games,0),output:outputPath}));
