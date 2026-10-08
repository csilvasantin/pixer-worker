import test from 'node:test';
import assert from 'node:assert/strict';
import {contentDimensions, etiquetasHonestas} from '../src/stock-via1.mjs';
import {stockPublishHandler} from '../src/index.js';
class Bucket {
 map=new Map();
 async get(key){const value=this.map.get(key);return value==null?null:{json:async()=>JSON.parse(value),body:value};}
 async put(key,value){this.map.set(key,value);}
 async delete(key){this.map.delete(key);}
 async list({prefix='' }={}){return {objects:[...this.map.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}
}
const request=body=>new Request('https://api.admira.store/stock/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('orientation pairs correct conflicting ES/EN tags and preserve all other tags',()=>{
 assert.deepEqual(etiquetasHonestas(['starbucks','landscape','promo','horizontal','good'],{ancho:864,alto:1152}).tags,['starbucks','vertical','portrait','promo','good']);
 assert.deepEqual(etiquetasHonestas(['portrait','vertical','café'],{ancho:1920,alto:1080}).tags,['horizontal','landscape','café']);
 assert.deepEqual(etiquetasHonestas(['horizontal','landscape','cliente'],{ancho:1000,alto:1000}).tags,['cuadrado','cliente']);
 assert.deepEqual(etiquetasHonestas(['café'],{ancho:Infinity,alto:1000}).tags,['café']);
 for(const value of [null,{}, {width:'1080',height:1920},{width:0,height:1},{width:100,height:Infinity}])assert.equal(contentDimensions(value),null);
});
test('real publish stores measured dimensions and bilingual tags without fabricating quality validation; dedup enriches history safely',async()=>{
 const env={STOCK_BUCKET:new Bucket()};const ctx={waitUntil(p){Promise.resolve(p).catch(()=>{});}};
 const first=await(await stockPublishHandler(request({type:'image',motor:'local',mime:'image/png',base64:btoa('orientation-image'),tags:['café','cliente'],dimensions:{width:864,height:1152}}),env,ctx)).json();
 assert.equal(first.ok,true);assert.ok(first.tags.includes('vertical')&&first.tags.includes('portrait'));
 const key=`stock/${first.id}/meta.json`;const saved=JSON.parse(env.STOCK_BUCKET.map.get(key));assert.equal(saved.ancho,864);assert.equal(saved.alto,1152);assert.equal(saved.validacion,undefined);
 saved.tags=['café','cliente','good'];saved.rating={votes:8};env.STOCK_BUCKET.map.set(key,JSON.stringify(saved));
 const again=await(await stockPublishHandler(request({type:'image',motor:'local',mime:'image/png',base64:btoa('orientation-image'),tags:['unrelated'],dimensions:{width:1920,height:1080}}),env,ctx)).json();
 assert.equal(again.reused,true);assert.equal(again.id,first.id);assert.deepEqual(again.tags,['café','cliente','good','vertical','portrait']);
 const restored=JSON.parse(env.STOCK_BUCKET.map.get(key));assert.equal(restored.createdAt,saved.createdAt);assert.deepEqual(restored.rating,{votes:8});assert.equal(restored.ancho,864);
 const audio=await(await stockPublishHandler(request({type:'audio',motor:'local',mime:'audio/mpeg',base64:btoa('orientation-audio'),tags:['música'],dimensions:{width:864,height:1152}}),env,ctx)).json();
 assert.equal(audio.orientacion,null);assert.ok(!audio.tags.includes('portrait'));
});
