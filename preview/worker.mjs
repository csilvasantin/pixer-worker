// SANDBOX ENTRYPOINT ONLY. Never use this as the production Worker main.
// Test sessions refer to fixture identities; no human browser session is used.
import worker from '../src/index.js';
import {aplicarCors, listaDeOrigenes} from './origenes.mjs';
const fixtures = new Map();
const put = (key, value) => fixtures.set(key, JSON.stringify(value));
const screens = [
  {screen:'preview-sbux-pdg103',locationId:'alsea-sbux-pdg103',loc:'alsea-sbux-pdg103',name:'Starbucks · fixture PDG103',projects:['starbucks'],last_seen:Date.parse('2026-10-14T10:00:00Z')},
  {screen:'preview-sbux-madrid',locationId:'alsea-sbux-madrid',loc:'alsea-sbux-madrid',name:'Starbucks · fixture Madrid',projects:['starbucks'],last_seen:Date.parse('2026-10-14T10:00:00Z')},
  {screen:'preview-xtanco',locationId:'xtanco-valencia',name:'Xtanco · fixture',projects:['xtanco'],last_seen:Date.parse('2026-10-14T10:00:00Z')},
  {screen:'preview-forged',locationId:'alsea-other',name:'Claims Starbucks but different location · fixture',projects:['starbucks'],last_seen:Date.parse('2026-10-14T10:00:00Z')},
];
put('signage_screens_index',screens.map(x=>x.screen));
for(const screen of screens){put('screen:'+screen.screen,screen);put('grid:cfg:'+screen.screen,{...screen,bands:[],circuit:screen.locationId,policy:'manual'});}
const stock = new Map(screens.map((x,i)=>['stock/fixture-'+i+'/meta.json',{id:'fixture-'+i,title:x.name,locationId:x.locationId,projects:x.projects,createdAt:'2026-10-14T10:00:00Z',type:'image'}]));
async function session(env, role) {
  const now = Math.floor(Date.now()/1000), exp = now+900;
  // Carlos's email tests the REAL whitelist role in this isolated namespace.
  // Signing key is sandbox-only; it cannot issue sessions accepted by production.
  const email=role==='superuser'?'csilvasantin@gmail.com':'reader@preview.invalid';
  const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const body=encode(new TextEncoder().encode(JSON.stringify({v:1,aud:'api.admira.store',email,iat:now,exp})));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.PIXERIA_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=encode(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('api:'+body)));
  return {ok:true,token:body+'.'+signature,exp,fixture:true,role};
}
export default {
  async fetch(req, env, ctx) {
    const url=new URL(req.url);
    if(url.pathname==='/preview/session' && req.method==='GET') {
      if(!['superuser','reader'].includes(url.searchParams.get('role')))return Response.json({error:'bad-fixture-role'},{status:400});
      const r=Response.json(await session(env,url.searchParams.get('role')),{headers:{'Cache-Control':'no-store'}});
      aplicarCors(req,r.headers,listaDeOrigenes(env));
      return r;
    }
    const paths=['/ctx','/signage/screens','/grid/screens','/stock','/stock/list','/grid/playlist','/grid/draft','/healthz'];
    if(!paths.includes(url.pathname)||(req.method!=='GET'&&req.method!=='OPTIONS'&&!(url.pathname==='/ctx'&&req.method==='POST')))return Response.json({error:'preview-route-disabled'},{status:404});
    const isolated={...env,SIGNAGE_KV:{
      get:async k=>fixtures.has(k)?fixtures.get(k):env.PREVIEW_KV.get(k),
      put:async(k,v)=>{if(!k.startsWith('ctx:v1:'))throw new Error('sandbox-read-only-inventory');return env.PREVIEW_KV.put(k,v);},
      list:async({prefix})=>({keys:[...fixtures.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})
    },STOCK_BUCKET:{list:async()=>({objects:[...stock.keys()].map(key=>({key})),truncated:false}),get:async k=>stock.has(k)?{json:async()=>stock.get(k)}:null}};
    const result=await worker.fetch(req,isolated,ctx);
    // Solo las previews de la suite y local (PREVIEW_ORIGINS, encargo #5996): eco del Origin si casa, nunca «*».
    aplicarCors(req,result.headers,listaDeOrigenes(env));
    result.headers.set('X-Admira-Preview','5934-isolated-fixtures');
    return result;
  }
};
