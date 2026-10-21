import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeSearchProvider} from '../integrations/local-worker/native-search-provider.mjs';

function fixture() {
  const calls=[];let next=0;
  const view={status:'playing',hand:[{printingId:'known-own-card'}],opponent:{handCount:7},actions:[],prompts:[]};
  const worker={closed:false,close(){this.closed=true;},async request(method,payload){calls.push({method,payload});
    if(method==='search-begin'||method==='search-step')return {handle:`branch-${++next}`};
    if(method==='search-observe')return {safeView:view,toPlay:'human',result:null};
    if(method==='search-validate')return {valid:true};return {closed:true};}};
  return {provider:new NativeSearchProvider({worker}),worker,calls,view,decks:{human:Array(60).fill('a'),opponent:Array(60).fill('b')}};
}
test('search world request uses visible facts and independent supplied seed, preserving parent branches',async()=>{
  const f=fixture(),root=await f.provider.begin(f.view,[],f.decks,132);
  const child=await f.provider.step(root,{actionId:'public-action'});
  assert.notEqual(child,root);assert.equal(f.calls[0].payload.seed,132);
  assert.deepEqual((await f.provider.observe(root)).safeView,f.view);
  assert.equal(await f.provider.validate(child,{actionId:'public-action'}),true);
  await f.provider.close(child);await assert.rejects(f.provider.observe(child),/closed/);
  assert.equal((await f.provider.observe(root)).toPlay,'human');
  await f.provider.shutdown();assert.equal(f.worker.closed,true);
});
test('privileged root or history fails before native IPC rather than becoming a hypothetical world',async()=>{
  const f=fixture();
  await assert.rejects(f.provider.begin({...f.view,opponent:{hand:[{printingId:'secret'}]}},[],f.decks,2),{code:'UNSUPPORTED_SEARCH_DOMAIN'});
  await assert.rejects(f.provider.begin(f.view,[{views:{human:f.view,opponent:f.view}}],f.decks,2),{code:'UNSUPPORTED_SEARCH_DOMAIN'});
  assert.equal(f.calls.length,0);await f.provider.shutdown();
});
test('parallel tree cleanup is serialized over the single-request native transport',async()=>{
  const f=fixture();let pending=false;
  const original=f.worker.request.bind(f.worker);
  f.worker.request=async(...args)=>{assert.equal(pending,false);pending=true;
    try{await new Promise(resolve=>setTimeout(resolve,1));return await original(...args);}finally{pending=false;}};
  const root=await f.provider.begin({rootView:f.view,publicHistory:[],knownDecks:f.decks,seed:4});
  const child=await f.provider.step(root,{actionId:'x'});
  await Promise.all([f.provider.release(child),f.provider.release(root)]);
  assert.equal(f.provider.handles.size,0);await f.provider.shutdown();
});
