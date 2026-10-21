import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const [manifestPath,checkpoint,checkpointSha256,journalPath,rootsPath,output]=process.argv.slice(2);
if(process.argv.length!==8||fs.existsSync(output))throw Error('Usage: qualify-model7-search-adoption <prepared-manifest> <checkpoint> <sha256> <retained-journal> <retained-roots> <fresh-proof>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest=read(manifestPath),load=file=>import(pathToFileURL(path.join(manifest.runtimeRoot,file)));
const [{LocalWorker,verifyLocalInputs},{PolicyView},{encodeModel6Decision},{openSearchDistillationPlayer}]=await Promise.all([
  load('integrations/local-worker/probe.mjs'),load('integrations/local-worker/model6-policy-view.mjs'),
  load('learning/model6-features.mjs'),load('agents/alphazero-agent.mjs')]);
assert.equal(hash(checkpoint),checkpointSha256);
const actual=read(manifest.collectionPlan.nativeConfig),inputs=verifyLocalInputs(actual),journal=read(journalPath),expected=read(rootsPath);
const player=await openSearchDistillationPlayer({environmentConfig:manifest.collectionPlan.environmentConfig,runtimeRoot:manifest.runtimeRoot,
  checkpoint,checkpointSha256,...manifest.playerConfig,selectionClient:{rankChoices(){throw Error('ordinary-root proof unexpectedly requested selector');}}});
const agents=Object.fromEntries(['human','opponent'].map((seat,index)=>[seat,player.newGame({searchSeed:134001+index})]));
const projectors=Object.fromEntries(['human','opponent'].map(seat=>[seat,new PolicyView()]));
const worker=new LocalWorker(actual,{timeoutMs:30000});
const proof={at:new Date().toISOString(),engineeringOnly:true,fits:0,checkpointSha256,manifestSha256:hash(manifestPath),
  retainedJournalSha256:hash(journalPath),retainedRootsSha256:hash(rootsPath),roots:0,knownBottomConstraintRoots:0,searchProofs:[],
  beliefScope:'actor-history-constrained-declared-deck/1'};
try {
  await player.verify();const catalog=read(manifest.catalog);
  const bundle={id:inputs.manifest.bundleId,cardsHash:inputs.pins.get('cardData.json'),rulesHash:inputs.pins.get('gameData.json'),runtimeHash:inputs.pins.get('MatchLogic.dll')};
  const seats=Object.fromEntries(['human','opponent'].map((seat,index)=>[seat,{accountId:`offline-proof-${seat}`,name:`Offline ${seat}`,cards:inputs.selected[index]}]));
  let frame=await worker.request('create',{bundle,seats,offline:{seed:journal.header.seed,projectionCopyMode:journal.header.projectionCopyMode??inputs.copyMode}});
  for(const entry of journal.commands) {
    const views=Object.fromEntries(['human','opponent'].map(seat=>[seat,agents[seat].observe(projectors[seat].project(frame.views[seat]))]));
    for(const seat of ['human','opponent']) {
      const view=views[seat];if(view.status!=='playing'||view.turn!=='you'||view.prompts.length||!view.actions.length)continue;
      const reference=expected[proof.roots];assert.equal(view.revision,reference.revision);assert.equal(seat,reference.seat);
      assert.deepEqual(view.deckKnowledge,reference.rootView.deckKnowledge);
      assert.deepEqual(encodeModel6Decision(view,{catalog}),encodeModel6Decision(reference.rootView,{catalog}));
      if(view.deckKnowledge.ownDeck.bottomBlocks.length)proof.knownBottomConstraintRoots++;
      if([0,90,108].includes(proof.roots)) {
        const before=await worker.request('audit',{}),proposal=await agents[seat].propose(view);
        assert.equal(proposal.source,'alphazero-search');assert.equal(proposal.sample.searchVisits.reduce((a,b)=>a+b,0),16);
        assert.deepEqual(await worker.request('audit',{}),before);
        assert.equal(proposal.sample.searchPolicy.reduce((a,b)=>a+b,0),1);
        assert(view.actions.some(action=>action.id===proposal.decisions[0].actionId));
        proof.searchProofs.push({revision:view.revision,visits:proposal.sample.searchVisits,authorityAndRngUnchanged:true});
        if(proof.searchProofs.length===1) {
          const incomplete={...view,deckKnowledge:{...view.deckKnowledge,complete:false}},fallback=await agents[seat].propose(incomplete);
          assert.match(fallback.source,/^alphazero-policy-fallback:/);assert.equal(fallback.sample,undefined);proof.incompleteLedgerFallbackWithoutTargets=true;
        }
      }
      proof.roots++;
    }
    const command=projectors[entry.seat].resolve(entry.decision);
    const reply=await worker.request('command',{seat:entry.seat,command:{...command,commandId:randomUUID(),expectedRevision:frame.revision}});
    assert.equal(reply.receipt.status,'accepted');agents[entry.seat].accepted(views[entry.seat],entry.decision);frame=reply.frame;
  }
  assert.equal(proof.roots,109);assert.equal(proof.knownBottomConstraintRoots,44);assert.equal(proof.searchProofs.length,3);
  for(const [file,digest]of Object.entries(manifest.filePins))assert.equal(hash(file),digest,`sealed input changed: ${file}`);
  proof.complete=true;
} catch(error) {proof.error=error.stack;process.exitCode=2;}
finally {worker.close();await player.shutdown();fs.writeFileSync(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({complete:proof.complete,roots:proof.roots,knownBottomConstraintRoots:proof.knownBottomConstraintRoots,searches:proof.searchProofs.length,error:proof.error}));
