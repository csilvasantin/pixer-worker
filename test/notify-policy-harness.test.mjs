import test from "node:test";
import assert from "node:assert/strict";
import {
  FakeClock,MemoryKv,createTelegramSpy,createPolicyHarness,event,
  sensitiveLeaks,assertSafeSummary,assertSummaryShape,assertExactConcurrentCount
} from "./support/notify-policy-harness.mjs";

test("KV simulado conserva TTL, reset y lectura por prefijo",async()=>{
  const clock=new FakeClock(1_000),kv=new MemoryKv(clock);
  await kv.put("notify:probe:a",JSON.stringify({count:2}),{expirationTtl:60});
  await kv.put("other",JSON.stringify({count:9}),{expirationTtl:60});
  assert.deepEqual(await kv.get("notify:probe:a","json"),{count:2});
  assert.deepEqual((await kv.list({prefix:"notify:"})).keys.map(x=>x.name),["notify:probe:a"]);
  clock.advance(60_001);
  assert.equal(await kv.get("notify:probe:a"),null,"TTL elimina la ventana vencida");
  await kv.delete("other");assert.equal(await kv.get("other"),null,"reset explícito elimina el agregado");
});

test("harness prohíbe Telegram real y captura únicamente el resumen",async()=>{
  const adapter={record:async(input,{send})=>{if(input.flush)await send(input.summary);}};
  const h=createPolicyHarness(adapter);
  await h.record(event({flush:true,summary:"20 probe_404 · paths /a · primera 10:00 · última 10:09"}));
  assert.equal(h.telegram.messages.length,1);
  await assert.rejects(()=>h.telegram.fetch("https://api.telegram.org/bot-real/sendMessage"),/network forbidden/);
});

test("el harness hace visible la pérdida del patrón KV read-modify-write",async()=>{
  const adapter={record:async(_input,{kv})=>{
    const current=Number(await kv.get("notify:count"))||0;
    await kv.put("notify:count",String(current+1),{expirationTtl:600});
  }};
  const h=createPolicyHarness(adapter);
  await h.recordConcurrent(Array.from({length:12},(_,i)=>event({path:"/p/"+i})));
  assert.equal(Number(await h.kv.get("notify:count")),1,"el RMW ingenuo pierde 11 eventos y no satisface el contrato");
  h.kv.available=false;
  await assert.rejects(()=>h.record(event()),/KV unavailable/);
  assert.equal(h.telegram.messages.length,0,"un fallo KV no dispara Telegram desde el harness");
});

test("contrato de producción exige conservar el conteo concurrente exacto",async()=>{
  let count=0,queue=Promise.resolve();
  const adapter={
    record:async()=>{queue=queue.then(()=>{count+=1;});await queue;},
    diagnostics:async()=>({count})
  };
  await assertExactConcurrentCount(adapter,{count:20});
});

test("redacción rechaza Origin spoof, IP, query y secretos",()=>{
  const spoofedOrigin="https://evil.invalid";
  const unsafe=`origin ${spoofedOrigin}/x?innocent=value · 203.0.113.42 · Authorization: Bearer x`;
  assert.ok(sensitiveLeaks(unsafe).length>=4);
  const safe="20 auth_rejected · paths /grid/book · primera 10:00 · última 10:09";
  assertSafeSummary(safe,["super-secret-value",spoofedOrigin]);
  assertSummaryShape(safe);
});

test("los eventos de stock frecuentes pueden representarse sin cuerpos ni identidad",()=>{
  const sample=event({method:"POST",path:"/stock/track/*",status:200,error:null,origin:"redacted"});
  assert.deepEqual(sample,{method:"POST",path:"/stock/track/*",status:200,error:null,origin:"redacted",at:Date.UTC(2026,7,7,10,0,0)});
  assertSafeSummary("42 stock_stats · paths /stock/track/* · primera 10:00 · última 10:10");
});
