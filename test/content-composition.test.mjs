import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {stockPublishHandler} from '../src/index.js';
import worker from '../src/index.js';
import {COMPOSITION_SCHEMA,bindComposition,compositionFromStock} from '../src/content-composition.mjs';
class Bucket{
 map=new Map();
 async get(key){const value=this.map.get(key);return value==null?null:{json:async()=>JSON.parse(value),body:new Response(value).body,size:typeof value==='string'?value.length:value.byteLength};}
 async put(key,value){this.map.set(key,value instanceof ReadableStream?new Uint8Array(await new Response(value).arrayBuffer()):value);}
 async delete(key){this.map.delete(key);}
 async list({prefix=''}={}){return {objects:[...this.map.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}
}
const pending=[];const ctx={waitUntil(p){pending.push(Promise.resolve(p).catch(()=>{}));}};
const declared=()=>({schema:COMPOSITION_SCHEMA,producer:'admira.studio',renderer:'campaign-canvas.v1',mediaType:'image',width:1280,height:720,complete:true,copy:[{role:'headline',text:'CAFÉ CON HIELO · 1,99 €',box:[50,50,250,900]}]});
const payload=(extra={})=>({type:'image',motor:'adaptador',mime:'image/png',base64:btoa('composition-binary'),dimensions:{width:1280,height:720},...extra});
const req=(body,authenticated=true)=>new Request('https://api.admira.store/stock/publish',{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{'X-Fleet-Key':'test-fleet'}:{})},body:JSON.stringify(body)});
const env=()=>({STOCK_BUCKET:new Bucket(),FLEET_KEY:'test-fleet'});
test('optional exact-copy declaration requires existing authenticated generation identity; legacy imports keep working',async()=>{
 const e=env();let r=await stockPublishHandler(req(payload({composition:declared()}),false),e,ctx);assert.equal(r.status,401);assert.equal(e.STOCK_BUCKET.map.size,0);
 r=await stockPublishHandler(req(payload(),false),e,ctx);assert.equal(r.status,200);const p=await r.json();assert.equal(p.composition,null);
});
test('schema or asset dimensions mismatch is rejected before an asset is written',async()=>{
 for(const composition of [{...declared(),width:1920},{...declared(),mediaType:'pdf'},{...declared(),copy:[{role:'headline',text:'x',box:[0,0,1001,500]}]}]){
  const e=env(),r=await stockPublishHandler(req(payload({composition})),e,ctx);assert.equal(r.status,400);assert.equal(e.STOCK_BUCKET.map.size,0);
 }
});
test('publish binds exact layers to the server-computed binary hash, persists in meta and public index, and imports cannot overwrite them',async()=>{
 const e=env(),composition={...declared(),assetHash:'b'.repeat(64),verification:'forged'};
 const p=await(await stockPublishHandler(req(payload({composition,contentHash:'c'.repeat(64)})),e,ctx)).json();
 assert.equal(p.ok,true);const expected=createHash('sha256').update('composition-binary').digest('hex');assert.equal(p.contentHash,expected);assert.equal(p.composition.assetHash,expected);assert.equal(p.composition.verification,'authenticated-compositor');
 const key=`stock/${p.id}/meta.json`,saved=JSON.parse(e.STOCK_BUCKET.map.get(key));assert.equal(saved.composition.copy[0].text,'CAFÉ CON HIELO · 1,99 €');assert.ok(compositionFromStock(saved));
 await Promise.all(pending);const index=JSON.parse(e.STOCK_BUCKET.map.get('stock/index.json'));assert.equal(index.items[0].composition.assetHash,expected);
 const imported=await(await stockPublishHandler(req(payload({motor:'local'}),false),e,ctx)).json();assert.equal(imported.reused,true);assert.equal(imported.id,p.id);assert.deepEqual(JSON.parse(e.STOCK_BUCKET.map.get(key)).composition,saved.composition);
});
test('same binary may gain an authenticated composition only after server hashing; stale measurements cannot be attached',async()=>{
 const e=env(),p=await(await stockPublishHandler(req(payload(),false),e,ctx)).json();
 const enriched=await(await stockPublishHandler(req(payload({composition:declared()})),e,ctx)).json();assert.equal(enriched.reused,true);assert.equal(enriched.id,p.id);assert.equal(enriched.composition.assetHash,p.contentHash);
 const e2=env(),p2=await(await stockPublishHandler(req(payload({dimensions:{width:1920,height:1080}}),false),e2,ctx)).json();
 const refused=await(await stockPublishHandler(req(payload({composition:declared()})),e2,ctx)).json();assert.equal(refused.id,p2.id);assert.equal(refused.composition,null);
});
test('changing the asset raster invalidates the old copy declaration',async()=>{
 const e=env(),p=await(await stockPublishHandler(req(payload({composition:declared()})),e,ctx)).json();
 const r=await worker.fetch(new Request('https://api.admira.store/stock/reasset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.id,mime:'image/png',base64:btoa('new-binary')})}),e,ctx);assert.equal(r.status,200);assert.equal(JSON.parse(e.STOCK_BUCKET.map.get(`stock/${p.id}/meta.json`)).composition,null);
});
test('reasset refreshes binary identity, so old bytes cannot reattach composition to the replacement',async()=>{
 const e=env();e.SIGNAGE_KV={map:new Map(),async get(k){return this.map.get(k)||null;},async put(k,v){this.map.set(k,v);},async delete(k){this.map.delete(k);}};
 const p=await(await stockPublishHandler(req(payload({composition:declared()})),e,ctx)).json();await Promise.all(pending);
 const oldHash=p.contentHash,newHash=createHash('sha256').update('replacement-raster').digest('hex');
 assert.equal(e.SIGNAGE_KV.map.get(`stock:hash:${oldHash}`),p.id);
 const r=await worker.fetch(new Request('https://api.admira.store/stock/reasset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.id,mime:'image/png',base64:btoa('replacement-raster')})}),e,ctx);assert.equal(r.status,200);
 const replaced=JSON.parse(e.STOCK_BUCKET.map.get(`stock/${p.id}/meta.json`));assert.equal(replaced.contentHash,newHash);assert.equal(replaced.composition,null);assert.equal(e.SIGNAGE_KV.map.has(`stock:hash:${oldHash}`),false);
 // Even a stale index cannot alias old bytes: stockHashLookup checks the current metadata hash.
 e.STOCK_BUCKET.map.set('stock/index.json',JSON.stringify({items:[{...replaced,contentHash:oldHash}]}));
 const fresh=await(await stockPublishHandler(req(payload({composition:declared()})),e,ctx)).json();assert.equal(fresh.ok,true);assert.notEqual(fresh.id,p.id);assert.equal(fresh.composition.assetHash,oldHash);assert.equal(JSON.parse(e.STOCK_BUCKET.map.get(`stock/${p.id}/meta.json`)).composition,null);
 await Promise.all(pending);
 const sameNew=await(await stockPublishHandler(req(payload({base64:btoa('replacement-raster')})),e,ctx)).json();assert.equal(sameNew.reused,true);assert.equal(sameNew.id,p.id);
});
test('reasset never removes an old hash mapping owned by another identical asset',async()=>{
 const e=env();e.SIGNAGE_KV={map:new Map(),async get(k){return this.map.get(k)||null;},async put(k,v){this.map.set(k,v);},async delete(k){this.map.delete(k);}};
 const p=await(await stockPublishHandler(req(payload({composition:declared()})),e,ctx)).json();
 e.SIGNAGE_KV.map.set(`stock:hash:${p.contentHash}`,'another-owner');
 const r=await worker.fetch(new Request('https://api.admira.store/stock/reasset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.id,mime:'image/png',base64:btoa('replacement-raster')})}),e,ctx);assert.equal(r.status,200);assert.equal(e.SIGNAGE_KV.map.get(`stock:hash:${p.contentHash}`),'another-owner');
});
test('staged upload binds the streamed hash; absence of a runtime digest fails before moving any asset',async t=>{
 const digestDescriptor=Object.getOwnPropertyDescriptor(crypto,'DigestStream'),fixedDescriptor=Object.getOwnPropertyDescriptor(globalThis,'FixedLengthStream');
 t.after(()=>{if(digestDescriptor)Object.defineProperty(crypto,'DigestStream',digestDescriptor);else delete crypto.DigestStream;if(fixedDescriptor)Object.defineProperty(globalThis,'FixedLengthStream',fixedDescriptor);else delete globalThis.FixedLengthStream;});
 const key='uploads/compose-123.mp4',bytes=new TextEncoder().encode('staged-composition-binary'),input=payload({type:'video',mime:'video/mp4',base64:undefined,r2Staged:key,composition:{...declared(),mediaType:'video'}});
 Object.defineProperty(crypto,'DigestStream',{configurable:true,value:undefined});
 const denied=env();denied.STOCK_BUCKET.map.set(key,bytes);let r=await stockPublishHandler(req(input),denied,ctx);assert.equal(r.status,503);assert.equal(denied.STOCK_BUCKET.map.size,1);
 Object.defineProperty(crypto,'DigestStream',{configurable:true,value:class extends WritableStream{constructor(){let resolve;const done=new Promise(r=>resolve=r),h=createHash('sha256');super({write(b){h.update(b);},close(){resolve(h.digest());}});this.digest=done;}}});
 Object.defineProperty(globalThis,'FixedLengthStream',{configurable:true,value:class extends TransformStream{constructor(){super();}}});
 const e=env();e.STOCK_BUCKET.map.set(key,bytes);r=await stockPublishHandler(req(input),e,ctx);assert.equal(r.status,200);const data=await r.json();assert.equal(data.composition.assetHash,createHash('sha256').update(bytes).digest('hex'));assert.equal(data.composition.mediaType,'video');
});
