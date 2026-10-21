import {LocalWorker,verifyLocalInputs} from './probe.mjs';

const unsupported=message=>Object.assign(new Error(message),{code:'UNSUPPORTED_SEARCH_DOMAIN'});
function actorVisible(value) {
  if(!value || typeof value!=='object' || Array.isArray(value))throw unsupported('Actor-visible root object required');
  const visit=node=>{
    if(!node || typeof node!=='object')return;
    if(node.opponent && Object.hasOwn(node.opponent,'hand'))throw unsupported('Opponent hidden hand cannot enter search');
    if(['authority','workingBoard','views','p1Deck','p2Deck','p1Hand','p2Hand'].some(key=>Object.hasOwn(node,key)))
      throw unsupported('Privileged native state cannot enter search');
    for(const child of Object.values(node))visit(child);
  };
  visit(value);return structuredClone(value);
}

export class NativeSearchProvider {
  constructor({worker,nativeConfig,methods={}}) {
    if(!worker)verifyLocalInputs(nativeConfig);
    this.worker=worker??new LocalWorker(nativeConfig,{timeoutMs:30000});
    this.methods={begin:'search-begin',observe:'search-observe',step:'search-step',validate:'search-validate',close:'search-close',...methods};
    this.handles=new Map();this.closed=false;this.sequence=0;this.tail=Promise.resolve();
    this.diagnostics={worlds:0,observations:0,steps:0,validations:0,releases:0,nativeMilliseconds:0};
  }
  request(operation,payload) {
    const task=this.tail.then(async()=>{
      if(this.closed)throw Error('Search provider is shut down');
      const start=performance.now();
      try {
        const reply=await this.worker.request(this.methods[operation],payload);
        if(reply?.unsupported===true || reply?.code==='UNSUPPORTED_SEARCH_DOMAIN')throw unsupported(reply.reason??'Unsupported native search root');
        if(reply?.error)throw Object.assign(new Error(reply.error),{code:reply.code??'NATIVE_SEARCH_FAILURE'});
        return reply;
      } finally {this.diagnostics.nativeMilliseconds+=performance.now()-start;}
    });
    this.tail=task.catch(()=>{});return task;
  }
  retain(nativeHandle) {
    if((typeof nativeHandle!=='string' && !Number.isSafeInteger(nativeHandle)) || nativeHandle==='')throw Error('Opaque native branch handle required');
    const handle=Object.freeze({id:++this.sequence});this.handles.set(handle,nativeHandle);return handle;
  }
  nativeHandle(handle) {
    if(!this.handles.has(handle))throw Error('Search branch is closed or belongs to another provider');
    return this.handles.get(handle);
  }
  async begin(rootView,publicHistory,knownDecks,seed) {
    if(arguments.length===1)({rootView,publicHistory,knownDecks,seed}=rootView);
    if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw unsupported('Explicit uint32 hypothetical-world seed required');
    const view=actorVisible(rootView);
    if(!Array.isArray(publicHistory)||publicHistory.length>4096)throw unsupported('Bounded public history required');
    const history=publicHistory.map(actorVisible);
    for(const seat of ['human','opponent']) {
      if(!Array.isArray(knownDecks?.[seat])||knownDecks[seat].length!==60||knownDecks[seat].some(card=>typeof card!=='string'))
        throw unsupported('Explicit fixed-scenario sixty-card priors required');
    }
    const reply=await this.request('begin',{rootView:view,publicHistory:history,knownDecks:structuredClone(knownDecks),seed});
    this.diagnostics.worlds++;return this.retain(reply.handle);
  }
  async observe(handle) {
    const reply=await this.request('observe',{handle:this.nativeHandle(handle)});
    const safeView=actorVisible(reply.safeView??reply.view),toPlay=reply.toPlay,result=reply.result??reply.terminal??null;
    if(!['human','opponent'].includes(toPlay)||result!==null&&!['human','opponent',null].includes(result.winner))
      throw Error('Invalid native search actor or terminal result');
    this.diagnostics.observations++;return {safeView,toPlay,result,view:safeView,terminal:result};
  }
  async step(handle,semanticCommand) {
    const parent=this.nativeHandle(handle),reply=await this.request('step',{handle:parent,semanticCommand:structuredClone(semanticCommand)});
    if(reply.handle===parent)throw Error('Search step must preserve its parent branch');
    this.diagnostics.steps++;return this.retain(reply.handle);
  }
  async validate(handle,semanticCommand) {
    const reply=await this.request('validate',{handle:this.nativeHandle(handle),semanticCommand:structuredClone(semanticCommand)});
    if(typeof reply.valid!=='boolean')throw Error('Explicit native legality result required');
    this.diagnostics.validations++;return reply.valid;
  }
  async close(handle) {
    if(!this.handles.has(handle))return;
    await this.request('close',{handle:this.nativeHandle(handle)});this.handles.delete(handle);this.diagnostics.releases++;
  }
  async release(handle) {return this.close(handle);}
  async shutdown() {
    if(this.closed)return;
    try {for(const handle of [...this.handles.keys()])await this.close(handle);}
    finally {this.closed=true;this.worker.close();}
  }
}
