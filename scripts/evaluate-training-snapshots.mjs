// A small development arena for immutable training checkpoints. Never promotes.
// May run concurrently with training when the manifest names completed snapshots.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [manifestPath,output]=process.argv.slice(2);
assert(manifestPath&&output&&process.argv.length===4,'usage: evaluate-training-snapshots <private-manifest> <fresh-private-output>');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const m=read(manifestPath),config=read(m.environmentConfig),root=path.resolve(output);
assert.equal(m.schema,'training-strength-development-panel/1');
assert.equal(m.status,'predeclared');assert.equal(m.promotion,false);
assert(m.seeds.length>=2&&new Set(m.seeds).size===m.seeds.length);
assert(m.snapshots.length&&new Set(m.snapshots.map(s=>s.id)).size===m.snapshots.length);
assert(Number.isSafeInteger(m.workers)&&m.workers>0&&Number.isFinite(m.maximumWallSeconds));
assert(!fs.existsSync(root),'fresh output required');
const load=f=>import(pathToFileURL(path.join(config.runtimeRoot,f)));
const [{verifyFrozenRuntime},{runNativeGame},{AgentBundle},{EntityPpoModelClient},{Model6ModelClient},features,choices]=await Promise.all([
  load('environment/frozen-runtime.mjs'),load('environment/native-game.mjs'),load('integrations/local-worker/agent-bundle.mjs'),
  load('integrations/local-worker/entity-ppo-model.mjs'),load('integrations/local-worker/model6-model.mjs'),
  load('learning/model6-features.mjs'),load('integrations/local-worker/card-action-policy.mjs')]);
const lock=verifyFrozenRuntime(config),native=read(config.nativeConfig),manifestSha256=hash(manifestPath),configSha256=hash(m.environmentConfig);
for(const s of m.snapshots)assert.equal(hash(s.checkpoint),s.sha256,s.id);
fs.mkdirSync(root,{recursive:true});
const save=(n,x)=>fs.writeFileSync(path.join(root,n),JSON.stringify(x,null,2)+'\n');
const append=(n,x)=>fs.appendFileSync(path.join(root,n),JSON.stringify(x)+'\n');
const started=Date.now(),points=[],abort=new AbortController();let stopReason=null;
const stop=reason=>{stopReason??=reason;abort.abort();};
const timer=setTimeout(()=>stop('global-wall-budget'),m.maximumWallSeconds*1000);
const interrupted=()=>stop('operator-interrupted');process.on('SIGINT',interrupted);process.on('SIGTERM',interrupted);
function frozen(snapshot){
  assert.equal(hash(manifestPath),manifestSha256);assert.equal(hash(m.environmentConfig),configSha256);
  verifyFrozenRuntime(config);assert.equal(hash(snapshot.checkpoint),snapshot.sha256);
}
function report(final=false){
  const r={schema:'training-strength-curve/1',state:final?(stopReason?'incomplete':'completed'):'running',
    at:new Date().toISOString(),stopReason,manifestSha256,environmentVersion:lock.version,environmentLockSha256:config.lockSha256,
    opponent:'first-baseline',selection:'unchanged frozen selector',history:'complete-game',
    dataRole:'development; repeated seeds across snapshots; unsuitable as fresh final confirmation',
    elapsedSeconds:(Date.now()-started)/1000,points,promotion:false};
  save('strength-curve.json',r);return r;
}
save('protocol.json',m);save('pins.json',{manifestSha256,configSha256,runnerSha256:hash(new URL(import.meta.url))});
try{
  for(const snapshot of m.snapshots){
    if(stopReason)break;frozen(snapshot);
    const point={id:snapshot.id,trainingGames:snapshot.trainingGames,optimizerSteps:snapshot.optimizerSteps,
      checkpointSha256:snapshot.sha256,state:'running',blocks:[],started:new Date().toISOString()};points.push(point);report();
    let next=0;
    async function lane(index){
      let ordinary,selection,candidate;
      const newAgent=(client,pins)=>new AgentBundle({ordinary:client,selection,catalog:ordinary.catalog,encode:features.encodeModel6Decision,
        supportsCardSelection:choices.supportsCardSelection,rankedPromptAnswers:choices.rankedPromptAnswers,
        pins,historyMode:'complete-game',deterministic:true});
      try{
        ordinary=new EntityPpoModelClient(config.ordinary);selection=new Model6ModelClient(config.selection);
        candidate=new EntityPpoModelClient({...config.ordinary,checkpoint:snapshot.checkpoint,modelRoot:path.dirname(snapshot.checkpoint)});
        save(`${snapshot.id}-lane-${index}-verified.json`,await Promise.all([ordinary.verify(),selection.verify(),candidate.verify()]));
        while(!stopReason){
          const slot=next++;if(slot>=m.seeds.length)break;
          const seed=m.seeds[slot],outcomes=[];frozen(snapshot);
          for(const candidateSeat of ['human','opponent']){
            if(stopReason)break;
            const label=`${snapshot.id}-block-${slot}-${candidateSeat}`,begin=Date.now();
            const agents=Object.fromEntries(['human','opponent'].map(seat=>[seat,newAgent(seat===candidateSeat?candidate:ordinary,
              {id:seat===candidateSeat?snapshot.id:'first-baseline',ordinarySha256:seat===candidateSeat?snapshot.sha256:config.agent.ordinarySha256,
                selectionSha256:config.agent.selectionSha256})]));
            let policySeat=null,counts={};
            // Attribute proposal failures to their policy; shared environment failures remain invalid.
            for(const [seat,agent]of Object.entries(agents)){
              const propose=agent.propose.bind(agent);agent.propose=async(...args)=>{try{return await propose(...args);}catch(e){policySeat=seat;throw e;}};
            }
            try{
              const result=await runNativeGame(native,{agents,seed,seatOrder:[0,1],session:null,
                maxCommands:m.maximumGameCommands,maxSeconds:m.maximumGameSeconds,auditEvery:32,signal:abort.signal,
                onDecision:({seat,source})=>{const key=`${seat===candidateSeat?'candidate':'baseline'}:${source}`;counts[key]=(counts[key]??0)+1;},
                onFrame:({entry})=>append(`${label}-progress.jsonl`,entry)});
              assert(result.summary.completedNaturally&&result.summary.rejected===0&&result.summary.privacyChecks>=2);
              save(`${label}-journal.json`,result.journal);
              outcomes.push({candidateSeat,status:'natural',score:result.summary.winnerSeat===null?.5:result.summary.winnerSeat===candidateSeat?1:0,
                seconds:(Date.now()-begin)/1000,routes:counts,summary:result.summary});
            }catch(error){
              if(stopReason)break;
              const cap=error.code==='NATIVE_EPISODE_COMMAND_BUDGET';
              outcomes.push({candidateSeat,status:policySeat?'policy-forfeit':cap?'command-cap-draw':'shared-invalid',
                score:policySeat?(policySeat===candidateSeat?0:1):cap?.5:null,reason:error.message,seconds:(Date.now()-begin)/1000,routes:counts});
            }
            save(`${label}-outcome.json`,outcomes.at(-1));
            if(outcomes.at(-1).status==='shared-invalid'){stop('shared-harness-failure');break;}
          }
          const complete=outcomes.length===2&&!outcomes.some(o=>o.status==='shared-invalid');
          point.blocks.push({slot,seed,status:complete?'completed':'invalid',score:complete?outcomes.reduce((s,o)=>s+o.score,0)/2:null,outcomes});
          const valid=point.blocks.filter(b=>b.status==='completed'),games=valid.flatMap(b=>b.outcomes);
          point.games=games.length;point.wins=games.filter(g=>g.score===1).length;point.losses=games.filter(g=>g.score===0).length;
          point.draws=games.filter(g=>g.score===.5).length;point.score=valid.reduce((s,b)=>s+b.score,0)/valid.length;
          const radius=Math.sqrt(Math.log(40)/(2*valid.length));point.interval95=[Math.max(0,point.score-radius),Math.min(1,point.score+radius)];
          report();console.log(JSON.stringify({snapshot:snapshot.id,completedBlocks:valid.length,plannedBlocks:m.seeds.length}));
        }
      }catch(error){append('events.jsonl',{snapshot:snapshot.id,lane:index,reason:error.message});stop('model-or-pin-failure');}
      finally{await Promise.all([ordinary,selection,candidate].filter(Boolean).map(client=>client.shutdown().catch(()=>{})));}
    }
    await Promise.all(Array.from({length:m.workers},(_,i)=>lane(i)));frozen(snapshot);
    point.state=stopReason?'incomplete':'completed';point.finished=new Date().toISOString();report();
  }
}catch(error){append('events.jsonl',{reason:error.message});stop('preflight-or-pin-failure');}
finally{clearTimeout(timer);process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);}
const result=report(true);console.log(JSON.stringify({state:result.state,points:result.points.length,elapsedSeconds:result.elapsedSeconds,stopReason}));
if(stopReason)process.exitCode=2;
