import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const controller=fileURLToPath(new URL('../scripts/run-model7-alphazero.mjs',import.meta.url));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
function fixture(batches,completedBatchUpdates=0) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'model7-boundary-')),output=path.join(root,'run'),runtime=path.join(root,'runtime');
  fs.mkdirSync(output);fs.mkdirSync(runtime);
  const checkpoint=path.join(root,'resealed.pt');fs.writeFileSync(checkpoint,'unchanged learned state plus new metadata');
  const start=Date.now()-60000,protocol=path.join(root,'protocol.json');
  save(protocol,{version:5,training:{allocatedSeconds:21600,startUtc:new Date(start).toISOString(),deadlineUtc:new Date(start+21600000).toISOString(),batches}});
  const manifest=path.join(root,'manifest.json');save(manifest,{schema:'model7-alphazero-execution/1',protocol,protocolSha256:hash(protocol),
    runtimeRoot:runtime,outputDirectory:output,initialCheckpoint:checkpoint,initialCheckpointSha256:hash(checkpoint),
    factoryModule:path.join(runtime,'new-factory.mjs'),filePins:{[checkpoint]:hash(checkpoint)},sourcePins:{},playerConfig:{}});
  const state={schema:'model7-alphazero-status/1',state:'paused',phase:'between-batches',manifestSha256:hash(manifest),
    protocolSha256:hash(protocol),checkpoint,checkpointSha256:hash(checkpoint),completedTrainingGames:completedBatchUpdates*16,
    completedBatchUpdates,optimizerSteps:completedBatchUpdates*20,collectionSeconds:1,fittingSeconds:1,nextBatch:0,
    trainingStartedAtUtc:new Date(start).toISOString(),deadlineUtc:new Date(start+21600000).toISOString(),
    failures:[],skippedBatches:[],batches:[],replayBatches:[]};
  return {root,output,manifest,state};
}
const run=fixture=>spawnSync(process.execPath,[controller,fixture.manifest,'--resume'],{encoding:'utf8',timeout:5000,windowsHide:true});

test('operator boundary pause exits before consuming the next seed or starting a collector',()=>{
  const f=fixture([{index:5,tasks:[]}]);
  try {
    save(path.join(f.output,'status.json'),f.state);save(path.join(f.output,'pause-before-next-batch.json'),{purpose:'source adoption'});
    const result=run(f);assert.equal(result.status,0,result.stderr);
    const state=JSON.parse(fs.readFileSync(path.join(f.output,'status.json'),'utf8'));
    assert.equal(state.state,'paused');assert.equal(state.phase,'operator-boundary-pause');assert.equal(state.nextBatch,0);
    assert(!fs.readFileSync(path.join(f.output,'events.jsonl'),'utf8').includes('child-start'));
    assert(!fs.existsSync(path.join(f.output,'final-candidate.json')));
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('final fallback preserves the last learning announcement and its player after metadata-only reseal',()=>{
  const f=fixture([],1),learned=path.join(f.root,'last-announced.pt');fs.writeFileSync(learned,'last learned checkpoint');
  const announcement={checkpoint:learned,checkpointSha256:hash(learned),completedAtUtc:new Date(Date.now()-1000).toISOString(),
    factoryModule:'old-immutable-factory',runtimeRoot:'old-immutable-runtime',sourcePins:{'old-source':'old-digest'},
    playerConfig:{belief:'old'},completedTrainingGames:16,completedBatchUpdates:1,optimizerSteps:20,reloadVerified:true};
  try {
    save(path.join(f.output,'status.json'),{...f.state,lastAnnouncement:announcement});
    const result=run(f);assert.equal(result.status,0,result.stderr);
    const final=JSON.parse(fs.readFileSync(path.join(f.output,'final-candidate.json'),'utf8'));
    assert.equal(final.checkpoint,learned);assert.equal(final.checkpointSha256,announcement.checkpointSha256);
    assert.equal(final.factoryModule,announcement.factoryModule);assert.deepEqual(final.sourcePins,announcement.sourcePins);
    assert.deepEqual(final.playerConfig,announcement.playerConfig);assert.equal(final.completedBatchUpdates,1);
    assert(!fs.existsSync(path.join(f.output,'checkpoint-announcements.jsonl')));
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
