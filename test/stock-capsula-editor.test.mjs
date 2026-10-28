import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import worker, {stockPublishHandler} from '../src/index.js';
import { validateEditableCapsula, capsulePreviewKey, boundedJson, capsuleReviewKey } from '../src/stock-capsula-editor.mjs';
import { capsulaUrlJobKey } from '../src/capsula-url.mjs';

const ref='capsula-url:aa519cf8a50173ad';
const id='1792700022035-lho8uh';
const original={id,num:1815,type:'video',externalRef:ref,tags:['capsula','vertical'],capsuleSource:{version:8,sourceUrl:'https://www.youtube.com/shorts/MgKUv4ZV1Mc'},assetKey:`stock/${id}/asset.mp4`,url:'https://stock.admira.store/original.mp4'};
const draft=()=>({schema:'capsula/1',ref,version:8,parentId:id,plantilla:'v5.7',orientaciones:['vertical','horizontal'],saga:{tema:'creatividad',color:'#1F6FEB'},textos:{titulo:'¿Sabías que?',tipologia:'Creatividad',subtitulo:'Una improvisación',gancho:'Recuerdas Depredador',giro:'Mac improvisó el afeitado',remate:'Bill Duke hizo historia',fuente:{texto:'Fuente: FILMAZIQ',url:'https://www.youtube.com/shorts/MgKUv4ZV1Mc'}},spans:[{campo:'giro',ini:0,fin:3,estilo:'enfasis'}],media:[{id:'fondo',tipo:'video',src:'https://stock.admira.store/stock/source.mp4',t:[0,12],role:'background',credito:'Vídeo: FILMAZIQ',recorte:{x:0,y:0,w:1,h:1}}],tiempos:{gancho:[0,3],giro:[3,8],remate:[8,12]},cartelas:{preroll:false,postroll:false},origen:{url:'https://www.youtube.com/shorts/MgKUv4ZV1Mc',clave:'youtube:MgKUv4ZV1Mc'},sourceGuion:{objeto:'Afeitado en Depredador',capsulas:[{version:'v1',duracion_s:12}],datoOriginal:'conservar'}});
function bucket(seed={}) {
 const store=new Map(Object.entries(seed));let counter=0;const etags=new Map();
 return {store, writes:[], async head(key){return store.has(key)?{key}:null;}, async get(key){const value=store.get(key);if(value==null)return null;return {etag:etags.get(key)||'initial',size:typeof value==='string'?Buffer.byteLength(value):value.length,body:typeof value==='string'?value:value,async json(){return JSON.parse(value)},async text(){return value}};},
 async put(key,value,options={}){if(options.onlyIf?.etagDoesNotMatch==='*'&&store.has(key))return null;if(options.onlyIf?.etagMatches&&(etags.get(key)||'initial')!==options.onlyIf.etagMatches)return null;store.set(key,value);const etag='e'+(++counter);etags.set(key,etag);this.writes.push(key);return {etag};},
 async list({prefix=''}){return {objects:[...store.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}};
}
function env() {
 const history=[original,{...original,id:'old-v7',num:1700,oculto:true,capsuleSource:{...original.capsuleSource,version:7}},{...original,id:'horizontal',num:1816,tags:['horizontal']}];
 return {FLEET_KEY:'test-fleet',STOCK_BUCKET:bucket({[`stock/${id}/meta.json`]:JSON.stringify(original),[`stock/${id}/capsula.json`]:JSON.stringify(draft()),'stock/index.json':JSON.stringify({items:history})})};
}
const ctx={waitUntil(){}};
const request=(path,body,method='POST',auth=true)=>new Request('https://api.admira.store'+path,{method,headers:{Origin:'https://www.ainimation.studio','Content-Type':'application/json',...(auth?{'X-Fleet-Key':'test-fleet'}:{}),...(method==='PUT'?{'If-Match':'"initial"'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
const call=(e,path,body,method='POST',auth=true)=>worker.fetch(request(path,body,method,auth),e,ctx);

test('schema preserves valid copy/ranges but rejects overlap, arbitrary styles, unsafe media, crop overflow',()=>{
 assert.equal(validateEditableCapsula(draft()).ok,true);
 for(const change of [d=>d.spans[0].fin=999,d=>d.spans[0].estilo='font-size:72px',d=>d.tiempos.giro=[2,8],d=>d.media[0].src='http://localhost/private',d=>d.media[0].src='https://127.0.0.1/private',d=>d.media[0].recorte.w=2,d=>d.media[0].credito='']){const d=draft();change(d);assert.equal(validateEditableCapsula(d).ok,false);}
 assert.equal(capsulePreviewKey(ref,9,'uuid','../../asset.mp4'),null);
});

test('bounded JSON enforces actual stream length even without Content-Length',async()=>{
 const r=await boundedJson(new Request('https://api.test',{method:'POST',body:JSON.stringify({text:'a'.repeat(1000)})}),50);assert.equal(r.status,413);
});

test('GET capsule includes hidden prior revisions of same orientation; missing seed still returns history',async()=>{
 const e=env();let r=await call(e,'/stock/capsula/'+id,undefined,'GET',false);const d=await r.json();assert.equal(r.status,200);assert.equal(d.nextVersion,9);assert.deepEqual(d.history.map(x=>x.id),[id,'old-v7']);assert.equal(d.history[1].oculto,true);assert.deepEqual(d.capsula.sourceGuion,draft().sourceGuion);
 e.STOCK_BUCKET.store.delete(`stock/${id}/capsula.json`);r=await call(e,'/stock/capsula/'+id,undefined,'GET',false);const missing=await r.json();assert.equal(r.status,404);assert.equal(missing.history.length,2);
});

test('saving requires a session; text edit cannot alter published binary/source/version; conflicting draft is rejected',async()=>{
 const e=env();assert.equal((await call(e,'/stock/capsula/'+id,draft(),'PUT',false)).status,401);
 let d=draft();d.textos.gancho='Una frase editada';d.sourceGuion={malicious:'overwrite'};d.origen={url:'https://example.com/evil'};
 let r=await call(e,'/stock/capsula/'+id,d,'PUT');const saved=await r.json();assert.equal(r.status,200,JSON.stringify(saved));assert.equal(saved.capsula.textos.gancho,'Una frase editada');assert.deepEqual(saved.capsula.sourceGuion,draft().sourceGuion);assert.equal(saved.capsula.origen.url,draft().origen.url);
 assert.deepEqual(e.STOCK_BUCKET.writes,[`stock/${id}/capsula.json`]);assert.deepEqual(JSON.parse(e.STOCK_BUCKET.store.get(`stock/${id}/meta.json`)),original);
 d.version=9;assert.equal((await call(e,'/stock/capsula/'+id,d,'PUT')).status,409);
 const stale=request('/stock/capsula/'+id,draft(),'PUT');stale.headers.set('If-Match','stale');assert.equal((await worker.fetch(stale,e,ctx)).status,412);
});

test('AInimation preview job keeps full script and advances v8 to v9 without hiding v8 or publishing',async()=>{
 const e=env();assert.equal((await call(e,'/capsula/url/encargar',{capsula:draft(),capsuleVersion:9,previewOnly:true},'POST',false)).status,401);
 assert.equal((await call(e,'/capsula/url/encargar',{capsula:draft(),capsuleVersion:9,previewOnly:false})).status,400);
 const r=await call(e,'/capsula/url/encargar',{capsula:draft(),capsuleVersion:9,previewOnly:true});const result=await r.json();assert.equal(r.status,202,JSON.stringify(result));assert.equal(result.job.capsuleVersion,9);assert.equal(result.job.previewOnly,true);assert.match(result.job.renderId,/^[0-9a-f-]+$/);
 const job=JSON.parse(e.STOCK_BUCKET.store.get(capsuleReviewKey(ref,result.job.renderId)));assert.deepEqual(job.capsula.sourceGuion,draft().sourceGuion);assert.deepEqual(job.capsula.tiempos,draft().tiempos);assert.equal(job.ref,ref);assert.equal(e.STOCK_BUCKET.writes.some(k=>k.endsWith('/meta.json')),false);
 const publish=await call(e,'/stock/publish',{previewOnly:true});assert.equal(publish.status,409);assert.equal((await publish.json()).error,'preview-cannot-publish');
});

test('preview files/status require renderer auth and matching render id; ready jobs leave the queue',async()=>{
 const e=env();const queued=await (await call(e,'/capsula/url/encargar',{capsula:draft(),capsuleVersion:9,previewOnly:true})).json();const job=JSON.parse(e.STOCK_BUCKET.store.get(capsuleReviewKey(ref,queued.job.renderId)));
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(20)]).toString('base64');
 const upload={ref,capsuleVersion:9,renderId:job.renderId,filename:'vertical-t1.png',mime:'image/png',base64:bytes};
 assert.equal((await call(e,'/capsula/url/preview-upload',upload,'POST',false)).status,401);
 assert.equal((await call(e,'/capsula/url/preview-upload',{...upload,renderId:'stale'})).status,409);
 const up=await call(e,'/capsula/url/preview-upload',upload);const stored=await up.json();assert.equal(up.status,200,JSON.stringify(stored));assert.match(stored.url,/\/capsula\/url\/preview\/aa519cf8a50173ad\/v9\//);
 const file=await worker.fetch(new Request(stored.url),e,ctx);assert.equal(file.status,200);assert.equal(file.headers.get('Content-Type'),'image/png');
 const video={...upload,filename:'vertical.mp4',mime:'video/mp4',base64:Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(20)]).toString('base64')};
 const uploadedVideo=await (await call(e,'/capsula/url/preview-upload',video)).json();
 const format={url:uploadedVideo.url,stills:[stored.url]};
 const status={ref,capsuleVersion:9,renderId:job.renderId,status:'preview_ready',preview:{orientaciones:{vertical:format,horizontal:format}}};
 assert.equal((await call(e,'/capsula/url/estado',{...status,renderId:'stale'})).status,409);
 const done=await call(e,'/capsula/url/estado',status);assert.equal(done.status,200);assert.equal((await done.json()).status,'preview_ready');
 const queue=await call(e,'/capsula/url/cola',undefined,'GET',false);assert.equal((await queue.json()).jobs.length,0);
 const state=await call(e,'/capsula/url/estado?ref='+ref+'&renderId='+job.renderId,undefined,'GET',false);assert.equal((await state.json()).job.preview.orientaciones.vertical.stills[0],stored.url);
});

test('CORS permits authenticated PUT and optimistic draft headers from AInimation',async()=>{
 const r=await worker.fetch(new Request('https://api.admira.store/stock/capsula/'+id,{method:'OPTIONS',headers:{Origin:'https://www.ainimation.studio','Access-Control-Request-Method':'PUT'}}),env(),ctx);
 assert.match(r.headers.get('Access-Control-Allow-Methods'),/PUT/);assert.match(r.headers.get('Access-Control-Allow-Headers'),/If-Match/);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://www.ainimation.studio');assert.match(r.headers.get('Access-Control-Expose-Headers'),/ETag/);
});


test('ETag is required after loading an existing draft and rejects a concurrent editor overwrite',async()=>{
 const e=env();const loaded=await call(e,'/stock/capsula/'+id,undefined,'GET',false);
 assert.equal(loaded.headers.get('ETag'),'"initial"');
 const first=request('/stock/capsula/'+id,draft(),'PUT');first.headers.delete('If-Match');
 assert.equal((await worker.fetch(first,e,ctx)).status,428);
 const edited=request('/stock/capsula/'+id,draft(),'PUT');edited.headers.set('If-Match',loaded.headers.get('ETag'));
 const saved=await worker.fetch(edited,e,ctx);assert.equal(saved.status,200);assert.equal(saved.headers.get('ETag'),'"e1"');
 const stale=request('/stock/capsula/'+id,draft(),'PUT');stale.headers.set('If-Match',loaded.headers.get('ETag'));
 assert.equal((await worker.fetch(stale,e,ctx)).status,412);
 const latest=request('/stock/capsula/'+id,draft(),'PUT');latest.headers.set('If-Match',saved.headers.get('ETag'));
 assert.equal((await worker.fetch(latest,e,ctx)).status,200);
});

test('review phases remain independent and preserve the original production job and Stock metadata',async()=>{
 const e=env();const originalJob={ref,capsuleVersion:8,status:'publicada',source:{url:draft().origen.url}};
 e.STOCK_BUCKET.store.set(capsulaUrlJobKey(ref),JSON.stringify(originalJob));
 const queued=[];
 for(const phase of [1,2,3]) {
  const d=draft();d.textos.gancho='Texto fase '+phase;
  const r=await call(e,'/capsula/url/encargar',{capsula:d,capsuleVersion:9,previewOnly:true,phase});
  assert.equal(r.status,202);queued.push((await r.json()).job);
 }
 assert.equal(new Set(queued.map(j=>j.renderId)).size,3);
 assert.deepEqual(JSON.parse(e.STOCK_BUCKET.store.get(capsulaUrlJobKey(ref))),originalJob);
 assert.deepEqual(JSON.parse(e.STOCK_BUCKET.store.get(`stock/${id}/meta.json`)),original);
 const list=await (await call(e,'/capsula/url/cola',undefined,'GET',false)).json();assert.equal(list.jobs.length,3);
 const capsule=await (await call(e,'/stock/capsula/'+id,undefined,'GET',false)).json();
 assert.equal(capsule.item.num,1815);assert.equal(capsule.reviews.length,3);assert.deepEqual(capsule.reviews.map(j=>j.phase).sort(),[1,2,3]);
 for(const j of queued){
  const state=await (await call(e,'/capsula/url/estado?ref='+ref+'&renderId='+j.renderId,undefined,'GET',false)).json();
  assert.equal(state.job.phase,j.phase);assert.equal(state.job.renderId,j.renderId);
 }
 const badPhase=await call(e,'/capsula/url/encargar',{capsula:draft(),capsuleVersion:9,previewOnly:true,phase:4});assert.equal(badPhase.status,400);
 const noRender=await call(e,'/capsula/url/preview-upload',{ref,capsuleVersion:9,filename:'frame.png',mime:'image/png',base64:''});assert.equal(noRender.status,409);
 const stale=await call(e,'/capsula/url/estado?ref='+ref+'&renderId=missing',undefined,'GET',false);assert.equal(stale.status,404);
});

test('renderer cannot declare a missing or partial output ready',async()=>{
 const e=env();const queued=await (await call(e,'/capsula/url/encargar',{capsula:draft(),capsuleVersion:9,previewOnly:true})).json();
 const prefix='https://api.admira.store/capsula/url/preview/'+ref.slice(12)+'/v9/'+queued.job.renderId+'/';
 const format={url:prefix+'video.mp4',stills:[prefix+'frame.png']};
 const status={ref,capsuleVersion:9,renderId:queued.job.renderId,status:'preview_ready',preview:{orientaciones:{vertical:format}}};
 assert.equal((await call(e,'/capsula/url/estado',status)).status,400);
 status.preview.orientaciones.horizontal=format;
 const missing=await call(e,'/capsula/url/estado',status);assert.equal(missing.status,409);assert.equal((await missing.json()).error,'preview-asset-not-uploaded');
});

test('AInimation saves with a verified Pixeria API token; Origin alone and an expired token cannot save',async()=>{
 const e=env();e.PIXERIA_SIGNING_KEY='test-session-signing-key';
 const now=Math.floor(Date.now()/1000);
 async function session(exp){
  const body=Buffer.from(JSON.stringify({v:1,aud:'api.admira.store',email:'editor@example.test',iat:now-30,exp})).toString('base64url');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(e.PIXERIA_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('api:'+body))).toString('base64url');
  return body+'.'+sig;
 }
 const originOnly=request('/stock/capsula/'+id,draft(),'PUT',false);
 assert.equal((await worker.fetch(originOnly,e,ctx)).status,401);
 const expired=request('/stock/capsula/'+id,draft(),'PUT',false);expired.headers.set('Authorization','Bearer '+await session(now-1));
 assert.equal((await worker.fetch(expired,e,ctx)).status,401);
 const good=request('/stock/capsula/'+id,draft(),'PUT',false);good.headers.set('Authorization','Bearer '+await session(now+60));
 assert.equal((await worker.fetch(good,e,ctx)).status,200);
});


test('version history recovers archived v1 and v7 even after the public index drops them',async()=>{
 const e=env();
 e.STOCK_BUCKET.store.set('stock/index.json',JSON.stringify({items:[original,{id:'unrelated',type:'video',externalRef:'another-reference'}]}));
 for(const version of [1,7]) {
  const old={...original,id:'old-v'+version,oculto:true,capsuleSource:{...original.capsuleSource,version}};
  e.STOCK_BUCKET.store.set(`stock/${old.id}/meta.json`,JSON.stringify(old));
 }
 const horizontal={...original,id:'hidden-horizontal',tags:['horizontal'],oculto:true,capsuleSource:{version:1}};
 e.STOCK_BUCKET.store.set('stock/hidden-horizontal/meta.json',JSON.stringify(horizontal));
 const unrelated={id:'other-hidden',type:'video',externalRef:'capsula-url:bbbbbbbbbbbbbbbb',tags:['vertical'],oculto:true};
 e.STOCK_BUCKET.store.set('stock/other-hidden/meta.json',JSON.stringify(unrelated));
 const response=await call(e,'/stock/capsula/'+id,undefined,'GET',false);assert.equal(response.status,200);
 const result=await response.json();assert.deepEqual(result.history.map(item=>item.version),[8,7,1]);
 assert.deepEqual(result.history.filter(item=>item.oculto).map(item=>item.id),['old-v7','old-v1']);
 assert.equal(e.STOCK_BUCKET.writes.length,0);
});


test('v5.7 preroll and postroll use output seconds, with contiguous copy and media through the closing card',()=>{
 const c=draft();c.cartelas={preroll:true,postroll:true};
 c.tiempos={gancho:[2,5],giro:[5,10],remate:[10,14]};c.media[0].t=[0,18];
 const result=validateEditableCapsula(c);assert.equal(result.ok,true,JSON.stringify(result.errors));
 assert.deepEqual(result.capsula.tiempos,c.tiempos);assert.deepEqual(result.capsula.media[0].t,[0,18]);
 const early=draft();early.cartelas={preroll:true,postroll:false};
 assert.equal(validateEditableCapsula(early).ok,false);
 c.tiempos.giro=[5.04,10];assert.equal(validateEditableCapsula(c).ok,false);c.tiempos.giro=[5,10];
 c.media[0].t=[0,18.04];assert.equal(validateEditableCapsula(c).ok,false);
 c.media[0].t=[0,18];c.cartelas.postroll=false;assert.equal(validateEditableCapsula(c).ok,false);
 c.media[0].t=[0,14];assert.equal(validateEditableCapsula(c).ok,true);
 c.cartelas={preroll:'yes',postroll:null};assert.equal(validateEditableCapsula(c).ok,false);
});


test('a newly published capsule reopens its clean editable source and can save its first edit', async()=>{
 const e=env();e.STOCK_BUCKET.store.clear();
 const document=JSON.parse(execFileSync('python3',['-c',`
import json
from capsula_cola import guion_v5, editable_source
job = {'ref': '${ref}', 'capsuleVersion': 1, 'source': {'url': 'https://example.com/original', 'kind': 'articulo', 'author': 'Fuente de prueba'}, 'guion': {'objeto': 'Una cápsula nueva', 'tema': 'tecnología', 'fuente': 'Fuente de prueba', 'gancho': 'Un dato interesante', 'giro': 'La explicación del dato', 'remate': 'La idea que recordarás'}}
guion = guion_v5(job)
print(json.dumps(editable_source(job, guion, {'sourceUrl': 'https://stock.admira.store/capsula-url/editor/aa519cf8a50173ad/v1/source.mp4'})))
`],{cwd:new URL('../tools/capsulas-sabiasque/',import.meta.url),encoding:'utf8'}));
 const pending=[];const context={waitUntil:p=>pending.push(Promise.resolve(p).catch(()=>{}))};
 const payload={type:'video',motor:'AdmiraNeXT capsule fixture',mime:'video/mp4',base64:btoa('new-capsule-video'),externalRef:ref,capsuleSource:{version:1,sourceUrl:document.origen.url,broll:{start:0,end:12}},capsula:document,tags:['capsula','vertical']};
 const published=await stockPublishHandler(request('/stock/publish',payload),e,context);
 assert.equal(published.status,200,await published.clone().text());
 const receipt=await published.json();
 const opened=await call(e,'/stock/capsula/'+receipt.id,undefined,'GET',false);
 assert.equal(opened.status,200,await opened.clone().text());
 const result=await opened.json();assert.equal(result.capsula.parentId,receipt.id);
 assert.equal(result.capsula.media[0].src,document.media[0].src);
 assert.deepEqual(result.capsula.sourceGuion,document.sourceGuion);
 const before=e.STOCK_BUCKET.store.get(`stock/${receipt.id}/meta.json`);
 assert.equal(JSON.parse(before).parentId,undefined);
 result.capsula.textos.gancho='Primera edición de la cápsula nueva';
 const edit=request('/stock/capsula/'+receipt.id,result.capsula,'PUT');edit.headers.set('If-Match',opened.headers.get('ETag'));
 const saved=await worker.fetch(edit,e,context);assert.equal(saved.status,200,await saved.clone().text());
 const reloaded=await call(e,'/stock/capsula/'+receipt.id,undefined,'GET',false);
 assert.equal((await reloaded.json()).capsula.textos.gancho,result.capsula.textos.gancho);
 assert.equal(e.STOCK_BUCKET.store.get(`stock/${receipt.id}/meta.json`),before);
 await Promise.all(pending);
});
