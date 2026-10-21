// Produce a publication-safe result from a completed fixed routing experiment.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
const [directory, output]=process.argv.slice(2);
assert(directory&&output&&process.argv.length===4,'usage: analyze-singleton-routing <private-evaluation-directory> <public-result.json>');
const root=path.resolve(directory),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8').replace(/^\uFEFF/,''));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const r=read('receipt.json'),pins=read('pins.json');
assert.equal(r.state,'completed');assert.equal(r.stopReason,null);assert.equal(r.invalidBlocks,0);
assert.equal(r.validBlocks,16);assert.equal(r.blocks.length,16);assert.equal(r.completedScoredGames,32);
const interventions=fs.readFileSync(path.join(root,'interventions.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const totals={ordinary:0,baselineSingleton:0,candidateSingleton:0,ranking:0,helper:0,disagreements:0};
const checks=[],games=r.blocks.flatMap(b=>b.outcomes);
for(const b of r.blocks){
  const first=read(`block-${b.index}-human-journal.json`),second=read(`block-${b.index}-opponent-journal.json`);
  assert(equal(first.header,second.header));assert(equal(first.frames[0],second.frames[0]));
  let divergence=-1;
  for(let i=0;i<Math.max(first.commands.length,second.commands.length);i++)if(!equal(first.commands[i],second.commands[i])){divergence=i;break;}
  const changedHere=interventions.filter(x=>x.seed===b.seed&&x.changed);
  const divergenceAttributed=divergence<0||changedHere.some(x=>x.revision===divergence);
  assert(divergenceAttributed,`first divergence not at routing intervention, block ${b.index}`);
  checks.push({index:b.index,seed:b.seed,score:b.score,initialStateAndDecksEqual:true,
    firstCommandDifference:divergence,firstDifferenceAtTreatment:divergenceAttributed,
    candidateWins:b.outcomes.filter(g=>g.score===1).length});
}
for(const g of games){assert.equal(g.status,'natural');assert.equal(g.summary.completedNaturally,true);assert.equal(g.summary.rejected,0);
  for(const k of Object.keys(totals))totals[k]+=g.counts[k];}
assert.equal(totals.candidateSingleton,interventions.length);
assert.equal(totals.disagreements,interventions.filter(x=>x.changed).length);
const p=r.protocol;
const result={schema:'singleton-routing-public-result/1',status:'completed',sourceBase:'15a16da47966eed6b4a0d55dde5f9adbdfe55efc',
  baselineOrdinarySha256:p.baselineOrdinarySha256,baselineSelectionSha256:p.baselineSelectionSha256,
  workerSha256:p.nativeWorkerSha256,runnerSha256:pins.runnerSha256,manifestSha256:r.manifestSha256,
  protocolSha256:hash(path.join(root,'protocol.json')),privateReceiptSha256:hash(path.join(root,'receipt.json')),
  interventionTraceSha256:hash(path.join(root,'interventions.jsonl')),
  games:games.length,independentSeedBlocks:r.validBlocks,wins:r.wins,losses:r.losses,draws:r.draws,
  score:r.score,interval95:r.interval95,intervalMethod:r.intervalMethod,
  allNatural:true,invalidBlocks:0,policyForfeits:0,commandCapDraws:0,rejectedCommands:0,
  routeCounts:totals,candidateGamesWithChangedChoices:new Set(interventions.filter(x=>x.changed).map(x=>x.label)).size,
  candidateSingletonsWithMultipleOfferedChoices:interventions.filter(x=>x.choices>1).length,
  privacyChecks:games.reduce((s,g)=>s+g.summary.privacyChecks,0),
  opponentHandExchanges:games.reduce((s,g)=>s+g.summary.opponentHandExchanges,0),
  actualCost:{wallSeconds:r.elapsedSeconds,summedGameSeconds:games.reduce((s,g)=>s+g.seconds,0),
    lanes:2,device:'CPU',cpuCoreSeconds:null,cpuAccountingNote:'aggregate process CPU was not measured',trainingUpdates:0},
  uncertainty:'Development screen in one fixed mirrored deck, two correlated games per independent seed. No promotion; modest effects remain unresolved.',
  conclusion:r.score>.5?'Exploratory lead only; independently confirm before promotion or expanding this routing change.':
    'No observed improvement from substituting the frozen selector on mandatory singleton prompts; do not adopt this shortcut.',
  blocks:checks,promotion:false};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
