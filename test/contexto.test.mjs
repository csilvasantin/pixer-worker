import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {contextHandler, contextIdentity, belongsToProject, projectItem} from '../src/contexto.mjs';
const secret = 'fixture-signing-key-never-production';
async function token(email, extra={}) {
  const now = Math.floor(Date.now()/1000);
  const body = Buffer.from(JSON.stringify({v:1,aud:'api.admira.store',email,iat:now,exp:now+600,...extra})).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return body+'.'+Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('api:'+body))).toString('base64url');
}
function fixture() {
  const values = new Map();
  const put = (k,d) => values.set(k,JSON.stringify(d));
  put('signage_screens_index',['screen-sbux','screen-other','screen-forged']);
  put('screen:screen-sbux',{screen:'screen-sbux',loc:'alsea-sbux-pdg103',last_seen:Date.now()});
  put('screen:screen-other',{screen:'screen-other',loc:'xtanco-valencia',last_seen:Date.now()});
  put('screen:screen-forged',{screen:'screen-forged',locationId:'alsea-other',projects:['starbucks'],last_seen:Date.now()});
  put('grid:cfg:screen-sbux',{name:'Starbucks',locationId:'alsea-sbux-pdg103',bands:[],projects:['retail']});
  put('grid:cfg:screen-other',{locationId:'xtanco-valencia',bands:[]});
  const stock = new Map([
    ['stock/1/meta.json',{id:'1',locationId:'alsea-sbux-pdg103',createdAt:'2026-10-10'}],
    ['stock/2/meta.json',{id:'2',locationId:'xtanco-valencia',createdAt:'2026-10-14'}],
    ['stock/3/meta.json',{id:'3',locationId:'alsea-other',projects:['starbucks'],createdAt:'2026-10-14'}],
  ]);
  return {values,PIXERIA_SIGNING_KEY:secret,WHITELIST_SITE_TOKEN:'read-only-fixture',SIGNAGE_KV:{
    get:async k=>values.get(k)||null,put:async(k,v)=>values.set(k,String(v)),list:async({prefix})=>({keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})
  },STOCK_BUCKET:{list:async()=>({objects:[...stock.keys()].map(key=>({key})),truncated:false}),get:async k=>stock.has(k)?{json:async()=>stock.get(k)}:null}};
}
const whitelist = async url => {
  const u=new URL(url);
  if(u.hostname==='whitelist.admira.store') return Response.json({ok:true,allowed:true,superuser:u.searchParams.get('email')==='owner@example.test'});
  return Response.json({ok:false},{status:401});
};
function req(path, t, body) {return new Request('https://api.admira.store'+path,{method:body?'POST':'GET',headers:{...(t?{Authorization:'Bearer '+t}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
async function run(env,r) {const old=globalThis.fetch;globalThis.fetch=whitelist;try{return await worker.fetch(r,env,{waitUntil(){}});}finally{globalThis.fetch=old;}}
test('context is bound to verified email; normal users can change look but cannot set or clear project',async()=>{
 const env=fixture(),a=await token('owner@example.test'),b=await token('reader@example.test');
 let r=await contextHandler(req('/ctx',a,{marca:'lumbre',proyecto:'starbucks'}),env,whitelist);assert.equal(r.status,200);
 r=await contextHandler(req('/ctx',b),env,whitelist);assert.deepEqual(await r.json(),{ok:true,marca:null,proyecto:null,superusuario:false});
 r=await contextHandler(req('/ctx',b,{marca:'brumelle'}),env,whitelist);assert.equal(r.status,200);
 for(const proyecto of ['starbucks',null,'off'])assert.equal((await contextHandler(req('/ctx',b,{proyecto}),env,whitelist)).status,403);
 assert.equal((await contextHandler(req('/ctx',a,{email:'reader@example.test'}),env,whitelist)).status,400);
 assert.equal((await contextHandler(req('/ctx',a,{proyecto:'../starbucks'}),env,whitelist)).status,400);
});
test('all three routes filter before counts/limit; claims and names never widen Starbucks',async()=>{
 const env=fixture(),a=await token('owner@example.test');
 for(const path of ['/signage/screens','/grid/screens','/stock','/stock/list']){
  const r=await run(env,req(path+'?proyecto=starbucks&limit=1',a));assert.equal(r.status,200);const d=await r.json();const items=d.screens||d.items;
  assert.equal(items.length,1);assert.ok(items.every(x=>x.locationId.startsWith('alsea-sbux-')&&x.projects.includes('starbucks')));
  if(d.total!==undefined)assert.equal(d.total,1);if(d.total_count!==undefined)assert.equal(d.total_count,1);
  assert.match(r.headers.get('Cache-Control'),/no-store/);
 }
});
test('saved context filters subsequent authenticated reads; explicit reset only for superuser',async()=>{
 const env=fixture(),a=await token('owner@example.test');await contextHandler(req('/ctx',a,{proyecto:'starbucks'}),env,whitelist);
 let r=await run(env,req('/signage/screens',a));assert.equal((await r.json()).screens.length,1);
 r=await run(env,req('/signage/screens?proyecto=off',a));assert.equal((await r.json()).screens.length,3);
 r=await run(env,req('/signage/screens'));assert.equal((await r.json()).screens.length,3);
});
test('forged, expired, fleet and absent sessions cannot select projects; outage fails closed',async()=>{
 const env=fixture(),normal=await token('reader@example.test'),old=await token('owner@example.test',{exp:1});
 for(const t of [null,'forged',old,'fleet-key'])assert.equal((await run(env,req('/signage/screens?proyecto=starbucks',t))).status,401);
 for(const path of ['/signage/screens','/grid/screens','/stock'])assert.equal((await run(env,req(path+'?proyecto=starbucks',normal))).status,403);
 const a=await token('owner@example.test');assert.equal((await contextHandler(req('/ctx',a),env,async()=>{throw new Error('offline')})).status,503);
 env.values.set('ctx:v1:reader@example.test',JSON.stringify({proyecto:'starbucks',marca:'lumbre'}));
 assert.equal((await run(env,req('/signage/screens',normal))).status,403);
 assert.equal((await contextHandler(req('/ctx',normal),env,whitelist)).status,200);
});
test('fixed remote verifier works for Studio sessions; caller role is ignored; no email response fails',async()=>{
 const env={WHITELIST_SITE_TOKEN:'fixture'};
 let verified=0;
 const f=async(url,init)=>{if(url==='https://admira.studio/auth/verify'){verified++;assert.deepEqual(JSON.parse(init.body),{token:'studio-token'});return Response.json({ok:true,email:'reader@example.test',superusuario:true});}return whitelist(url);};
 const d=await contextIdentity(req('/ctx','studio-token'),env,f);assert.equal(verified,1);assert.equal(d.superusuario,false);
 assert.equal((await contextIdentity(req('/ctx','bad'),env,async()=>Response.json({ok:true,superusuario:true}))).status,401);
});
test('playlist declares projects and refuses a screen outside selected project',async()=>{
 const env=fixture(),a=await token('owner@example.test');
 let r=await run(env,req('/grid/playlist?screen=screen-sbux&proyecto=starbucks',a));assert.equal(r.status,200);assert.ok((await r.json()).projects.includes('starbucks'));
 r=await run(env,req('/grid/playlist?screen=screen-other&proyecto=starbucks',a));assert.equal(r.status,404);
});
test('Starbucks provisional membership is exact and derived fields retain legacy data',()=>{
 assert.equal(belongsToProject({locationId:'alsea-sbux-pdg103'},'starbucks'),true);
 for(const item of [{locationId:'alsea-sbux'},{locationId:'alsea-other',projects:['starbucks']},{name:'Starbucks'},{locationId:'ALSea-sbux-1'}])assert.equal(belongsToProject(item,'starbucks'),false);
 assert.deepEqual(projectItem({screen:'legacy',loc:'alsea-sbux-1',custom:42}).projects,['starbucks']);
});
test('shared playlist drafts retain legacy revision behavior and expose scoped metadata',async()=>{
 const env=fixture();env.GRID_KEY='fixture-grid-key';const a=await token('owner@example.test');
 let r=await run(env,req('/grid/draft',null,{key:env.GRID_KEY,screen:'screen-sbux',playlist:'wall',items:[],rev:0}));assert.equal(r.status,200);assert.equal((await r.json()).rev,1);
 r=await run(env,req('/grid/draft?screen=screen-sbux&playlist=wall&proyecto=starbucks',a));const d=await r.json();assert.equal(r.status,200);assert.ok(d.draft.projects.includes('starbucks'));assert.equal(d.draft.locationId,'alsea-sbux-pdg103');
 r=await run(env,req('/grid/draft?screen=screen-other&playlist=wall&proyecto=starbucks',a));assert.equal(r.status,404);
 r=await run(env,req('/grid/draft',null,{key:env.GRID_KEY,screen:'screen-sbux',playlist:'wall',items:[],rev:0}));assert.equal(r.status,409);
});
test('heartbeat persists project/location metadata and a legacy heartbeat does not erase it',async()=>{
 const env=fixture();
 let r=await run(env,req('/signage/heartbeat',null,{screen:'screen-meta',loc:'venue-legacy',locationId:'alsea-sbux-pdg103',projects:['starbucks','retail']}));assert.equal(r.status,200);
 let d=JSON.parse(env.values.get('screen:screen-meta'));assert.equal(d.locationId,'alsea-sbux-pdg103');assert.deepEqual(d.projects,['starbucks','retail']);
 r=await run(env,req('/signage/heartbeat',null,{screen:'screen-meta'}));assert.equal(r.status,200);d=JSON.parse(env.values.get('screen:screen-meta'));assert.equal(d.locationId,'alsea-sbux-pdg103');assert.deepEqual(d.projects,['starbucks','retail']);
 r=await run(env,req('/signage/heartbeat',null,{screen:'screen-meta',locationId:'alsea-sbux-madrid',projects:['starbucks']}));assert.equal(r.status,200);d=JSON.parse(env.values.get('screen:screen-meta'));assert.equal(d.locationId,'alsea-sbux-madrid');assert.deepEqual(d.projects,['starbucks']);
});
