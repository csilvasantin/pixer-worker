import test from 'node:test';
import assert from 'node:assert/strict';
import {textSearchTags, inferredSearchTags, visualSamples} from '../src/stock-search-tags.mjs';
import {itemMatchesQuery,applyMetaPatch} from '../src/stock-catalogo.mjs';
import {stockPublishHandler} from '../src/index.js';
import {r2Conditions} from './helpers/r2-conditions.mjs';
class Bucket{map=new Map();async get(k){let v=this.map.get(k);return v==null?null:{json:async()=>JSON.parse(v),body:v};}async put(k,v){this.map.set(k,v);}async delete(k){this.map.delete(k);}async list({prefix=''}){return{objects:[...this.map.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}}
const req=b=>new Request('https://api.admira.store/stock/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
const ctx={waitUntil(p){Promise.resolve(p).catch(()=>{});}};
const body=(bytes='search-video')=>({type:'video',motor:'yt-dlp',mime:'video/mp4',base64:btoa(bytes),title:'Top Songs',comment:'music top songs 1982',searchContext:{version:1,description:''}});
const jpeg='data:image/jpeg;base64,'+Buffer.concat([Buffer.from([255,216]),Buffer.alloc(220)]).toString('base64');
test('natural notes infer canonical music, songs, explicit year and decade without hashtags or AI',()=>{
 assert.deepEqual(textSearchTags('music top songs 1982'),['1982','música','canción','top canciones','años 80']);
 assert.deepEqual(textSearchTags('https://example.test/1982 1080x1920'),[]);
 const tags=inferredSearchTags({manual:Array.from({length:10},(_,i)=>'manual'+i),comment:'music top songs 1982',generated:['music','rock']});assert.equal(tags.filter(t=>t==='música').length,1);assert.ok(tags.includes('1982')&&tags.includes('rock'));assert.ok(tags.includes('manual9'));
 assert.ok(itemMatchesQuery({tags:['música','canción','1982']},'music 1982'));assert.ok(itemMatchesQuery({tags:['música','1982']},'#musica #1982'));assert.ok(!itemMatchesQuery({tags:['música','1981']},'music 1982'));
});
test('frames are bounded and malformed non-image data never enters the model',()=>{assert.equal(visualSamples([jpeg,jpeg,jpeg,jpeg]).length,3);assert.deepEqual(visualSamples(['data:text/html;base64,AAAA',null,'bad']),[]);});
test('real publication persists search labels and an empty deliberate address, indexed before receipt',async()=>{
 const env={STOCK_BUCKET:r2Conditions(new Bucket())};const p=await(await stockPublishHandler(req(body()),env,ctx)).json();assert.equal(p.ok,true);assert.equal(p.index.status,'ready');assert.ok(p.tags.includes('1982')&&p.tags.includes('música'));assert.deepEqual(p.routingSource,{tags:[],comment:'music top songs 1982'});assert.equal(p.tagging.status,'text-fallback');
 const saved=JSON.parse(env.STOCK_BUCKET.map.get(`stock/${p.id}/meta.json`));assert.equal(saved.comment,'music top songs 1982');assert.equal(saved.analysisFrames,undefined);const index=JSON.parse(env.STOCK_BUCKET.map.get('stock/index.json'));assert.deepEqual(index.items.find(i=>i.id===p.id).routingSource,{tags:[],comment:'music top songs 1982'});
 const patched=applyMetaPatch(saved,{tags_add:['starbucks'],tags_remove:['1982']}).meta;assert.ok(patched.routingSource.tags.includes('starbucks'));assert.ok(!patched.tags.includes('1982'));
});
test('manual address is preserved while text and real-frame model labels enrich search',async()=>{
 const original=globalThis.fetch;let sent;
 globalThis.fetch=async(url,options)=>{assert.match(String(url),/generativelanguage.googleapis.com/);sent=JSON.parse(options.body);return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({tags:['música','1982','starbucks','rock','pop'],audience:'all',category:'producto'})}]}}]}),{headers:{'Content-Type':'application/json'}});};
 try{const env={STOCK_BUCKET:r2Conditions(new Bucket()),GEMINI_API_KEY:'test-only'};const b={...body('frame-video'),comment:'music top songs 1982 #starbucks #paseodegracia103 #ipad',tags:['favorito'],analysisFrames:[jpeg,jpeg,jpeg],searchContext:{version:1,description:'Una selección de canciones de 1982'}};const p=await(await stockPublishHandler(req(b),env,ctx)).json();assert.equal(p.ok,true);assert.deepEqual(p.routingSource,{tags:['favorito'],comment:b.comment});assert.ok(p.tags.includes('1982')&&p.tags.includes('rock')&&p.tags.includes('favorito'));assert.equal(p.tagging.visualFrames,3);assert.equal(sent.contents[0].parts.filter(p=>p.inlineData).length,3);assert.match(sent.contents[0].parts[0].text,/Una selección de canciones de 1982/);}finally{globalThis.fetch=original;}
});
test('reimport enriches a server-verified duplicate without changing historical route or comment',async()=>{
 const env={STOCK_BUCKET:r2Conditions(new Bucket())};const first={...body('old-binary'),searchContext:undefined,comment:'#starbucks #paseodegracia103 #ipad',tags:['starbucks','paseodegracia103','ipad','favorito']};const p=await(await stockPublishHandler(req(first),env,ctx)).json();const before=JSON.parse(env.STOCK_BUCKET.map.get(`stock/${p.id}/meta.json`));
 const again=await(await stockPublishHandler(req({...body('old-binary'),comment:'music top songs 1982'}),env,ctx)).json();assert.equal(again.id,p.id);assert.equal(again.reused,true);assert.ok(again.tags.includes('1982'));
 const after=JSON.parse(env.STOCK_BUCKET.map.get(`stock/${p.id}/meta.json`));assert.equal(after.comment,before.comment);assert.equal(after.createdAt,before.createdAt);assert.deepEqual(after.routingSource,{tags:before.tags,comment:before.comment});
 const hinted=await(await stockPublishHandler(req({...body('not-same-binary'),contentHash:p.contentHash,comment:'music 1999'}),env,ctx)).json();assert.equal(hinted.reused,true);assert.ok(!hinted.tags.includes('1999'));
});

test("promoting an already inferred search tag to an explicit manual tag persists the change",()=>{const m={tags:["starbucks","good"],routingSource:{tags:[],comment:""},quality:"good",searchContext:{version:1}};const r=applyMetaPatch(m,{tags_add:["starbucks"]});assert.equal(r.changed,true);assert.deepEqual(r.meta.routingSource.tags,["starbucks"]);});
