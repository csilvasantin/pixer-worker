// Editable capsule drafts are separate from published Stock binaries.
import { authorizePaidGeneration } from './paid-auth.mjs';

export const CAPSULA_REVIEW_PREFIX = 'capsula-url/editor-jobs/';
export const CAPSULA_MAX_BYTES = 256 * 1024;
export const CAPSULA_REF_RE = /^capsula-url:([a-f0-9]{16})$/;
const STOCK_ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const FIELDS = { titulo: 160, tipologia: 60, subtitulo: 120, gancho: 160, giro: 160, remate: 160 };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
export function capsuleHttps(value) {
  try {
    const u = new URL(value); const h = u.hostname.toLowerCase().replace(/\.$/, '');
    return u.protocol === 'https:' && !u.username && !u.password && h.includes('.') && !h.includes(':')
      && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) && !/(^|\.)(localhost|local|internal)$/.test(h)
      && h !== 'metadata.google.internal' && String(value).length <= 1600;
  } catch { return false; }
}
function interval(value, max = 120) {
  return Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v)) && value[0] >= 0 && value[1] > value[0] && value[1] <= max;
}
// A whitelist, not a sanitizer: rejecting malformed ranges prevents silent copy loss.
export function validateEditableCapsula(raw) {
  const errors = [];
  if (!object(raw)) return { ok: false, errors: ['invalid-capsula'] };
  if (raw.schema !== 'capsula/1') errors.push('invalid-schema');
  if (!CAPSULA_REF_RE.test(String(raw.ref || ''))) errors.push('invalid-ref');
  if (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > 99) errors.push('invalid-version');
  if (!STOCK_ID_RE.test(String(raw.parentId || ''))) errors.push('invalid-parentId');
  if (raw.plantilla !== 'v5.7') errors.push('invalid-plantilla');
  if (!Array.isArray(raw.orientaciones) || !raw.orientaciones.length || raw.orientaciones.length > 2 || raw.orientaciones.some(o => !['vertical', 'horizontal'].includes(o))) errors.push('invalid-orientaciones');
  if (!object(raw.saga) || !text(raw.saga.tema, 60) || !/^#[a-f0-9]{6}$/i.test(String(raw.saga.color || ''))) errors.push('invalid-saga');
  const copy = object(raw.textos) ? raw.textos : {};
  for (const [field, max] of Object.entries(FIELDS)) if ((field !== 'subtitulo' || copy[field] != null) && !text(copy[field], max)) errors.push('invalid-texto-' + field);
  for (const field of ['gancho', 'giro', 'remate']) if (!String(copy[field] || '').trim()) errors.push('missing-texto-' + field);
  if (!object(copy.fuente) || !text(copy.fuente.texto, 200) || !capsuleHttps(copy.fuente.url)) errors.push('invalid-fuente');
  if (!Array.isArray(raw.spans) || raw.spans.length > 150) errors.push('invalid-spans');
  else {
    const ends = {};
    for (const span of [...raw.spans].sort((a,b) => (String(a?.campo).localeCompare(String(b?.campo)) || Number(a?.ini)-Number(b?.ini)))) {
      if (!object(span) || !Object.hasOwn(FIELDS, span.campo) || !['normal', 'cifra', 'enfasis'].includes(span.estilo)
          || !Number.isInteger(span.ini) || !Number.isInteger(span.fin) || span.ini < 0 || span.fin <= span.ini || span.fin > String(copy[span.campo] || '').length
          || span.ini < (ends[span.campo] || 0)) errors.push('invalid-span');
      if (span) ends[span.campo] = span.fin;
    }
  }
  const validCartelas=object(raw.cartelas) && typeof raw.cartelas.preroll==='boolean' && typeof raw.cartelas.postroll==='boolean';
  if(!validCartelas)errors.push('invalid-cartelas');
  const bodyStart=validCartelas && raw.cartelas.preroll ? 2 : 0;
  const timings = object(raw.tiempos) ? raw.tiempos : {};
  let end = bodyStart;
  for (const field of ['gancho', 'giro', 'remate']) {
    const t = timings[field];
    if (!interval(t) || Math.abs(t[0] - end) > 0.011) errors.push('invalid-tiempo-' + field);
    if (Array.isArray(t)) end = t[1];
  }
  const outputDuration=Number.isFinite(end)?end+(validCartelas && raw.cartelas.postroll?4:0):120;
  if (!Array.isArray(raw.media) || raw.media.length > 24) errors.push('invalid-media');
  else for (const m of raw.media) {
    if (!object(m) || !text(m.id, 100) || !['image', 'video'].includes(m.tipo) || !capsuleHttps(m.src)
        || !text(m.credito, 200) || !m.credito.trim() || !interval(m.t, outputDuration)
        || (m.role != null && !['background', 'overlay'].includes(m.role))
        || (m.stockId != null && !STOCK_ID_RE.test(String(m.stockId)))) { errors.push('invalid-media-item'); continue; }
    if (m.recorte != null) {
      const c = m.recorte;
      if (!object(c) || !['x', 'y', 'w', 'h'].every(k => typeof c[k] === 'number' && Number.isFinite(c[k]))
          || c.x < 0 || c.y < 0 || c.w <= 0 || c.h <= 0 || c.x + c.w > 1.00001 || c.y + c.h > 1.00001) errors.push('invalid-recorte');
    }
  }
  if (raw.origen != null && (!object(raw.origen) || !capsuleHttps(raw.origen.url))) errors.push('invalid-origen');
  if (raw.sourceGuion != null && !object(raw.sourceGuion)) errors.push('invalid-sourceGuion');
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > CAPSULA_MAX_BYTES) errors.push('capsula-too-large');
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  // Keep the lossless seed, never arbitrary markup or unknown executable fields.
  const capsula = { schema: 'capsula/1', ref: raw.ref, version: raw.version, parentId: raw.parentId, plantilla: 'v5.7', orientaciones: [...new Set(raw.orientaciones)], saga: {tema:raw.saga.tema,color:raw.saga.color},
    textos: Object.fromEntries(Object.keys(FIELDS).filter(k=>copy[k]!=null).map(k=>[k,copy[k]])), spans: raw.spans.map(s=>({campo:s.campo,ini:s.ini,fin:s.fin,estilo:s.estilo})),
    media: raw.media.map(m=>({id:m.id,tipo:m.tipo,src:m.src,t:[...m.t],credito:m.credito,...(m.role?{role:m.role}:{}),...(m.stockId?{stockId:m.stockId}:{}),...(m.recorte?{recorte:{...m.recorte}}:{})})),
    tiempos: Object.fromEntries(['gancho','giro','remate'].map(k=>[k,[...timings[k]]])), cartelas:{preroll:raw.cartelas.preroll,postroll:raw.cartelas.postroll} };
  capsula.textos.fuente = { texto: copy.fuente.texto, url: copy.fuente.url };
  if (raw.origen) capsula.origen = {...raw.origen};
  if (raw.sourceGuion) capsula.sourceGuion = raw.sourceGuion;
  return {ok:true,capsula,errors:[]};
}
export async function boundedJson(req, max = CAPSULA_MAX_BYTES) {
  if (Number(req.headers.get('Content-Length')) > max) return { error: 'body-too-large', status: 413 };
  const reader = req.body?.getReader(); if (!reader) return {error:'bad-json',status:400};
  const chunks = []; let length = 0;
  while (true) { const {done,value}=await reader.read(); if(done)break; length+=value.byteLength; if(length>max){await reader.cancel();return {error:'body-too-large',status:413};} chunks.push(value); }
  const bytes = new Uint8Array(length); let at=0; for(const part of chunks){bytes.set(part,at);at+=part.length;}
  try { return {body:JSON.parse(new TextDecoder().decode(bytes))}; } catch { return {error:'bad-json',status:400}; }
}
export async function capsuleWriteAuthorized(req, env) { return (await authorizePaidGeneration(req, env)).ok; }
export function capsuleHistory(items, meta) {
  const orientation = meta.orientacion || ['vertical','horizontal'].find(o=>(meta.tags||[]).includes(o));
  return (items || []).filter(m=>m && m.type==='video' && m.externalRef===meta.externalRef && CAPSULA_REF_RE.test(String(m.externalRef)) && (!orientation || m.orientacion===orientation || (m.tags||[]).includes(orientation)))
    .map(m=>({id:m.id,num:m.num||null,version:Math.max(1,Number(m.capsuleSource?.version)||1),orientacion:m.orientacion || ['vertical','horizontal'].find(o=>(m.tags||[]).includes(o)) || null,
      url:m.url||null,thumbnail:m.thumbnail||m.poster||null,oculto:m.oculto===true,parentId:m.parentId||null,createdAt:m.createdAt||null,capsulaUrl:`https://api.admira.store/stock/capsula/${m.id}`}))
    .sort((a,b)=>b.version-a.version || String(b.createdAt).localeCompare(String(a.createdAt)));
}
// The public Stock index intentionally omits archived assets. Read metadata for
// ids missing from that index so the version history still includes v1 and all
// later hidden revisions, without rereading every visible asset in the library.
export async function capsuleCompleteHistory(bucket, meta, indexedItems) {
  const indexed = Array.isArray(indexedItems) ? indexedItems : [];
  const known = new Set(indexed.map(item=>String(item?.id || '')));
  const items = indexed.filter(item=>item?.externalRef===meta.externalRef);
  const seen = new Set(items.map(item=>String(item.id)));
  let cursor;
  do {
    const page = await bucket.list({prefix:'stock/',limit:1000,...(cursor?{cursor}:{})});
    const keys = (page.objects || []).map(item=>item.key).filter(key=>{
      const match=/^stock\/([A-Za-z0-9-]+)\/meta\.json$/.exec(key);
      return match && !known.has(match[1]);
    });
    for(let offset=0;offset<keys.length;offset+=16) {
      const rows=await Promise.all(keys.slice(offset,offset+16).map(async key=>{
        const stored=await bucket.get(key);
        if(!stored)return null;
        return stored.json();
      }));
      for(const item of rows)if(item?.externalRef===meta.externalRef&&!seen.has(String(item.id))) {
        seen.add(String(item.id));items.push(item);
      }
    }
    cursor=page.truncated?page.cursor:undefined;
  } while(cursor);
  // The asset being opened is canonical even if its index entry is stale.
  return capsuleHistory([...items.filter(item=>item.id!==meta.id),meta],meta);
}
export function capsuleReviewKey(ref, renderId) {
  const match = CAPSULA_REF_RE.exec(String(ref || ''));
  return match && /^[a-zA-Z0-9-]{1,80}$/.test(String(renderId || ''))
    ? `${CAPSULA_REVIEW_PREFIX}${match[1]}/${renderId}.json` : null;
}
export async function capsuleReviewJobs(bucket, ref) {
  const match = CAPSULA_REF_RE.exec(String(ref || ''));
  if (!match || !bucket) return [];
  const jobs = []; let cursor;
  do {
    const page = await bucket.list({prefix: `${CAPSULA_REVIEW_PREFIX}${match[1]}/`, limit: 1000, ...(cursor ? {cursor} : {})});
    for (const item of page.objects || []) {
      const stored = await bucket.get(item.key);
      if (!stored) continue;
      try { const job = await stored.json(); if (job.previewOnly === true && job.ref === ref) jobs.push(job); } catch { /* Ignore an unrelated invalid archive entry. */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return jobs.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
export function capsuleReviewSummary(job) {
  return {ref:job.ref, parentId:job.parentId, renderId:job.renderId, phase:job.phase || 1,
    capsuleVersion:job.capsuleVersion, status:job.status, createdAt:job.createdAt,
    updatedAt:job.updatedAt || null, preview:job.preview || null, error:job.error || null};
}
function httpEtag(stored) { return stored?.httpEtag || (stored?.etag ? `"${stored.etag}"` : ''); }
export async function stockCapsulaHandler(req, env, id, getItems) {
  if(!STOCK_ID_RE.test(id))return json({error:'bad-id'},400);
  if(!env.STOCK_BUCKET)return json({error:'r2-not-bound'},500);
  const metaObj=await env.STOCK_BUCKET.get(`stock/${id}/meta.json`); const meta=metaObj?await metaObj.json():null;
  if(!meta)return json({error:'asset-not-found'},404);
  if(!CAPSULA_REF_RE.test(String(meta.externalRef||'')))return json({error:'not-an-editable-capsule'},409);
  const key=`stock/${id}/capsula.json`; const stored=await env.STOCK_BUCKET.get(key); const previous=stored?await stored.json():null;
  if(req.method==='GET') {
    const history=await capsuleCompleteHistory(env.STOCK_BUCKET,meta,await getItems());
    if(!previous)return json({ok:false,error:'capsula-source-not-uploaded',id,history},404);
    const reviews = (await capsuleReviewJobs(env.STOCK_BUCKET, meta.externalRef)).filter(job=>job.parentId===id).map(capsuleReviewSummary);
    return json({ok:true,id,item:{id:meta.id,num:meta.num||null,title:meta.title||''},capsula:previous,history,reviews,nextVersion:Math.min(99,previous.version+1)},200,httpEtag(stored)?{ETag:httpEtag(stored)}:{});
  }
  if(!await capsuleWriteAuthorized(req,env))return json({error:'unauthorized',detail:'Inicia sesión en Pixeria para guardar el borrador'},401);
  const parsed=await boundedJson(req);if(parsed.error)return json({error:parsed.error},parsed.status);
  const raw=parsed.body?.capsula || parsed.body; const norm=validateEditableCapsula(raw);
  if(!norm.ok)return json({ok:false,error:'invalid-capsula',errors:norm.errors},400);
  const c=norm.capsula;
  if(c.ref!==meta.externalRef || c.parentId!==id || c.version!==Math.max(1,Number(meta.capsuleSource?.version)||1))return json({error:'capsula-identity-mismatch'},409);
  if(previous) {
    // A text edit cannot replace the seed or its source identity.
    c.sourceGuion=previous.sourceGuion;c.origen=previous.origen;
    if(c.sourceGuion==null)delete c.sourceGuion;if(c.origen==null)delete c.origen;
  }
  c.updatedAt=new Date().toISOString();
  const ifMatch=req.headers.get('If-Match');
  if(stored && !ifMatch)return json({error:'draft-precondition-required',detail:'Recarga la fuente antes de guardar'},428);
  if(ifMatch && httpEtag(stored)!==ifMatch)return json({error:'draft-changed'},412);
  const onlyIf=stored?{etagMatches:stored.etag}:{etagDoesNotMatch:'*'};
  const written=await env.STOCK_BUCKET.put(key,JSON.stringify(c),{httpMetadata:{contentType:'application/json',cacheControl:'no-store'},onlyIf});
  if(written===null)return json({error:'draft-changed'},412);
  return json({ok:true,id,capsula:c},200,httpEtag(written)?{ETag:httpEtag(written)}:{});
}
export function capsulaLegacyGuion(c) {
  return { objeto: c.sourceGuion?.objeto || c.textos.titulo, subtitulo:c.textos.subtitulo||'', tema:c.saga.tema,
    cifra:c.sourceGuion?.capsulas?.[0]?.gancho?.cifra || {hasta:null,unidad:''},gancho:c.textos.gancho,giro:c.textos.giro,remate:c.textos.remate,fuente:c.textos.fuente.texto,idea:c.sourceGuion?.idea_clave||c.textos.remate };
}
export function capsulePreviewKey(ref, version, renderId, filename) {
  const m=CAPSULA_REF_RE.exec(String(ref||''));
  if(!m||!Number.isInteger(version)||version<1||version>99||!/^[a-zA-Z0-9-]{1,80}$/.test(String(renderId||''))||!/^[a-zA-Z0-9_-]{1,100}\.(png|mp4)$/.test(String(filename||'')))return null;
  return `capsula-url/previews/${m[1]}/v${version}/${renderId}/${filename}`;
}
