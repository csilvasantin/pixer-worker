import assert from "node:assert/strict";

export class FakeClock {
  constructor(start=Date.UTC(2026,7,7,10,0,0)){this.value=start;}
  now=()=>this.value;
  advance(ms){this.value+=ms;return this.value;}
}

// Sustituto deliberadamente pequeño de KV: TTL, prefijos y operaciones async.
// Promise.all sobre varios record() reproduce el patrón read→modify→write que
// puede perder incrementos si el agregador no diseña una estrategia segura.
export class MemoryKv {
  constructor(clock=new FakeClock()){this.clock=clock;this.data=new Map();this.ops=[];this.available=true;}
  _live(key){
    if(!this.available)throw new Error("KV unavailable");
    const row=this.data.get(key);if(!row)return null;
    if(row.expiresAt&&row.expiresAt<=this.clock.now()){this.data.delete(key);return null;}
    return row;
  }
  async get(key,type){
    this.ops.push({op:"get",key,at:this.clock.now()});
    const row=this._live(key);if(!row)return null;
    if(type==="json"){try{return JSON.parse(row.value);}catch{return null;}}
    return row.value;
  }
  async put(key,value,options={}){
    if(!this.available)throw new Error("KV unavailable");
    const ttl=Number(options.expirationTtl)||0;
    this.ops.push({op:"put",key,ttl,at:this.clock.now()});
    this.data.set(key,{value:String(value),expiresAt:ttl?this.clock.now()+ttl*1000:0});
  }
  async delete(key){if(!this.available)throw new Error("KV unavailable");this.ops.push({op:"delete",key,at:this.clock.now()});this.data.delete(key);}
  async list({prefix=""}={}){
    if(!this.available)throw new Error("KV unavailable");
    const keys=[];for(const key of this.data.keys())if(key.startsWith(prefix)&&this._live(key))keys.push({name:key});
    return {keys,complete:true};
  }
  snapshot(){const out={};for(const key of this.data.keys()){const row=this._live(key);if(row)out[key]=JSON.parse(row.value);}return out;}
}

export function createTelegramSpy(){
  const messages=[];
  return {
    messages,
    send:async text=>{messages.push(String(text));return {ok:true};},
    fetch:async()=>{throw new Error("network forbidden: Telegram real must never run in tests");}
  };
}

export function event(overrides={}){
  return {method:"POST",path:"/unknown",status:404,error:"not-found",origin:"https://example.invalid",at:Date.UTC(2026,7,7,10,0,0),...overrides};
}

export function createPolicyHarness(adapter,{start,kv}={}){
  assert.equal(typeof adapter.record,"function","adapter.record(event,deps) es obligatorio");
  const clock=new FakeClock(start),store=kv||new MemoryKv(clock),telegram=createTelegramSpy();
  const deps={kv:store,now:clock.now,send:telegram.send};
  return {
    clock,kv:store,telegram,
    record:input=>adapter.record(input,deps),
    recordConcurrent:inputs=>Promise.all(inputs.map(input=>adapter.record(input,deps))),
    flush:()=>typeof adapter.flush==="function"?adapter.flush(deps):null,
    diagnostics:()=>typeof adapter.diagnostics==="function"?adapter.diagnostics(deps):null
  };
}

export async function assertExactConcurrentCount(adapter,{count=20,eventFactory=i=>event({path:`/probe/${i}`})}={}){
  const h=createPolicyHarness(adapter);
  await h.recordConcurrent(Array.from({length:count},(_,i)=>eventFactory(i)));
  const diagnostics=await h.diagnostics();
  assert.equal(diagnostics?.count,count,`la agregación concurrente debe conservar los ${count} eventos`);
  return h;
}

const SENSITIVE_PATTERNS=[
  /(?:token|secret|password|authorization|cookie|api[_-]?key)\s*[:=]/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /https?:\/\//i,
  /\/[A-Za-z0-9_.*\/-]*\?[^\s<]*/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i
];
export function sensitiveLeaks(text,extra=[]){
  const value=String(text||"");
  return SENSITIVE_PATTERNS.filter(re=>re.test(value)).map(re=>String(re))
    .concat(extra.filter(secret=>secret&&value.includes(String(secret))).map(secret=>"literal:"+secret));
}
export function assertSafeSummary(text,extra=[]){
  assert.deepEqual(sensitiveLeaks(text,extra),[],"el resumen no puede exponer secretos, query sensible ni IP");
  assert.ok(String(text).length<=1200,"el resumen Telegram permanece acotado");
}

export function assertSummaryShape(text){
  const value=String(text);
  assert.match(value,/\b\d+\b/,"incluye conteo");
  assert.match(value,/primera/i,"incluye primera vez");
  assert.match(value,/última|ultima/i,"incluye última vez");
  assert.match(value,/\/[A-Za-z0-9_.*\/-]+/,"incluye paths normalizados");
}
