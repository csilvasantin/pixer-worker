import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../src/index.js';
const source=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');

class Bucket {
  constructor(){this.data=new Map()}
  async put(key,value,options={}){this.data.set(key,{bytes:typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value),options})}
  async get(key){const row=this.data.get(key);if(!row)return null;return{json:async()=>JSON.parse(new TextDecoder().decode(row.bytes)),writeHttpMetadata(h){const ct=row.options?.httpMetadata?.contentType;if(ct)h.set('content-type',ct)},body:row.bytes,arrayBuffer:async()=>row.bytes.buffer}}
  async list({prefix=''}){return{objects:[...this.data.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))}}
  async delete(key){this.data.delete(key)}
}
const ctx={waitUntil(){}};

test('Pixeria almacena el HTML autocontenido del interactivo en R2',()=>{
  assert.match(source,/body\.html/);
  assert.match(source,/stock\/\$\{id\}\/asset\.html/);
  assert.match(source,/contentType: 'text\/html; charset=utf-8'/);
  assert.match(source,/\/stock\/asset\/\$\{id\}/);
});
test('el upload HTML tiene límites y exige documento',()=>{
  assert.match(source,/2 \* 1024 \* 1024/);
  assert.match(source,/\^\\s\*<!doctype html>/i);
});
test('POST guarda bytes reales y el asset servido es HTML',async()=>{
  const bucket=new Bucket(); const env={STOCK_BUCKET:bucket,NOTIFY_KEY:'test'};
  const html='<!doctype html><html><body><button>Pago seguro</button>'+('x'.repeat(220))+'</body></html>';
  const posted=await worker.fetch(new Request('https://api.pixeria.com/stock/interactive',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:'test',slug:'kiosko-demo',title:'Kiosko demo',html,tags:['payment']})}),env,ctx);
  assert.equal(posted.status,200); const meta=await posted.json(); assert.equal(meta.ok,true);
  const asset=await worker.fetch(new Request(meta.url),env,ctx); assert.equal(asset.status,200);
  assert.match(asset.headers.get('content-type')||'',/text\/html/); assert.equal(await asset.text(),html);
  assert.match(asset.headers.get('cache-control')||'',/must-revalidate/);
});
