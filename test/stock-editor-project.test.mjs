import {r2Conditions} from './helpers/r2-conditions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{stockPublishHandler} from '../src/index.js';
import {validateEditorProject} from '../src/stock-editor-project.mjs';
class Bucket{
 map=new Map();
 async get(key){const v=this.map.get(key);return v==null?null:{json:async()=>JSON.parse(v),body:new Response(v).body,size:typeof v==='string'?v.length:v.byteLength};}
 async put(k,v){this.map.set(k,v instanceof ReadableStream?new Uint8Array(await new Response(v).arrayBuffer()):v);}
 async delete(k){this.map.delete(k);}
 async list({prefix=''}={}){return{objects:[...this.map.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}
}
const project={schema:'ainimation.editor.v1',kind:'director',plan:{title:'Prueba',cast:[],stageItems:[]}};
const req=extra=>new Request('https://api.admira.store/stock/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'animation',motor:'ainimation',mime:'video/webm',base64:btoa('same-render'),editorProject:project,...extra})});
test('new versions keep original untouched, persist editable source outside index and reopen through CORS endpoint',async()=>{
 const e={STOCK_BUCKET:r2Conditions(new Bucket())},pending=[],ctx={waitUntil:p=>pending.push(Promise.resolve(p).catch(()=>{}))};
 const publish=async x=>{const r=await stockPublishHandler(req(x),e,ctx);assert.equal(r.status,200,await r.clone().text());return r.json();};
 const first=await publish({}),original=e.STOCK_BUCKET.map.get(`stock/${first.id}/meta.json`);
 const second=await publish({externalRef:first.id}),third=await publish({externalRef:second.id});
 assert.notEqual(first.id,second.id);assert.notEqual(second.id,third.id);
 assert.equal(e.STOCK_BUCKET.map.get(`stock/${first.id}/meta.json`),original);
 assert.equal(third.externalRef,second.id);assert.equal(third.versionRoot,first.id);
 assert.deepEqual(JSON.parse(e.STOCK_BUCKET.map.get(`stock/${third.id}/editor-project.json`)),project);
 await Promise.all(pending);
 const index=JSON.parse(e.STOCK_BUCKET.map.get('stock/index.json'));
 assert.equal(index.items.find(x=>x.id===second.id).editorKind,'director');
 assert.equal(index.items.find(x=>x.id===second.id).editorProject,undefined);
 const r=await worker.fetch(new Request(third.editorProjectUrl,{headers:{Origin:'https://ainimation.studio'}}),e,ctx);
 assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://ainimation.studio');assert.deepEqual(await r.json(),project);
});
test('bad parent or nonportable source fails before writing anything',async()=>{
 const e={STOCK_BUCKET:r2Conditions(new Bucket())},ctx={waitUntil(){}};
 for(const extra of [{externalRef:'missing'},{editorProject:{...project,plan:{...project.plan,cast:[{src:'blob:lost'}]}}},{motor:'local'}]){
  const r=await stockPublishHandler(req(extra),e,ctx);assert.ok(r.status>=400);assert.equal(e.STOCK_BUCKET.map.size,0);
 }
 assert.throws(()=>validateEditorProject({...project,kind:'unknown'}));
});
