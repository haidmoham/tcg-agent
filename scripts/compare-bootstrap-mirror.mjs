// One frozen candidate bundle versus frozen update23. No training or UI access.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
const [preparation,fitDirectory,output]=process.argv.slice(2);
if(!output||process.argv.length!==5)throw Error('usage: compare-bootstrap-mirror <private-preparation> <fixed-fit-directory> <fresh-private-output>');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=b=>createHash('sha256').update(b).digest('hex');
const hash=p=>sha(fs.readFileSync(p));
const check=(v,m)=>{if(!v)throw Error(m);};
const prep=path.resolve(preparation),fit=path.resolve(fitDirectory),root=path.resolve(output);
const p=read(path.join(prep,'protocol.json')),inputs=read(path.join(prep,'private-execution-inputs.json'));
const receipt=read(path.join(fit,'receipt.json')),protocolSha=hash(path.join(prep,'protocol.json'));
const outcomePilot=receipt.schema==='model7-outcome-pilot-final-bundle/1';
check(!fs.existsSync(root)&&['bootstrap-mirror-evaluation/1','model7-outcome-pilot-confirmation/1'].includes(p.schema)&&p.status==='predeclared'
  &&inputs.protocolSha256===protocolSha&&receipt.evaluationProtocol.sha256===protocolSha
  &&equal(receipt.evaluationProtocol.protocol,p)&&(outcomePilot?receipt.confirmationMeasured===false:receipt.generalizationMeasured===false),
  'fixed-predeclared-comparison-required');
const runtime=inputs.runtimeRoot,load=f=>import(pathToFileURL(path.join(runtime,f)));
const [{runTrainingEpisode},{verifyLocalInputs},{EntityPpoModelClient},{Model6ModelClient},features,choices]=await Promise.all([
  load('integrations/local-worker/model6-training-episode.mjs'),load('integrations/local-worker/probe.mjs'),
  load('integrations/local-worker/entity-ppo-model.mjs'),load('integrations/local-worker/model6-model.mjs'),
  load('learning/model6-features.mjs'),load('integrations/local-worker/card-action-policy.mjs')]);
const native=read(inputs.nativeConfig),catalog=read(inputs.ordinary.catalogPath);
const candidateOrdinary=path.join(fit,'ordinary-candidate.pt'),candidateSelection=path.join(fit,'selection-candidate.pt');
const pins={baselineOrdinary:p.baseline.ordinarySha256,baselineSelection:p.baseline.selectionSha256,
  candidateOrdinary:receipt.candidateSha256.ordinary,candidateSelection:receipt.candidateSha256.selection,
  protocol:protocolSha,fitReceipt:hash(path.join(fit,'receipt.json')),runner:hash(new URL(import.meta.url))};
const frozen=()=>{
  check(hash(inputs.ordinary.checkpoint)===pins.baselineOrdinary&&hash(inputs.selection.checkpoint)===pins.baselineSelection
    &&hash(candidateOrdinary)===pins.candidateOrdinary&&hash(candidateSelection)===pins.candidateSelection
    &&hash(path.join(prep,'protocol.json'))===pins.protocol&&hash(path.join(fit,'receipt.json'))===pins.fitReceipt
    &&hash(inputs.ordinary.catalogPath)===p.catalogSha256&&hash(inputs.nativeConfig)===p.nativeConfigSha256,'comparison-pin-changed');
  for(const [f,digest]of Object.entries(p.runtimeSourceHashes))check(hash(path.join(runtime,f))===digest,'runtime-source-changed');
  const verified=verifyLocalInputs(native);
  check(verified.selected.every(d=>sha(JSON.stringify(d))===p.deckSha256),'same-exact-Hammerpult-required');
};
frozen();fs.mkdirSync(root,{recursive:true});
const save=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n');
const append=(name,value)=>fs.appendFileSync(path.join(root,name),JSON.stringify(value)+'\n');
save('frozen-pins.json',{at:new Date().toISOString(),pins,protocol:p});
const blockResults=[],clients=[],started=Date.now(),deadline=started+p.limits.maximumWallSeconds*1000;
let nextPrimary=0,nextReplacement=0,invalid=0,stopReason=null,checkpointReported=false;
const abort=new AbortController();
const cancel=reason=>{stopReason??=reason;abort.abort();};
const timer=setTimeout(()=>cancel('global-wall-budget'),p.limits.maximumWallSeconds*1000);
const interrupted=()=>cancel('operator-interrupted');process.on('SIGINT',interrupted);process.on('SIGTERM',interrupted);
function status(final=false){
  const valid=blockResults.filter(b=>b.status==='completed');
  const result={schema:'bootstrap-mirror-status/1',at:new Date().toISOString(),state:final?(valid.length===32?'completed':'incomplete'):'running',
    validBlocks:valid.length,plannedBlocks:32,completedScoredGames:valid.length*2,invalidBlocks:invalid,
    elapsedSeconds:(Date.now()-started)/1000,maximumWallSeconds:p.limits.maximumWallSeconds,pins,stopReason,
    strengthClaim:false,earlyCheckpoint:'operation/timing only; no tuning or early strength claim'};
  if(final&&valid.length===32){
    const mean=valid.reduce((n,b)=>n+b.score,0)/32,radius=Math.sqrt(Math.log(40)/(2*32));
    result.analysis={score:mean,independentSeedBlocks:32,games:64,interval95:[Math.max(0,mean-radius),Math.min(1,mean+radius)],
      method:p.analysis.interval,substantialImprovement:mean>=.6&&mean-radius>.5,
      interpretation:mean>=.6&&mean-radius>.5?'evidence for substantial gain in this fixed-deck comparison':'inconclusive or not improved; no automatic promotion'};
  }
  save('status.json',result);
  if(final)save('receipt.json',{...result,blocks:blockResults,protocol:p});
  return result;
}
function context(){
  let turn=null,originAction=null,originCard=null,usage={},entityUsage={};
  return {
    view(view){if(turn!==view.turnNumber){turn=view.turnNumber;originAction=null;originCard=null;entityUsage={};
      usage=Object.fromEntries(['energyPlayed','supporterPlayed','retreated'].map(k=>[k,{known:true,value:false}]));}
      for(const c of [view.you.active,...view.you.bench].filter(Boolean))entityUsage[c.instanceId]??={abilityUsed:{known:true,value:false}};
      return {...view,decisionContext:{originAction,originCard,usage:structuredClone(usage),entityUsage:structuredClone(entityUsage)}};},
    accept(view,decision){if(!decision.actionId)return;const a=view.actions.find(x=>x.id===decision.actionId);
      check(a,'accepted-action-not-offered');originAction=structuredClone(a);
      originCard=[...view.hand,view.you.active,...view.you.bench,...view.you.discard].find(c=>c?.instanceId===(a.sourceCardId??a.actorId))??null;
      if(a.kind==='retreat')usage.retreated.value=true;
      if(a.kind==='ability'&&a.actorId)entityUsage[a.actorId]={abilityUsed:{known:true,value:true}};
      if(a.kind==='play'&&originCard?.category==='energy')usage.energyPlayed.value=true;
      const token=catalog.printingAliases[originCard?.printingId]??originCard?.printingId;
      if(a.kind==='play'&&catalog.cards[catalog.cardIds[token]??0]?.format==='supporter')usage.supporterPlayed.value=true;
    }};
}
async function policyCall(bundle,seat,fn){try{return await fn();}catch(error){throw Object.assign(error,{policyBundle:bundle,policySeat:seat});}}
async function lane(index){
  const base=new EntityPpoModelClient({...inputs.ordinary,device:'cpu'});
  const candidate=new EntityPpoModelClient({...inputs.ordinary,checkpoint:candidateOrdinary,modelRoot:fit,device:'cpu'});
  const baseSelection=new Model6ModelClient({...inputs.selection,device:'cpu'});
  const candidateRanker=new Model6ModelClient({...inputs.selection,checkpoint:candidateSelection,modelRoot:fit,device:'cpu'});
  const owned=[base,candidate,baseSelection,candidateRanker];clients.push(...owned);
  try{
    const info=await Promise.all(owned.map(c=>c.verify()));save(`lane-${index}-verified.json`,info);
    while(!stopReason&&Date.now()<deadline){
      const slot=nextPrimary++;if(slot>=32)break;
      let block=p.blocks[slot],replacementFor=null;
      for(;;){
        if(stopReason)break;
        frozen();const outcomes=[];
        for(const role of p.seatCases){
          if(stopReason)break;
          const label=`block-${block.index}-${role.candidateSeat}`,begin=Date.now(),contexts={human:context(),opponent:context()};
          const counts={candidateOrdinary:0,baselineOrdinary:0,candidateSingleton:0,baselineSingleton:0,candidateRanking:0,baselineRanking:0,helper:0};
          let lastFrame=null;
          const bundleFor=seat=>seat===role.candidateSeat?'candidate':'baseline';
          const clientFor=seat=>seat===role.candidateSeat?candidate:base;
          try{
            await Promise.all([base.setSeed(block.seed),candidate.setSeed(block.seed)]);
            const result=await runTrainingEpisode(native,{seed:block.seed,seatOrder:[0,1],session:null,
              maxCommands:p.limits.maximumGameCommands,
              maxSeconds:Math.max(1,Math.min(p.limits.maximumGameSeconds,Math.floor((deadline-Date.now())/1000))),
              auditEvery:32,signal:abort.signal,
              onFrame:({entry,frame})=>{lastFrame={revision:entry.revision,turn:frame.views.human.turnNumber};
                append(`${label}-progress.jsonl`,{at:new Date().toISOString(),...entry,turn:lastFrame.turn});},
              decideOrdinary:({seat,view:raw})=>{const view=contexts[seat].view(raw),bundle=bundleFor(seat);
                counts[`${bundle}Ordinary`]++;return policyCall(bundle,seat,()=>clientFor(seat).decide({view}));},
              decidePrompt:async({seat,view:raw,validate})=>{
                const view=contexts[seat].view(raw),prompt=view.prompts[0],bundle=bundleFor(seat);
                if(view.status!=='playing'||!choices.supportsCardSelection(view))return null;
                const singleton=prompt.min===1&&prompt.max===1&&!prompt.ordered
                  &&prompt.choices.every(c=>c.minAmount==null&&c.maxAmount==null&&c.initialAmount==null);
                if(singleton){const encoded=features.encodeModel6Decision(view,{catalog});encoded.selectionCardinality=1;encoded.legalMask=[];
                  for(const choice of prompt.choices)encoded.legalMask.push(await validate({promptId:prompt.id,choiceIds:[choice.id]}));
                  check(encoded.legalMask.some(Boolean),'shared-no-native-valid-singleton');
                  const [sample]=await policyCall(bundle,seat,()=>clientFor(seat).act([encoded],{deterministic:true}));
                  counts[`${bundle}Singleton`]++;return [{promptId:prompt.id,choiceIds:[prompt.choices[sample.actionIndex].id]}];
                }
                const ranker=bundle==='candidate'?candidateRanker:baseSelection;
                const ranking=await policyCall(bundle,seat,()=>ranker.rankChoices({view}));counts[`${bundle}Ranking`]++;
                return choices.rankedPromptAnswers(view,ranking);
              },
              onAcceptedDecision:({seat,view,decision,ordinaryPolicyUsed,promptPolicyUsed})=>{
                if(!ordinaryPolicyUsed&&!promptPolicyUsed)counts.helper++;
                contexts[seat].accept(contexts[seat].view(view),decision);
                append(`${label}-decisions.jsonl`,{bundle:bundleFor(seat),seat,revision:view.revision,decision,
                  source:ordinaryPolicyUsed?'ordinary':promptPolicyUsed?'learned-prompt':'common-helper'});
              }});
            frozen();check(result.summary.completedNaturally&&result.summary.rejected===0&&result.summary.privacyChecks>=2,'shared-terminal-admission-failed');
            const winner=result.summary.winnerSeat;
            const score=winner===null?.5:winner===role.candidateSeat?1:0;
            outcomes.push({role,status:'natural',score,seconds:(Date.now()-begin)/1000,counts,summary:result.summary});
          }catch(error){
            if(stopReason)break;
            if(error.policyBundle)outcomes.push({role,status:'policy-forfeit',score:error.policyBundle==='candidate'?0:1,
              failingBundle:error.policyBundle,reason:error.message,seconds:(Date.now()-begin)/1000,counts,lastFrame});
            else if(error.code==='NATIVE_EPISODE_COMMAND_BUDGET')outcomes.push({role,status:'command-cap-draw',score:.5,
              reason:error.message,seconds:(Date.now()-begin)/1000,counts,lastFrame});
            else{outcomes.push({role,status:'shared-invalid',reason:error.message,code:error.code??null,seconds:(Date.now()-begin)/1000,counts,lastFrame});break;}
          }
          save(`${label}-outcome.json`,outcomes.at(-1));
          append('events.jsonl',{at:new Date().toISOString(),type:'game-ended',block:block.index,...outcomes.at(-1)});
        }
        if(stopReason)break;
        if(outcomes.length===2&&!outcomes.some(o=>o.status==='shared-invalid')){
          const done={status:'completed',slot,seed:block.seed,index:block.index,replacementFor,
            score:outcomes.reduce((n,o)=>n+o.score,0)/2,outcomes};blockResults.push(done);save(`block-${block.index}.json`,done);
          const current=status();console.log(JSON.stringify({type:'block-completed',block:block.index,validBlocks:current.validBlocks,elapsedSeconds:current.elapsedSeconds}));
          if(!checkpointReported&&current.validBlocks>=8){checkpointReported=true;save('operational-checkpoint.json',current);console.log(JSON.stringify({type:'operational-checkpoint',...current}));}
          break;
        }
        invalid++;const failed={status:'invalid',slot,index:block.index,seed:block.seed,outcomes};blockResults.push(failed);save(`block-${block.index}.json`,failed);status();
        if(invalid>=p.limits.maximumInvalidBlocks||nextReplacement>=p.replacementBlocks.length){cancel('shared-harness-replacement-budget');break;}
        replacementFor=block.index;block=p.replacementBlocks[nextReplacement++];
      }
    }
  }catch(error){append('events.jsonl',{at:new Date().toISOString(),type:'fatal-preflight',lane:index,reason:error.message});cancel('model-or-pin-preflight-failed');}
  finally{await Promise.all(owned.map(c=>c.shutdown().catch(()=>{})));}
}
status();
try{await Promise.all(Array.from({length:p.limits.workers},(_,i)=>lane(i)));}
finally{clearTimeout(timer);process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
  for(const client of clients)client.close();}
try{frozen();}catch(error){stopReason??='final-pin-check-failed';append('events.jsonl',{type:'final-pin-error',reason:error.message});}
const final=status(true);console.log(JSON.stringify(final));
if(final.state!=='completed')process.exitCode=2;
