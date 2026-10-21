import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
export class AlphaZeroModelClient {
  constructor({executable,runtimeRoot,checkpoint,modelRoot,catalogPath,catalogSha256,device='cpu',seed=81729}) {
    if([executable,runtimeRoot,checkpoint,modelRoot,catalogPath].some(file=>!path.isAbsolute(file??'')))
      throw Error('Explicit AlphaZero runtime, model and catalog paths required');
    if(hash(catalogPath)!==catalogSha256)throw Error('AlphaZero catalog changed');
    this.catalog=JSON.parse(readFileSync(catalogPath,'utf8').replace(/^\uFEFF/,''));
    this.checkpointSha256=hash(checkpoint);this.catalogSha256=catalogSha256;this.seed=seed;
    this.pending=new Map();this.sequence=0;this.buffer='';this.stderr='';this.closed=false;
    this.child=spawn(executable,['-u',path.join(runtimeRoot,'learning/alphazero_runtime.py'),'serve','--checkpoint',checkpoint,
      '--catalog',catalogPath,'--device',device,'--seed',String(seed)],{cwd:runtimeRoot,windowsHide:true,
      stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUNBUFFERED:'1',PTCG_AGENT_MODEL_ROOT:modelRoot}});
    this.exited=new Promise(resolve=>{this.child.once('exit',resolve);this.child.once('error',resolve);});
    this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>this.read(chunk));
    this.child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk).slice(-4096);});
    this.child.once('error',error=>this.close(error));this.child.once('exit',()=>this.close(new Error(`AlphaZero service exited: ${this.stderr}`)));
    this.child.stdin.on('error',error=>this.close(error));
  }
  request(op,payload={}) {
    if(this.closed)return Promise.reject(Error('AlphaZero service closed'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.close(Error('AlphaZero service reply timed out')),30000);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,op,...payload})+'\n');
    });
  }
  read(chunk) {
    this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer)>32*1024*1024)return this.close(Error('AlphaZero response budget exceeded'));
    let end;
    while((end=this.buffer.indexOf('\n'))>=0) {
      const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);let reply;
      try {reply=JSON.parse(line);}catch {return this.close(Error('Invalid AlphaZero JSON reply'));}
      if(!Number.isSafeInteger(reply?.id)||!this.pending.has(reply.id)||typeof reply.ok!=='boolean')
        return this.close(Error('Uncorrelated AlphaZero service reply'));
      const waiting=this.pending.get(reply.id);clearTimeout(waiting.timer);this.pending.delete(reply.id);
      if(reply.ok)waiting.resolve(reply);else waiting.reject(Error(reply.error??'AlphaZero service rejected request'));
    }
  }
  async verify() {
    const reply=await this.request('ping');
    if(reply.schema!=='native-alphazero/1'||reply.checkpointSha256!==this.checkpointSha256||reply.catalogSha256!==this.catalogSha256)
      throw Error('AlphaZero service checkpoint/catalog identity mismatch');
    return reply;
  }
  async score(records) {
    const reply=await this.request('score',{records});
    if(!Array.isArray(reply.logits)||reply.logits.length!==records.length||!Array.isArray(reply.values)||reply.values.length!==records.length
      ||reply.values.some(value=>!Number.isFinite(value)||value< -1||value>1)
      ||reply.logits.some(row=>!Array.isArray(row)||row.some(value=>value!==null&&!Number.isFinite(value))))
      throw Error('Invalid AlphaZero policy/value response');
    return {logits:reply.logits,values:reply.values};
  }
  close(error=Error('AlphaZero service closed')) {
    if(this.closed)return;this.closed=true;
    for(const waiting of this.pending.values()){clearTimeout(waiting.timer);waiting.reject(error);}this.pending.clear();
    if(this.child.exitCode===null)this.child.kill();
  }
  async shutdown() {if(!this.closed)try {await this.request('close');}catch {}this.close();await this.exited;}
}
