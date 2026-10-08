import test from 'node:test';import assert from 'node:assert/strict';
import {advertisementAnalysis,validateAdvertisement,validateExtraction,EXTRACT_SCHEMA} from '../src/advertisement-analysis.mjs';import {isPaidGeneration} from '../src/paid-auth.mjs';
const sample={texts:[{text:'UN CAFÉ CON HIELO\nEN LA PLAYA DE BARCELONA',role:'headline',box:[70,270,250,740],confidence:.98}],subjects:[{label:'iced coffee glass',box:[300,440,800,600]}],scene:'Coffee on Barcelona beach',needsRecreation:true,uncertain:false};
const styled={...sample,texts:sample.texts.map(t=>({...t,typography:{family:'condensed',weight:900,color:'#FFFFFF',align:'center',italic:false,trackingEm:0,lineHeight:1.08,outlineEm:0,outlineColor:'#102D36',shadow:false}}))};
const req=body=>new Request('https://api.admira.store/image/analyze',{method:'POST',body:JSON.stringify(body)});
const response=d=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(d)}]}}]});
test('new OCR and visual-check endpoint is protected by existing paid auth',()=>assert.equal(isPaidGeneration('POST','/image/analyze'),true));
test('extracts exact accents, prices and legal blocks; no fabricated completion',()=>{const d=validateAdvertisement({...sample,texts:[...sample.texts,{text:'2,50 € · Hasta agotar existencias',role:'legal',box:[900,10,950,900],confidence:.5}]});assert.equal(d.texts[1].text,'2,50 € · Hasta agotar existencias');assert.equal(d.uncertain,true);});
test('rejects incomplete schema, inverted or unbounded OCR boxes and unknown roles',()=>{for(const change of [{subjects:null},{uncertain:null},{texts:[{...sample.texts[0],box:[100,200,50,900]}]},{texts:[{...sample.texts[0],box:[0,0,1001,400]}]},{texts:[{...sample.texts[0],role:'instruction'}]}])assert.throws(()=>validateAdvertisement({...sample,...change}));});
test('uses inline image and structured output with bounded provider deadline',async()=>{const r=await advertisementAnalysis(req({image:'data:image/png;base64,YQ=='}),{GEMINI_API_KEY:'test'},async(url,init)=>{assert.match(url,/gemini-2.5-flash:generateContent$/);const b=JSON.parse(init.body);assert.equal(b.generationConfig.responseMimeType,'application/json');assert.equal(b.contents[0].parts[0].inlineData.data,'YQ==');assert.ok(init.signal);return response(styled);});assert.equal(r.status,200);assert.equal((await r.json()).document.texts[0].text,'UN CAFÉ CON HIELO EN LA PLAYA DE BARCELONA');});
test('does not fetch arbitrary URLs, rejects malformed or oversized requests',async()=>{let calls=0;for(const body of [{image:'https://private.test/image'},{image:'data:text/html;base64,YQ=='},{image:'data:image/png;base64,YQ==',action:'execute'}]){const r=await advertisementAnalysis(req(body),{GEMINI_API_KEY:'test'},()=>{calls++;});assert.equal(r.status,400);}assert.equal(calls,0);const r=await advertisementAnalysis(new Request('https://x',{method:'POST',headers:{'Content-Length':'99999999'},body:'{}'}),{GEMINI_API_KEY:'test'});assert.equal(r.status,413);});
test('provider errors and invalid JSON fail closed',async()=>{for(const fetcher of [async()=>Response.json({}, {status:429}),async()=>response('not object'),async()=>Response.json({candidates:[]})])assert.equal((await advertisementAnalysis(req({image:'data:image/png;base64,YQ=='}),{GEMINI_API_KEY:'test'},fetcher)).status,502);});
test('visual review returns factual flags and refuses ambiguous results',async()=>{for(const result of [{hasText:true,productPresent:true,issues:[]},{hasText:false,productPresent:false,issues:['Product truncated']}]){const r=await advertisementAnalysis(req({image:'data:image/png;base64,YQ==',action:'verify-visual',scene:'Coffee'}),{GEMINI_API_KEY:'test'},async()=>response(result));assert.deepEqual((await r.json()).verification,result);}assert.equal((await advertisementAnalysis(req({image:'data:image/png;base64,YQ==',action:'verify-visual'}),{GEMINI_API_KEY:'test'},async()=>response({}))).status,502);});
test('reserved copy zone is checked against complete generated product boxes',async()=>{for(const [bbox,safe] of [[[400,250,950,800],true],[[200,250,950,800],false]]){const r=await advertisementAnalysis(req({image:'data:image/png;base64,YQ==',action:'verify-visual',scene:'iced coffee',target:{width:1080,height:1920},reservedTextZone:{x:0,y:0,w:1080,h:614.4}}),{GEMINI_API_KEY:'test'},async(url,init)=>{assert.match(JSON.parse(init.body).contents[0].parts[1].text,/protectedSubjects/);return response({hasText:false,productPresent:true,issues:[],protectedSubjects:[{label:'iced coffee',box:bbox}]});});assert.equal((await r.json()).verification.compositionSafe,safe);}});
test('invalid reserved zones and missing protected subject evidence fail closed',async()=>{const base={image:'data:image/png;base64,YQ==',action:'verify-visual',target:{width:100,height:100},reservedTextZone:{x:0,y:0,w:100,h:32}};assert.equal((await advertisementAnalysis(req({...base,reservedTextZone:{x:0,y:0,w:101,h:32}}),{GEMINI_API_KEY:'test'},async()=>response({}))).status,400);for(const protectedSubjects of [undefined,[],[{label:'coffee',box:[0,0,1100,500]}]])assert.equal((await advertisementAnalysis(req(base),{GEMINI_API_KEY:'test'},async()=>response({hasText:false,productPresent:true,issues:[],protectedSubjects}))).status,502);});

test('observed type blocks retain colour, proportions, weight and safe style values',()=>{
 const typography={family:'condensed',weight:900,color:'#00ddee',align:'center',italic:false,trackingEm:.01,lineHeight:1.06,outlineEm:.015,outlineColor:'#102d36',shadow:true};
 const d=validateAdvertisement({...sample,texts:[{...sample.texts[0],text:'UN CAFÉ CON HIELO',typography},{...sample.texts[0],text:'EN LA PLAYA DE BARCELONA',typography:{...typography,color:'#FFFF00'}}]});
 assert.equal(d.texts[0].typography.color,'#00DDEE');assert.equal(d.texts[1].typography.color,'#FFFF00');assert.equal(d.texts[0].typography.family,'condensed');assert.equal(d.texts[0].typography.weight,900);
 for(const patch of [{family:'url(https://bad.test)'},{color:'red;filter:url(x)'},{trackingEm:10},{outlineEm:1},{lineHeight:0},{weight:10000},{align:'justify'},{shadow:'true'}])assert.throws(()=>validateAdvertisement({...sample,texts:[{...sample.texts[0],typography:{...typography,...patch}}]}),/invalid-typography/);
 assert.equal(validateAdvertisement(sample).texts[0].typography,undefined,'legacy documents remain valid');
});
test('analysis requests separate colour blocks and observed typography without claiming font identity',async()=>{
 await advertisementAnalysis(req({image:'data:image/png;base64,YQ=='}),{GEMINI_API_KEY:'test'},async(url,init)=>{const prompt=JSON.parse(init.body).contents[0].parts[1].text;assert.match(prompt,/whenever type colour, size, weight or family changes/);assert.match(prompt,/Never claim to identify a proprietary font/);assert.match(prompt,/do not duplicate it in texts/);return response(styled);});
});

test('new extractions require every observed type field while legacy documents remain readable',async()=>{
 assert.equal(validateAdvertisement(sample).texts[0].typography,undefined);
 assert.throws(()=>validateExtraction(sample),/missing-observed-typography/);
 assert.equal(validateExtraction({...sample,texts:[]}).texts.length,0);
 for(const data of [sample,{...styled,texts:[{...styled.texts[0],typography:{family:'sans'}}]}]){
  const r=await advertisementAnalysis(req({image:'data:image/png;base64,YQ=='}),{GEMINI_API_KEY:'test'},async()=>response(data));
  assert.equal(r.status,502);
 }
 const responseResult=await advertisementAnalysis(req({image:'data:image/png;base64,YQ=='}),{GEMINI_API_KEY:'test'},async(url,init)=>{
  const schema=JSON.parse(init.body).generationConfig.responseSchema;
  assert.deepEqual(schema,EXTRACT_SCHEMA);
  assert.ok(schema.properties.texts.items.required.includes('typography'));
  assert.equal(schema.properties.texts.items.properties.typography.required.length,10);
  return response(styled);
 });
 assert.equal(responseResult.status,200,'schema assertions must not be swallowed by handler');
});

test('verification uses structured flags and ignores thought parts',async()=>{
 let config;const r=await advertisementAnalysis(req({image:'data:image/png;base64,YQ==',action:'verify-visual'}),{GEMINI_API_KEY:'test'},async(url,init)=>{config=JSON.parse(init.body).generationConfig;return Response.json({candidates:[{content:{parts:[{thought:true,text:'internal reasoning'},{text:JSON.stringify({hasText:false,productPresent:true,issues:[]})}]}}]});});
 assert.equal(r.status,200);assert.equal(config.thinkingConfig.thinkingBudget,512);assert.ok(config.responseSchema.required.includes('issues'));
});

test('tiny copy inside a package remains protected without becoming a duplicate headline',()=>{
 const d=validateExtraction({...styled,subjects:[{label:'blue perfume bottle',box:[300,400,900,700]}],texts:[styled.texts[0],{...styled.texts[0],text:'EAU DE PARFUM',role:'brand',box:[800,450,840,650]}]});
 assert.equal(d.texts.length,1);assert.equal(d.packageLabels[0].text,'EAU DE PARFUM');assert.match(d.scene,/EAU DE PARFUM/);
 const screen=validateExtraction({...styled,subjects:[{label:'advertising screen',box:[0,0,1000,1000]}]});assert.equal(screen.texts.length,1);
});
