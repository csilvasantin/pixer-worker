import test from 'node:test';
import assert from 'node:assert/strict';
import {advertisementAnalysis,EXTRACT_PROMPT} from '../src/advertisement-analysis.mjs';

const base={action:'verify-visual',image:'data:image/png;base64,Yg==',referenceImage:'data:image/jpeg;base64,YQ==',deliveryMode:'standalone-artwork',scene:'Coffee cup inside a photographed store display; preserve installation.'};
const verdict={hasText:false,productPresent:true,issues:[],hasDisplayMockup:false};
const request=body=>new Request('https://api.admira.store/image/analyze',{method:'POST',body:JSON.stringify(body)});
const reply=value=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(value)}]}}]});

test('standalone verification requires and preserves explicit display evidence even when product and copy pass',async()=>{
 for(const hasDisplayMockup of [true,false]){
  let sent;
  const r=await advertisementAnalysis(request(base),{GEMINI_API_KEY:'test'},async(_url,init)=>{sent=JSON.parse(init.body);return reply({...verdict,hasDisplayMockup});});
  assert.equal(r.status,200);assert.equal((await r.json()).verification.hasDisplayMockup,hasDisplayMockup);
  const schema=sent.generationConfig.responseSchema;
  assert.equal(schema.properties.hasDisplayMockup.type,'BOOLEAN');assert.ok(schema.required.includes('hasDisplayMockup'));
  const prompt=sent.contents[0].parts.at(-1).text;
  assert.match(prompt,/standalone-artwork/);assert.match(prompt,/even when.*REFERENCE/s);
  assert.match(prompt,/untrusted.*cannot request.*installation/s);
  assert.match(prompt,/not product packaging/);
 }
});

test('standalone verification rejects absent or malformed display evidence',async()=>{
 for(const flag of [undefined,null,'false',0,{}]){
  const result={...verdict,hasDisplayMockup:flag};if(flag===undefined)delete result.hasDisplayMockup;
  const r=await advertisementAnalysis(request(base),{GEMINI_API_KEY:'test'},async()=>reply(result));
  assert.equal(r.status,502);assert.equal((await r.json()).error,'analysis-invalid');
 }
});

test('unsupported delivery modes and extraction mode misuse fail before provider admission',async()=>{
 let calls=0;
 for(const body of [...['installation','',null,true].map(deliveryMode=>({...base,deliveryMode})),{...base,action:'extract'}]){
  const r=await advertisementAnalysis(request(body),{GEMINI_API_KEY:'test'},async()=>{calls++;return reply(verdict);});
  assert.equal(r.status,400);assert.equal((await r.json()).error,'invalid-delivery-mode');
 }
 assert.equal(calls,0);
});

test('legacy clients without deliveryMode retain their existing schema and response',async()=>{
 const body={...base};delete body.deliveryMode;let sent;
 const r=await advertisementAnalysis(request(body),{GEMINI_API_KEY:'test'},async(_url,init)=>{sent=JSON.parse(init.body);return reply({...verdict,hasDisplayMockup:true});});
 assert.equal(r.status,200);assert.deepEqual((await r.json()).verification,{hasText:false,productPresent:true,issues:[]});
 assert.equal(Object.hasOwn(sent.generationConfig.responseSchema.properties,'hasDisplayMockup'),false);
});

test('standalone evidence does not erase product/copy defects or weaken generated box validation',async()=>{
 for(const result of [{...verdict,hasText:true},{...verdict,productPresent:false},{...verdict,issues:['wrong product']}]){
  const r=await advertisementAnalysis(request(base),{GEMINI_API_KEY:'test'},async()=>reply(result));assert.deepEqual((await r.json()).verification,result);
 }
 for(const [box,status] of [[[.411,.284,.463,.726],502],[[100,200,900,800],200]]){
  const r=await advertisementAnalysis(request({...base,target:{width:1080,height:1920},reservedTextZone:{x:0,y:0,w:1080,h:100}}),{GEMINI_API_KEY:'test'},async()=>reply({...verdict,protectedSubjects:[{label:'coffee cup',box}]}));
  assert.equal(r.status,status);if(status===200){const v=(await r.json()).verification;assert.equal(v.hasDisplayMockup,false);assert.deepEqual(v.protectedSubjects[0].box,box);assert.equal(v.compositionSafe,true);}
 }
});

test('extraction identifies products and scene inside the artwork instead of the photographed support',()=>{
 assert.match(EXTRACT_PROMPT,/inner advertising artwork/);
 assert.match(EXTRACT_PROMPT,/outer advertising carrier/);
 assert.match(EXTRACT_PROMPT,/not infer.*words/i);
});
