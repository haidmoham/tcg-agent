import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const [planPath,output]=process.argv.slice(2);
if(process.argv.length!==4)throw Error('Usage: alphazero-selfplay <private-batch-plan> <fresh-output>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const plan=read(planPath),environment=read(plan.environmentConfig),native=read(plan.nativeConfig??environment.nativeConfig);
if(plan.schema!=='alphazero-selfplay-plan/1'||plan.tasks.length!==16||plan.workers<1||plan.workers>4||fs.existsSync(output))
  throw Error('Predeclared sixteen-game plan and fresh output required');
fs.mkdirSync(output,{recursive:true});
const save=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n');
const pins={...plan.filePins,[path.resolve(planPath)]:hash(planPath)};
const assertPins=()=>{for(const [file,digest] of Object.entries(pins))if(hash(file)!==digest)throw Error(`AlphaZero source/input changed: ${file}`);};
const load=(root,file)=>import(pathToFileURL(path.join(root,file)));
const [{openFirstBaseline},{runNativeGame},{createAgentPultTeacher},{openSearchDistillationPlayer},{runTrainingEpisode}]=await Promise.all([
  load(environment.runtimeRoot,'agents/first-baseline.mjs'),load(environment.runtimeRoot,'environment/native-game.mjs'),
  load(environment.runtimeRoot,'learning/agentpult-teacher.mjs'),load(plan.runtimeRoot,'agents/alphazero-agent.mjs'),
  load(plan.runtimeRoot,'integrations/local-worker/alphazero-training-episode.mjs')]);
const episodes=[],started=Date.now(),abort=new AbortController();let next=0,stopped=null;
const stop=reason=>{stopped??=reason;abort.abort();};
const timer=setTimeout(()=>stop('batch-wall-budget'),plan.maximumWallSeconds*1000);
const interrupted=()=>stop('operator-interrupted');process.on('SIGINT',interrupted);process.on('SIGTERM',interrupted);
function status() {save('status.json',{at:new Date().toISOString(),pid:process.pid,completedGames:episodes.length,
  naturalGames:episodes.filter(row=>row.completedNaturally).length,searchRecords:episodes.reduce((sum,row)=>sum+row.recordsCount,0),stopped});}
const heartbeat=setInterval(status,15000);status();save('plan.json',plan);
async function lane(index) {
  let baseline,player;
  const session={};
  try {
    baseline=await openFirstBaseline(environment);
    const selectionClient=baseline.newGame().selection;
    player=await openSearchDistillationPlayer({environmentConfig:plan.environmentConfig,runtimeRoot:plan.runtimeRoot,
      checkpoint:plan.modelConfig.checkpoint,checkpointSha256:plan.modelConfig.checkpointSha256,
      selectionClient,catalog:read(plan.modelConfig.catalogPath),...plan.playerConfig});
    await player.verify();
    const teacher=createAgentPultTeacher(read(plan.teacherCatalogPath));
    while(!stopped && next<plan.tasks.length) {
      const task=plan.tasks[next++];assertPins();
      const directory=path.join(output,task.id);fs.mkdirSync(directory);
      const records=[],routes={},gamePlayers=[];let episode;
      const agents=Object.fromEntries(['human','opponent'].map(seat=>{
        if(task.learnerSeats.includes(seat)) {
          const agent=player.newGame({searchSeed:(task.searchSeed^(seat==='human'?0x726f6f74:0x6f70706f))>>>0});
          gamePlayers.push(agent);return [seat,agent];
        }
        const agent=baseline.newGame();
        if(task.opponentPolicy==='teacher')agent.propose=async view=>({source:'scripted-teacher',
          decisions:view.status==='playing'?(view.prompts.length?teacher(view):[teacher(view).next().value]):null});
        return [seat,agent];
      }));
      const begin=Date.now();
      try {
        const game=await runNativeGame(native,{runEpisode:runTrainingEpisode,seed:task.seed,seatOrder:task.seatOrder??[0,1],agents,session,
          maxSeconds:plan.maximumGameSeconds,maxCommands:plan.maximumGameCommands,auditEvery:32,signal:abort.signal,
          onFrame:({entry})=>fs.appendFileSync(path.join(directory,'progress.jsonl'),JSON.stringify(entry)+'\n'),
          onDecision:({seat,decision,source,sample,encoded})=>{
            routes[`${seat}:${source}`]=(routes[`${seat}:${source}`]??0)+1;
            fs.appendFileSync(path.join(directory,'accepted-decisions.jsonl'),JSON.stringify({seat,decision,source})+'\n');
            if(!task.learnerSeats.includes(seat)||source!=='alphazero-search')return;
            const visits=sample?.searchVisits,policy=sample?.searchPolicy;
            if(!encoded||!Array.isArray(visits)||!Array.isArray(policy)||visits.length!==policy.length
              ||visits.some(value=>!Number.isSafeInteger(value)||value<0)||policy.some(value=>!Number.isFinite(value)||value<0)
              ||Math.abs(policy.reduce((sum,value)=>sum+value,0)-1)>1e-6)throw Error('Accepted search target identity/probability mismatch');
            if(visits.length<2||encoded.legalMask?.filter(Boolean).length<2)return;
            records.push({...encoded,schema:'native-alphazero-record/1',trainingMethod:'alphazero-search-outcome/1',
              searchVisits:visits,searchPolicy:policy,searchTemperature:1,actorSeat:seat,episodeId:task.id,
              stepIndex:records.length,executedCommand:decision,searchSeed:task.searchSeed,completedNaturally:false});
          }});
        if(!game.summary.completedNaturally||game.summary.rejected!==0||game.summary.privacyChecks<2)throw Error('Natural outcome admission failed');
        for(const row of records){row.outcome=game.summary.winnerSeat===null?0:game.summary.winnerSeat===row.actorSeat?1:-1;row.completedNaturally=true;}
        fs.writeFileSync(path.join(directory,'records.jsonl'),records.map(row=>JSON.stringify(row)).join('\n')+(records.length?'\n':''),{flag:'wx'});
        fs.writeFileSync(path.join(directory,'journal.json'),JSON.stringify(game.journal));
        episode={...task,completedNaturally:true,recordsCount:records.length,routes,summary:game.summary,
          recordsPath:path.join(task.id,'records.jsonl'),recordsSha256:hash(path.join(directory,'records.jsonl'))};
      } catch(error) {
        fs.writeFileSync(path.join(directory,'partial-records.jsonl'),records.map(row=>JSON.stringify(row)).join('\n'));
        episode={...task,completedNaturally:false,recordsCount:0,partialRecords:records.length,routes,errorCode:error.code??null,reason:error.message,stack:error.stack};
        if(/source|privacy|checkpoint|catalog|identity|probability/i.test(error.message))stop('integrity-failure');
        else stop('whole-batch-game-failure');
      } finally {
        for(const agent of gamePlayers)await (agent.shutdown?.()??agent.close?.());
      }
      episode.seconds=(Date.now()-begin)/1000;episode.searchDiagnostics=gamePlayers.map(agent=>agent.searchCounts??null);episodes.push(episode);
      fs.writeFileSync(path.join(directory,'receipt.json'),JSON.stringify(episode,null,2)+'\n');status();assertPins();
      if(session.failed)break;
    }
  } catch(error) {episodes.push({id:`lane-${index}`,completedNaturally:false,recordsCount:0,reason:error.message});stop('lane-failure');}
  finally {
    session.worker?.close();await player?.shutdown();await baseline?.shutdown();
  }
}
try {assertPins();await Promise.all(Array.from({length:plan.workers},(_,index)=>lane(index)));assertPins();}
finally {clearTimeout(timer);clearInterval(heartbeat);process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);}
const natural=episodes.filter(row=>row.completedNaturally),records=[];
for(const episode of natural)records.push(fs.readFileSync(path.join(output,episode.recordsPath),'utf8'));
fs.writeFileSync(path.join(output,'records.jsonl'),records.join(''));
const receipt={schema:'alphazero-selfplay-receipt/1',parentCheckpointSha256:plan.modelConfig.checkpointSha256,
  completed:episodes.length===16&&natural.length===16&&!stopped,episodes,plannedGames:16,naturalGames:natural.length,
  recordsCount:natural.reduce((sum,row)=>sum+row.recordsCount,0),recordsSha256:hash(path.join(output,'records.jsonl')),
  elapsedSeconds:(Date.now()-started)/1000,stopReason:stopped,planSha256:hash(planPath),trainingMethod:'alphazero-search-outcome/1'};
save('receipt.json',receipt);console.log(JSON.stringify({completed:receipt.completed,naturalGames:receipt.naturalGames,recordsCount:receipt.recordsCount}));
if(!receipt.completed)process.exitCode=2;
