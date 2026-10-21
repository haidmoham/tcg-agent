// Paired diagnostic: selector versus ordinary actor on mandatory singleton prompts.
// Both checkpoints are frozen. Private paths enter only through the run manifest.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const [manifestPath, output] = process.argv.slice(2);
assert(manifestPath && output && process.argv.length === 4,
  'usage: compare-singleton-routing <private-predeclared-manifest> <fresh-private-output>');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const m = read(manifestPath), p = m.protocol, root = path.resolve(output);
assert.equal(m.schema, 'singleton-routing-experiment/1');
assert.equal(p.status, 'predeclared');
assert.equal(p.change, 'mandatory-singleton-ordinary-to-frozen-selector');
assert.equal(p.baselineOrdinarySha256, 'c175603c04df29723998efcd02dc7dc18ae9c1c2ad9953fae520adf0e7c515d9');
assert.equal(p.baselineSelectionSha256, '2b245d6c1d3f91f9cb5d3b6c36663dca717f586581175e7d22588e24f20e6a3d');
assert(p.blocks.length === 16 && new Set(p.blocks.map(b => b.seed)).size === 16);
assert(p.limits.workers === 2 && p.limits.maximumWallSeconds <= 2700);
assert(!fs.existsSync(root), 'output must be fresh');
const manifestSha256 = hash(manifestPath);
const load = f => import(pathToFileURL(path.join(m.runtimeRoot, f)));
const [{runTrainingEpisode}, {verifyLocalInputs}, {EntityPpoModelClient}, {Model6ModelClient}, features, choices] = await Promise.all([
  load('integrations/local-worker/model6-training-episode.mjs'), load('integrations/local-worker/probe.mjs'),
  load('integrations/local-worker/entity-ppo-model.mjs'), load('integrations/local-worker/model6-model.mjs'),
  load('learning/model6-features.mjs'), load('integrations/local-worker/card-action-policy.mjs')]);
const native = read(m.nativeConfig), catalog = read(m.ordinary.catalogPath);
function frozen() {
  assert.equal(hash(manifestPath), manifestSha256);
  assert.equal(hash(m.ordinary.checkpoint), p.baselineOrdinarySha256);
  assert.equal(hash(m.selection.checkpoint), p.baselineSelectionSha256);
  assert.equal(hash(m.ordinary.catalogPath), p.catalogSha256);
  assert.equal(hash(m.nativeConfig), p.nativeConfigSha256);
  for (const [f, digest] of Object.entries(p.runtimeSourceHashes)) assert.equal(hash(path.join(m.runtimeRoot, f)), digest, f);
  const verified = verifyLocalInputs(native);
  assert.equal(verified.selected.length, 2);
  for (const deck of verified.selected) assert.equal(createHash('sha256').update(JSON.stringify(deck)).digest('hex'), p.deckSha256);
}
frozen();
fs.mkdirSync(root, {recursive:true});
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
const append = (name, value) => fs.appendFileSync(path.join(root, name), JSON.stringify(value) + '\n');
const started = Date.now(), blocks = [], abort = new AbortController();
let next = 0, stopReason = null;
const stop = reason => {stopReason ??= reason; abort.abort();};
const timer = setTimeout(() => stop('global-wall-budget'), p.limits.maximumWallSeconds * 1000);
const interrupt = () => stop('operator-interrupted');
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
save('protocol.json', p);
save('pins.json', {manifestSha256, runnerSha256:hash(new URL(import.meta.url)), protocol:p});
function status(final = false) {
  const valid = blocks.filter(b => b.status === 'completed');
  const games = valid.flatMap(b => b.outcomes);
  const score = valid.length ? valid.reduce((sum, b) => sum + b.score, 0) / valid.length : null;
  const radius = valid.length ? Math.sqrt(Math.log(40) / (2 * valid.length)) : null;
  const r = {schema:'singleton-routing-result/1', at:new Date().toISOString(),
    state:final ? (valid.length === 16 ? 'completed' : 'incomplete') : 'running',
    validBlocks:valid.length, plannedBlocks:16, completedScoredGames:games.length,
    invalidBlocks:blocks.filter(b => b.status !== 'completed').length, stopReason,
    wins:games.filter(g => g.score === 1).length, losses:games.filter(g => g.score === 0).length,
    draws:games.filter(g => g.score === .5).length, score,
    interval95:score === null ? null : [Math.max(0, score-radius), Math.min(1, score+radius)],
    intervalMethod:'two-sided 95% Hoeffding over independent paired seed-block scores; fixed final analysis only',
    elapsedSeconds:(Date.now()-started)/1000, manifestSha256, promotion:false};
  save('status.json', r);
  if (final) save('receipt.json', {...r, blocks, protocol:p});
  return r;
}
// Same history adapter as the completed Model7 confirmation; separate seat state.
function context() {
  let turn=null, originAction=null, originCard=null, usage={}, entityUsage={};
  return {
    view(view) {
      if (turn !== view.turnNumber) {turn=view.turnNumber; originAction=null; originCard=null; entityUsage={};
        usage=Object.fromEntries(['energyPlayed','supporterPlayed','retreated'].map(k => [k,{known:true,value:false}]));}
      for (const c of [view.you.active,...view.you.bench].filter(Boolean)) entityUsage[c.instanceId] ??= {abilityUsed:{known:true,value:false}};
      return {...view,decisionContext:{originAction,originCard,usage:structuredClone(usage),entityUsage:structuredClone(entityUsage)}};
    },
    accept(view, decision) {
      if (!decision.actionId) return;
      const a=view.actions.find(x => x.id===decision.actionId); assert(a);
      originAction=structuredClone(a);
      originCard=[...view.hand,view.you.active,...view.you.bench,...view.you.discard].find(c => c?.instanceId===(a.sourceCardId??a.actorId))??null;
      if(a.kind==='retreat') usage.retreated.value=true;
      if(a.kind==='ability'&&a.actorId) entityUsage[a.actorId]={abilityUsed:{known:true,value:true}};
      if(a.kind==='play'&&originCard?.category==='energy') usage.energyPlayed.value=true;
      const token=catalog.printingAliases[originCard?.printingId]??originCard?.printingId;
      if(a.kind==='play'&&catalog.cards[catalog.cardIds[token]??0]?.format==='supporter') usage.supporterPlayed.value=true;
    }
  };
}
async function lane(index) {
  const ordinary=new EntityPpoModelClient({...m.ordinary,device:'cpu'});
  const selection=new Model6ModelClient({...m.selection,device:'cpu'});
  try {
    save(`lane-${index}-verified.json`, await Promise.all([ordinary.verify(),selection.verify()]));
    while(!stopReason) {
      const slot=next++; if(slot>=16) break;
      const block=p.blocks[slot], outcomes=[];
      frozen();
      for (const candidateSeat of ['human','opponent']) {
        if(stopReason) break;
        const label=`block-${slot}-${candidateSeat}`, begin=Date.now(), contexts={human:context(),opponent:context()};
        const counts={ordinary:0,baselineSingleton:0,candidateSingleton:0,ranking:0,helper:0,disagreements:0};
        const policyCall=async(seat, fn)=>{try{return await fn();}catch(e){throw Object.assign(e,{policySeat:seat});}};
        try {
          await ordinary.setSeed(block.seed);
          const result=await runTrainingEpisode(native, {seed:block.seed,seatOrder:[0,1],session:null,
            maxCommands:p.limits.maximumGameCommands,maxSeconds:p.limits.maximumGameSeconds,auditEvery:32,signal:abort.signal,
            onFrame:({entry})=>append(`${label}-progress.jsonl`,entry),
            decideOrdinary:({seat,view:raw})=>{counts.ordinary++;return policyCall(seat,()=>ordinary.decide({view:contexts[seat].view(raw)}));},
            decidePrompt:async({seat,view:raw,validate})=>{
              const view=contexts[seat].view(raw),prompt=view.prompts[0];
              if(view.status!=='playing'||!choices.supportsCardSelection(view))return null;
              const singleton=prompt.min===1&&prompt.max===1&&!prompt.ordered
                &&prompt.choices.every(c=>c.minAmount==null&&c.maxAmount==null&&c.initialAmount==null);
              if(!singleton){counts.ranking++;return policyCall(seat,async()=>choices.rankedPromptAnswers(view,await selection.rankChoices({view})));}
              const encoded=features.encodeModel6Decision(view,{catalog});encoded.selectionCardinality=1;encoded.legalMask=[];
              for(const choice of prompt.choices)encoded.legalMask.push(await validate({promptId:prompt.id,choiceIds:[choice.id]})===true);
              assert(encoded.legalMask.some(Boolean),'shared-no-native-valid-singleton');
              const [sample]=await policyCall(seat,()=>ordinary.act([encoded],{deterministic:true}));
              assert(encoded.legalMask[sample.actionIndex]);
              let chosen=sample.actionIndex;
              if(seat===candidateSeat){
                const ranking=await policyCall(seat,()=>selection.rankChoices({view}));
                assert.equal(new Set(ranking).size,prompt.choices.length);
                assert(ranking.every(i=>Number.isSafeInteger(i)&&i>=0&&i<prompt.choices.length));
                chosen=ranking.find(i=>encoded.legalMask[i]);assert.notEqual(chosen,undefined);
                counts.candidateSingleton++;counts.disagreements+=chosen!==sample.actionIndex?1:0;
                append('interventions.jsonl',{label,seed:block.seed,revision:view.revision,seat,
                  choices:prompt.choices.length,ordinary:sample.actionIndex,selector:chosen,changed:chosen!==sample.actionIndex});
              }else counts.baselineSingleton++;
              return [{promptId:prompt.id,choiceIds:[prompt.choices[chosen].id]}];
            },
            onAcceptedDecision:({seat,view,decision,ordinaryPolicyUsed,promptPolicyUsed})=>{
              if(!ordinaryPolicyUsed&&!promptPolicyUsed)counts.helper++;
              contexts[seat].accept(contexts[seat].view(view),decision);
              append(`${label}-decisions.jsonl`,{seat,revision:view.revision,decision});
            }});
          frozen();assert(result.summary.completedNaturally&&result.summary.rejected===0&&result.summary.privacyChecks>=2,'shared-terminal-admission-failed');
          save(`${label}-journal.json`, result.journal);
          outcomes.push({candidateSeat,status:'natural',score:result.summary.winnerSeat===null?.5:result.summary.winnerSeat===candidateSeat?1:0,
            counts,summary:result.summary,seconds:(Date.now()-begin)/1000});
        } catch(error) {
          if(stopReason)break;
          const policy=error.policySeat!==undefined, cap=error.code==='NATIVE_EPISODE_COMMAND_BUDGET';
          outcomes.push({candidateSeat,status:policy?'policy-forfeit':cap?'command-cap-draw':'shared-invalid',
            score:policy?(error.policySeat===candidateSeat?0:1):cap?.5:null,reason:error.message,counts,seconds:(Date.now()-begin)/1000});
        }
        save(`${label}-outcome.json`,outcomes.at(-1));
        if(outcomes.at(-1).status==='shared-invalid'){stop('shared-harness-failure');break;}
      }
      const complete=outcomes.length===2&&!outcomes.some(o=>o.status==='shared-invalid');
      blocks.push({index:slot,seed:block.seed,status:complete?'completed':'invalid',
        score:complete?outcomes.reduce((s,o)=>s+o.score,0)/2:null,outcomes});
      save(`block-${slot}.json`,blocks.at(-1));
      const current=status();console.log(JSON.stringify({block:slot,validBlocks:current.validBlocks,elapsedSeconds:current.elapsedSeconds}));
    }
  }catch(error){append('events.jsonl',{type:'fatal',lane:index,reason:error.message});stop('model-or-pin-preflight-failed');}
  finally{await Promise.all([ordinary.shutdown(),selection.shutdown()].map(p=>p.catch(()=>{})));}
}
status();
try{await Promise.all([lane(0),lane(1)]);}finally{clearTimeout(timer);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
try{frozen();}catch(error){stopReason??='final-pin-check-failed';append('events.jsonl',{type:'final-pin-error',reason:error.message});}
const final=status(true);console.log(JSON.stringify(final));if(final.state!=='completed')process.exitCode=2;
