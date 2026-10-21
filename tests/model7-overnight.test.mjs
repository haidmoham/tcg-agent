import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const controller=fileURLToPath(new URL('../scripts/run-model7-overnight.mjs',import.meta.url));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'model7-controller-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const checkpoint=path.join(root,'baseline-fixture'), protocolPath=path.join(root,'protocol.json'), manifestPath=path.join(root,'manifest.json');
  fs.writeFileSync(checkpoint,'untrained synthetic fixture; never opened by a model');
  const deadline=Date.now()-1000;
  const protocol={schema:'model7-overnight-design/1',training:{startUtc:new Date(deadline-21600000).toISOString(),
    deadlineUtc:new Date(deadline).toISOString(),batches:[]},initialization:{selectionSha256:'b'.repeat(64)}};
  fs.writeFileSync(protocolPath,JSON.stringify(protocol));
  const manifest={schema:'model7-overnight-execution/1',approval:'approved',protocol:protocolPath,protocolSha256:hash(protocolPath),
    outputDirectory:path.join(root,'output'),initialCheckpoint:checkpoint,initialCheckpointSha256:hash(checkpoint),filePins:{[checkpoint]:hash(checkpoint)}};
  fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  const run=(args=[])=>spawnSync(process.execPath,[controller,manifestPath,...args],{encoding:'utf8',windowsHide:true});
  return {root,manifest,manifestPath,checkpoint,run};
}
test('an expired training window cannot launch games or announce the baseline as a trained candidate',t=>{
  const f=fixture(t), result=f.run(); assert.equal(result.status,0,result.stderr);
  const candidate=JSON.parse(fs.readFileSync(path.join(f.manifest.outputDirectory,'final-candidate.json')));
  assert.equal(candidate.available,false);assert.equal(candidate.completedBatchUpdates,0);assert.equal(candidate.completedTrainingGames,0);
  assert.equal(candidate.completedAtUtc,null);assert.equal(fs.existsSync(path.join(f.manifest.outputDirectory,'checkpoint-announcements.jsonl')),false);
  assert.notEqual(f.run().status,0);assert.notEqual(f.run(['--resume']).status,0);
});
test('changed pinned input fails before collection, while preserving an explicit failed receipt',t=>{
  const f=fixture(t);fs.writeFileSync(f.checkpoint,'changed');const result=f.run();assert.equal(result.status,2);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.manifest.outputDirectory,'receipt.json')));
  assert.equal(receipt.state,'failed');assert.match(receipt.failures[0].reason,/Pinned input changed/);
  assert.equal(receipt.completedBatchUpdates,0);
});
test('same-trajectory resume admits a completed orphan only with exact parent and reload proof',t=>{
  const f=fixture(t), output=f.manifest.outputDirectory, candidate=path.join(f.root,'update.pt');
  fs.mkdirSync(output);fs.writeFileSync(candidate,'synthetic update; no optimizer was executed');
  const update={checkpointSha256:hash(candidate),parentCheckpointSha256:hash(f.checkpoint),reloadLogitsExact:true,
    reloadValuesExact:true,updateCount:24,ppoConfig:{},metrics:{optimizerSteps:3}};
  const receiptPath=candidate.replace(/\.pt$/,'.receipt.json');fs.writeFileSync(receiptPath,JSON.stringify(update));
  const protocol=JSON.parse(fs.readFileSync(f.manifest.protocol));protocol.ppoConfig={};
  fs.writeFileSync(f.manifest.protocol,JSON.stringify(protocol));f.manifest.protocolSha256=hash(f.manifest.protocol);
  fs.writeFileSync(f.manifestPath,JSON.stringify(f.manifest));
  const before=new Date(Date.parse(protocol.training.deadlineUtc)-100);fs.utimesSync(receiptPath,before,before);
  fs.writeFileSync(path.join(output,'status.json'),JSON.stringify({schema:'model7-overnight-status/1',state:'failed',phase:'fitting',
    manifestSha256:hash(f.manifestPath),protocolSha256:f.manifest.protocolSha256,checkpoint:f.checkpoint,checkpointSha256:hash(f.checkpoint),
    completedTrainingGames:0,completedBatchUpdates:0,optimizerSteps:0,batches:[],skippedBatches:[],failures:[],nextBatch:1,
    pendingUpdate:{batchIndex:1,checkpoint:candidate,parent:hash(f.checkpoint)}}));
  const result=f.run(['--resume']);assert.equal(result.status,0,result.stderr);
  const final=JSON.parse(fs.readFileSync(path.join(output,'final-candidate.json')));
  assert.equal(final.available,true);assert.equal(final.completedTrainingGames,64);assert.equal(final.completedBatchUpdates,1);
  assert.equal(final.checkpointSha256,hash(candidate));assert.equal(final.optimizerSteps,3);
  const rows=fs.readFileSync(path.join(output,'checkpoint-announcements.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,1);assert.equal(rows[0].reloadVerified,true);assert.equal(rows[0].parentCheckpointSha256,hash(f.checkpoint));
});
