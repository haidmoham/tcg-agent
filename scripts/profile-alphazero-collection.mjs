import fs from 'node:fs';
import path from 'node:path';

const [manifestPath,destination]=process.argv.slice(2);
if(process.argv.length!==4)throw Error('Usage: profile-alphazero-collection <private-manifest> <outside-run-profile.json>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const manifest=read(manifestPath),root=manifest.outputDirectory,seen=new Map(),started=new Date().toISOString();
const eventsPath=destination.replace(/\.json$/,'.events.jsonl');
const counts={},latencies=[];
while(true) {
  const statusPath=path.join(root,'status.json');let state=null;
  if(fs.existsSync(statusPath))try{state=read(statusPath);}catch{}
  const games=[];
  if(fs.existsSync(root))for(const batch of fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name===`batch-${state?.batchIndex}`)) {
    const directory=path.join(root,batch.name);
    for(const game of fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory())) {
      const gameDirectory=path.join(directory,game.name),file=path.join(gameDirectory,'accepted-decisions.jsonl');
      if(!fs.existsSync(file))continue;
      const rows=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
      const previous=seen.get(file),now=Date.now();
      for(let index=previous?.count??0;index<rows.length;index++) {
        const row=rows[index],interval=previous?.lastAt&&index===(previous?.count??0)?(now-previous.lastAt)/1000:null;
        counts[row.source]=(counts[row.source]??0)+1;
        if(row.source==='alphazero-search'&&interval!==null)latencies.push(interval);
        fs.appendFileSync(eventsPath,JSON.stringify({observedAtUtc:new Date(now).toISOString(),game:game.name,index,
          seat:row.seat,source:row.source,initiallyCensored:previous===undefined,
          priorAcceptedDecisionGapSeconds:interval,pollResolutionSeconds:.25})+'\n');
      }
      seen.set(file,{count:rows.length,lastAt:previous===undefined?null:rows.length>(previous?.count??0)?now:previous?.lastAt});
      const receiptPath=path.join(gameDirectory,'receipt.json');
      games.push({game:game.name,acceptedCommands:rows.length,acceptedSearchDecisions:rows.filter(row=>row.source==='alphazero-search').length,
        elapsedSeconds:(now-fs.statSync(gameDirectory).birthtimeMs)/1000,receipt:fs.existsSync(receiptPath)?read(receiptPath):null});
    }
  }
  const sorted=[...latencies].sort((a,b)=>a-b);
  const profile={schema:'alphazero-live-observation-profile/1',startedAtUtc:started,at:new Date().toISOString(),
    trainingState:state?.state,phase:state?.phase,counts,games,
    rootDecisionInterarrival:{samples:sorted.length,meanSeconds:sorted.length?sorted.reduce((sum,value)=>sum+value,0)/sorted.length:null,
      medianSeconds:sorted.length?sorted[Math.floor(sorted.length/2)]:null,maximumSeconds:sorted.at(-1)??null},
    interpretation:'Observed accepted-decision interarrival wall time includes driver, audit and search, with 250ms polling. Initial existing rows are censored. Exact cumulative native search time is in completed-game searchDiagnostics. No strength inference.'};
  fs.writeFileSync(destination,JSON.stringify(profile,null,2)+'\n');
  if(['completed','failed','paused'].includes(state?.state)||state?.completedBatchUpdates>0||Date.now()-Date.parse(started)>1200000)break;
  await new Promise(resolve=>setTimeout(resolve,250));
}
