import {timingSafeEqual} from 'node:crypto';
if(typeof crypto.subtle.timingSafeEqual!=='function')Object.defineProperty(crypto.subtle,'timingSafeEqual',{value:(a,b)=>timingSafeEqual(Buffer.from(a),Buffer.from(b))});
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { capsulaUrlRef, capsulaUrlJobKey, normalizeCapsulaGuion, capsulaUrlExisting, capsulaUrlStatus, capsulaUrlKind, capsulaUrlPrompt } from '../src/capsula-url.mjs';

function r2() {
  const m = new Map();
  return { m,
    async get(k) { if (!m.has(k)) return null; const v = m.get(k); return { etag: 'e', async json() { return JSON.parse(v); }, async text() { return v; } }; },
    async put(k, v, o = {}) { if (o.onlyIf?.etagDoesNotMatch === '*' && m.has(k)) return null; m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); return { etag: 'e' }; },
    async list({ prefix }) { return { objects: [...m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; },
    async delete(k) { m.delete(k); } };
}
const LI = 'https://www.linkedin.com/posts/adilovalber_we-turned-claude-opus-55-into-a-motion-design-ugcPost-7518757011845611520-J1pb/?utm_source=x';
const GUION = { objeto: 'Claude Opus 5.5 como estudio de motion design', subtitulo: '12 portátiles, un prompt', tema: 'tecnología', cifra: { hasta: 12, unidad: 'portátiles' }, gancho: 'un solo prompt para un vídeo de lanzamiento', giro: 'Claude repartió el trabajo entre 12 máquinas', remate: 'la IA ya dirige un estudio entero', fuente: 'Alber Adilov · LinkedIn', idea: 'Un agente coordina varias máquinas.' };
function mockFetch(t, calls) {
  t.mock.method(globalThis, 'fetch', async (u, init = {}) => {
    const url = String(u?.url || u); calls.push(url);
    if (url.startsWith('https://lnkd.in/')) return new Response(null, { status: 301, headers: { Location: LI } });
    if (url.startsWith('https://www.linkedin.com/')) return new Response('<html><head><meta property="og:title" content="We turned Claude Opus 5.5 into a motion design studio"><meta property="og:description" content="12 laptops and a single prompt for a music launch video."><meta property="og:image" content="https://dms.licdn.com/x.jpg"></head><body><main><p>12 laptops and a single prompt.</p></main></body></html>', { headers: { 'Content-Type': 'text/html' } });
    if (url.includes('generativelanguage.googleapis.com')) { assert.equal(init.headers['x-goog-api-key'], 'k'); return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...GUION, fuente: 'Alber Adilov · LinkedIn' }) }] } }] }); }
    return new Response('nope', { status: 404 });
  });
}
const env = () => ({ GEMINI_API_KEY: 'k', STOCK_BUCKET: r2() });
const post = (path, body, origin = 'https://www.admira.studio') => new Request('https://api.admira.store' + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('ref estable por origen y clave de cola segura', async () => {
  const a = await capsulaUrlRef('linkedin:7518757011845611520');
  assert.match(a, /^capsula-url:[a-f0-9]{16}$/);
  assert.equal(a, await capsulaUrlRef('linkedin:7518757011845611520'));
  assert.equal(capsulaUrlJobKey(a), 'capsula-url/jobs/' + a.slice(12) + '.json');
  assert.equal(capsulaUrlJobKey('../x'), null);
  assert.equal(capsulaUrlKind('youtube:abc'), 'youtube'); assert.equal(capsulaUrlKind('url:x.com/a'), 'articulo');
  assert.match(capsulaUrlPrompt({ kind: 'linkedin', url: 'u', title: 't', author: 'a', description: 'd', text: 'x' }), /gancho.*giro.*remate/s);
});

test('normaliza el guion: límites, cifra opcional y fuente con prefijo', () => {
  const n = normalizeCapsulaGuion({ ...GUION, cifra: { hasta: '17.000', unidad: 'tokens/s' }, fuente: 'Taalas', gancho: 'x'.repeat(300) });
  assert.equal(n.ok, true); assert.equal(n.guion.cifra.hasta, 17000); assert.equal(n.guion.fuente, 'Fuente: Taalas'); assert.equal(n.guion.gancho.length, 70);
  const s = normalizeCapsulaGuion({ ...GUION, cifra: { hasta: null, unidad: 'x' } }); assert.equal(s.guion.cifra.unidad, '');
  assert.deepEqual(normalizeCapsulaGuion({}).errors, ['missing_objeto', 'missing_gancho', 'missing_giro', 'missing_remate', 'missing_fuente']);
});

test('dedup: estado publicado solo con vertical y horizontal', () => {
  const ref = 'capsula-url:0123456789abcdef';
  const items = [{ type: 'video', externalRef: ref, tags: ['capsula', 'vertical'], id: 'v', num: 1 }, { type: 'video', externalRef: ref, tags: ['horizontal'], id: 'h', num: 2 }, { type: 'video', externalRef: 'otra', tags: ['vertical'] }];
  const e = capsulaUrlExisting(items, ref); assert.equal(e.vertical.id, 'v'); assert.equal(e.horizontal.num, 2);
  assert.equal(capsulaUrlStatus(null, e), 'publicada'); assert.equal(capsulaUrlStatus({ status: 'en-cola' }, { vertical: e.vertical }), 'parcial'); assert.equal(capsulaUrlStatus(null, {}), 'sin-encargo');
});

test('borrador desde lnkd.in: resuelve, extrae y redacta con Gemini sin publicar nada', async t => {
  const calls = []; mockFetch(t, calls); const e = env();
  assert.equal((await worker.fetch(post('/capsula/url/borrador', { url: 'https://lnkd.in/p/e9zXSPkK' }, 'https://evil.test'), e, { waitUntil() {} })).status, 403);
  const r = await worker.fetch(post('/capsula/url/borrador', { url: 'https://lnkd.in/p/e9zXSPkK' }), e, { waitUntil() {} });
  const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.source.sourceKey, 'linkedin:7518757011845611520'); assert.equal(d.source.kind, 'linkedin'); assert.equal(d.source.image, 'https://dms.licdn.com/x.jpg');
  assert.equal(d.guion.fuente, 'Fuente: Alber Adilov · LinkedIn'); assert.equal(d.status, 'sin-encargo'); assert.equal(e.STOCK_BUCKET.m.size, 0);
});

test('encargar: guion editado en cola una sola vez (dedup) y visible en la cola de GrokBotBox', async t => {
  const calls = []; mockFetch(t, calls); const e = env(); const ctx = { waitUntil() {} };
  const bad = await worker.fetch(post('/capsula/url/encargar', { url: 'https://lnkd.in/p/e9zXSPkK', guion: { objeto: 'x' } }), e, ctx); assert.equal(bad.status, 400);
  const a = await worker.fetch(post('/capsula/url/encargar', { url: 'https://lnkd.in/p/e9zXSPkK', guion: { ...GUION, giro: 'Editado por Carlos' } }), e, ctx);
  const da = await a.json(); assert.equal(a.status, 202); assert.equal(da.queued, true); assert.equal(da.status, 'en-cola');
  const b = await worker.fetch(post('/capsula/url/encargar', { url: LI, guion: GUION }), e, ctx); const db = await b.json();
  assert.equal(db.reused, true); assert.equal(db.ref, da.ref); assert.equal(e.STOCK_BUCKET.m.size, 1);
  const cola = await (await worker.fetch(new Request('https://api.admira.store/capsula/url/cola'), e, ctx)).json();
  assert.equal(cola.jobs.length, 1); assert.equal(cola.jobs[0].guion.giro, 'Editado por Carlos'); assert.deepEqual(cola.jobs[0].tags, ['capsula', 'sabiasque', 'tecnologia']);
  assert.equal(cola.jobs[0].source.resolvedUrl.includes('utm_'), false);
  const est = await (await worker.fetch(new Request('https://api.admira.store/capsula/url/estado?ref=' + da.ref), e, ctx)).json(); assert.equal(est.status, 'en-cola');
});

import { sanitizeCapsuleSource, capsulaSuperseded } from '../src/capsula-url.mjs';
test('v2: capsuleSource guarda fuente y tramo del b-roll, y una versión nueva oculta la anterior por orientación', () => {
  const ref = 'capsula-url:f2382b48829e119e';
  const cs = sanitizeCapsuleSource({ sourceUrl: 'https://lnkd.in/p/e9zXSPkK', credit: 'Vídeo: Alber Adilov', broll: { start: 5.05, end: 9.05 }, version: 2 }, ref);
  assert.deepEqual(cs, { sourceUrl: 'https://lnkd.in/p/e9zXSPkK', credit: 'Vídeo: Alber Adilov', broll: { start: 5.05, end: 9.05 }, version: 2, preroll: false, postroll: false });
  assert.equal(sanitizeCapsuleSource({ sourceUrl: 'javascript:alert(1)' }, ref), null);
  assert.equal(sanitizeCapsuleSource({ sourceUrl: 'https://x.com/a' }, 'otra-ref'), null);
  assert.equal(sanitizeCapsuleSource({ sourceUrl: 'https://x.com/a', broll: { start: 9, end: 5 } }, ref).broll, null);
  const items = [{ id: 'v1', type: 'video', externalRef: ref, tags: ['vertical'] }, { id: 'h1', type: 'video', externalRef: ref, tags: ['horizontal'] }, { id: 'o', type: 'video', externalRef: 'x', tags: ['vertical'] }];
  assert.deepEqual(capsulaSuperseded(items, { id: 'v2', externalRef: ref, tags: ['vertical'], capsuleSource: cs }), ['v1']);
  assert.deepEqual(capsulaSuperseded(items, { id: 'v2', externalRef: ref, tags: ['vertical'], capsuleSource: { ...cs, version: 1 } }), []);
  assert.equal(capsulaUrlExisting([...items, { id: 'v2', type: 'video', externalRef: ref, tags: ['vertical'], capsuleSource: cs }], ref, 2).vertical.id, 'v2');
  assert.equal(capsulaUrlExisting(items, ref, 2).vertical, undefined);
});
test('v2: rehacer encarga una versión nueva aunque la cápsula ya esté publicada', async t => {
  const calls = []; mockFetch(t, calls); const e = env(); const ctx = { waitUntil() {} };
  const a = await (await worker.fetch(post('/capsula/url/encargar', { url: 'https://lnkd.in/p/e9zXSPkK', guion: GUION }), e, ctx)).json();
  assert.equal(a.job.capsuleVersion, 1);
  const b = await (await worker.fetch(post('/capsula/url/encargar', { url: 'https://lnkd.in/p/e9zXSPkK', guion: GUION, rehacer: true }), e, ctx)).json();
  assert.equal(b.queued, true); assert.equal(b.job.capsuleVersion, 2);
  const cola = await (await worker.fetch(new Request('https://api.admira.store/capsula/url/cola'), e, ctx)).json();
  assert.equal(cola.jobs[0].capsuleVersion, 2);
});

import { normalizeCampanaBorrador, campanaUrlPrompt } from '../src/capsula-url.mjs';
test('modo campaña: el mismo borrador rellena marca, titular, CTA e imagen por proxy, sin escribir nada', async t => {
  const calls = []; const e = env();
  t.mock.method(globalThis, 'fetch', async (u, init = {}) => {
    const url = String(u?.url || u); calls.push(url);
    if (url.startsWith('https://lnkd.in/')) return new Response(null, { status: 301, headers: { Location: LI } });
    if (url.startsWith('https://www.linkedin.com/')) return new Response('<html><head><meta property="og:title" content="We turned Claude Opus 5.5 into a motion design studio"><meta property="og:image" content="https://dms.licdn.com/x.jpg"></head><body><main><p>12 laptops and a single prompt.</p></main></body></html>', { headers: { 'Content-Type': 'text/html' } });
    if (url.includes('generativelanguage')) { assert.match(JSON.parse(init.body).contents[0].parts[0].text, /titular/); return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ nombre: 'Claude Opus 5.5', titular: 'Un estudio de motion en un prompt.', cta: 'Descubre cómo.', etiqueta: 'Alber Adilov', idea: 'x' }) }] } }] }); }
    return new Response('no', { status: 404 });
  });
  const r = await worker.fetch(post('/capsula/url/borrador', { url: 'https://lnkd.in/p/e9zXSPkK', modo: 'campana' }), e, { waitUntil() {} });
  const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.modo, 'campana'); assert.equal(d.campana.titular, 'Un estudio de motion en un prompt'); assert.equal(d.campana.cta, 'Descubre cómo');
  assert.equal(d.imageProxy, 'https://api.admira.store/image/proxy?url=' + encodeURIComponent('https://dms.licdn.com/x.jpg'));
  assert.equal(d.guion, undefined); assert.equal(e.STOCK_BUCKET.m.size, 0);
  assert.deepEqual(normalizeCampanaBorrador({}).errors, ['missing_nombre', 'missing_titular', 'missing_cta']);
  assert.match(campanaUrlPrompt({ kind: 'x', url: 'u', title: '', author: '', description: '', text: '' }), /pantallas/);
});

test('v5.7: cartelas opcionales, apagadas por defecto, en el encargo y en capsuleSource', async () => {
  const ref = 'capsula-url:f2382b48829e119e';
  assert.deepEqual([sanitizeCapsuleSource({ sourceUrl: 'https://a.com/x', broll: { start: 0, end: 12 } }, ref).preroll, sanitizeCapsuleSource({ sourceUrl: 'https://a.com/x', postroll: true }, ref).postroll], [false, true]);
  const src = (await import('node:fs')).readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /cartelas: \{ preroll: op\.preroll, postroll: op\.postroll, cartela: op\.cartela \}/);
  const o = normalizeCapsulaGuion(GUION, {}).opciones; assert.deepEqual([o.preroll, o.postroll, o.cartela], [false, false, false]);
});

test('Director reads exact script; revisions preserve source and require authorization and compare-and-swap', async t => {
 const calls=[];mockFetch(t,calls);const e=env();e.NOTIFY_KEY='test-editor-key';const ctx={waitUntil(){}};
 const queued=await (await worker.fetch(post('/capsula/url/encargar',{url:LI,guion:GUION}),e,ctx)).json();
 const ref=queued.ref,key=capsulaUrlJobKey(ref),job=JSON.parse(e.STOCK_BUCKET.m.get(key));
 job.source.broll={start:2,end:10};e.STOCK_BUCKET.m.set(key,JSON.stringify(job));
 const endpoint='https://api.admira.store/capsula/url/director?ref='+ref;
 const original=await (await worker.fetch(new Request(endpoint),e,ctx)).json();
 assert.deepEqual(original.textPositions,{});assert.equal(original.textPositionRendering,false);assert.equal(original.guion.giro,GUION.giro);assert.equal(original.revision,'e');assert.equal(original.requestedBy,undefined);
 const save=(body,secret='test-editor-key')=>new Request(endpoint,{method:'POST',headers:{Origin:'https://ainimation.studio','Content-Type':'application/json','X-Notify-Key':secret},body:JSON.stringify(body)});
 const changed={revision:'e',guion:{...GUION,giro:'Texto cambiado por Carlos'},cartelas:{preroll:true,postroll:false}};
 const denied=await worker.fetch(save(changed,'wrong'),e,ctx);assert.equal(denied.status,401,await denied.text());
 assert.equal((await worker.fetch(save({...changed,revision:'old'}),e,ctx)).status,409);
 assert.equal((await worker.fetch(save(changed),e,ctx)).status,409); // rendering must finish first
 e.STOCK_BUCKET.m.set('stock/index.json',JSON.stringify({items:['vertical','horizontal'].map((o,i)=>({id:'published-'+i,type:'video',externalRef:ref,tags:[o],capsuleSource:{version:1}}))}));
 e.STOCK_BUCKET.m.set('capsula-url/editor/'+ref.slice(12)+'/v1/manifest.json',JSON.stringify({schema:'admira.capsule-preview.v1',ref,version:1,sourceVersion:1,sourceUrl:'https://stock.admira.store/source.mp4'}));
 changed.textPositions={horizontal:{heading:{x:-.1,y:.05},gancho:{x:.02,y:0}},vertical:{remate:{x:0,y:-.1}}};
 assert.equal((await worker.fetch(save(changed),e,ctx)).status,503);assert.equal(JSON.parse(e.STOCK_BUCKET.m.get(key)).capsuleVersion,1);
 assert.equal((await worker.fetch(save({...changed,textPositions:{horizontal:{heading:{x:2,y:0}}}}),e,ctx)).status,400);
 e.CAPSULE_TEXT_POSITIONS_RENDERER='admira.text-positions.v1';
 const response=await worker.fetch(save(changed),e,ctx);assert.equal(response.status,202,await response.clone().text());
 const next=JSON.parse(e.STOCK_BUCKET.m.get(key));assert.deepEqual(next.textPositions,changed.textPositions);const withLayout=await(await worker.fetch(new Request(endpoint),e,ctx)).json();assert.equal(withLayout.textPositionRendering,true);assert.deepEqual(withLayout.textPositions,changed.textPositions);assert.equal(next.guion.giro,'Texto cambiado por Carlos');assert.equal(next.capsuleVersion,2);assert.deepEqual(next.source,job.source);assert.equal(next.cartelas.preroll,true);const reused=JSON.parse(e.STOCK_BUCKET.m.get('capsula-url/editor/'+ref.slice(12)+'/v2/manifest.json'));assert.equal(reused.version,2);assert.equal(reused.sourceVersion,1);
 assert.ok([...e.STOCK_BUCKET.m.keys()].some(k=>k.startsWith('capsula-url/history/')));
 // Simulate an R2 conditional-write conflict after the revision was read.
 const published={items:['vertical','horizontal'].map((o,i)=>({id:'v2-'+i,type:'video',externalRef:ref,tags:[o],capsuleSource:{version:2}}))};e.STOCK_BUCKET.m.set('stock/index.json',JSON.stringify(published));
 const put=e.STOCK_BUCKET.put.bind(e.STOCK_BUCKET);e.STOCK_BUCKET.put=async(k,v,o)=>k===key&&o?.onlyIf?.etagMatches?null:put(k,v,o);
 assert.equal((await worker.fetch(save(changed),e,ctx)).status,409);
 assert.equal(JSON.parse(e.STOCK_BUCKET.m.get(key)).capsuleVersion,2);
});

test('clean preview media requires authorization, exact version and MP4; preserves original job', async t=>{
 const calls=[];mockFetch(t,calls);const e=env();e.NOTIFY_KEY='preview-key';const ctx={waitUntil(){}};
 const queued=await(await worker.fetch(post('/capsula/url/encargar',{url:LI,guion:GUION}),e,ctx)).json();const ref=queued.ref,key=capsulaUrlJobKey(ref),before=e.STOCK_BUCKET.m.get(key);
 const endpoint='https://api.admira.store/capsula/url/preview?ref='+ref+'&version=1';
 assert.equal((await worker.fetch(new Request(endpoint),e,ctx)).status,404);
 const bytes=new Uint8Array(64);bytes.set(new TextEncoder().encode('ftyp'),4);
 const put=(secret='preview-key',url=endpoint,body=bytes)=>new Request(url,{method:'PUT',headers:{Origin:'https://www.admira.studio','Content-Type':'video/mp4','X-Notify-Key':secret,'X-Capsule-Aspect':'0.5625'},body});
 assert.equal((await worker.fetch(put('wrong'),e,ctx)).status,401);
 assert.equal((await worker.fetch(put('preview-key',endpoint.replace('version=1','version=2')),e,ctx)).status,409);
 assert.equal((await worker.fetch(put('preview-key',endpoint,new Uint8Array(64)),e,ctx)).status,400);
 const response=await worker.fetch(put(),e,ctx);assert.equal(response.status,200);const manifest=await response.json();assert.equal(manifest.ref,ref);assert.equal(manifest.version,1);assert.match(manifest.sourceUrl,/\/v1\/[a-f0-9]{64}\.mp4$/);
 const saved=await(await worker.fetch(new Request(endpoint),e,ctx)).json();assert.equal(saved.sourceAspect,.5625);assert.equal(saved.schema,'admira.capsule-preview.v1');assert.equal(e.STOCK_BUCKET.m.get(key),before);
});

test('#capsula/#formato (31-oct-2026): encargar usa preroll/postroll/orientacion/idioma/subtitulos/formatos y auto-aprueba AdmiraXPBot', async t => {
  const calls = []; mockFetch(t, calls); const e = env(); const ctx = { waitUntil() {} };
  // Contrato de buildCapsulaEncargo (pixer-worker #51, Woz): #formato sobre un contenido horizontal.
  const r = await worker.fetch(post('/capsula/url/encargar', { url: 'https://lnkd.in/p/e9zXSPkK', guion: GUION, preroll: true, postroll: true, cartela: true,
    orientacion: 'horizontal', formatos: ['horizontal', 'vertical'], idioma: 'en', subtitulos: true, requestedBy: 'AdmiraXPBot', autoApprove: true, origen: 'telegram' }, 'https://admira.studio'), e, ctx);
  const d = await r.json(); assert.equal(r.status, 202, JSON.stringify(d));
  const job = JSON.parse([...e.STOCK_BUCKET.m.values()][0]);
  assert.deepEqual(job.cartelas, { preroll: true, postroll: true, cartela: true });
  assert.equal(job.orientacion, 'horizontal'); assert.deepEqual(job.formatos, ['horizontal', 'vertical']);
  assert.equal(job.idioma, 'en'); assert.equal(job.guion.idioma, 'en'); assert.equal(job.subtitulos, true);
  assert.equal(job.aprobado, true); assert.equal(job.approvedBy, 'AdmiraXPBot'); assert.equal(job.requestedBy, 'AdmiraXPBot');
  assert.deepEqual(d.job.formatos, ['horizontal', 'vertical']); assert.equal(d.job.aprobado, true);
  // #capsula solo: bot sin flags → cartelas por defecto activadas y una sola orientación (alias -v).
  const o = normalizeCapsulaGuion(GUION, { requestedBy: 'AdmiraXPBot', formatos: ['-v'] }).opciones;
  assert.deepEqual([o.preroll, o.postroll, o.cartela, o.orientacion, o.autoApprove], [true, true, true, 'vertical', true]); assert.deepEqual(o.formatos, ['vertical']);
  // Creador: sin cambios (apagadas, ambas orientaciones, sin auto-aprobación).
  const c = normalizeCapsulaGuion(GUION, {}).opciones; assert.deepEqual(c.formatos, ['vertical', 'horizontal']); assert.equal(c.autoApprove, false);
  // Publicada cuando existen las orientaciones pedidas (no siempre las dos).
  assert.equal(capsulaUrlStatus({ formatos: ['vertical'] }, { vertical: { id: 'v' } }), 'publicada');
  assert.equal(capsulaUrlStatus({ formatos: ['vertical', 'horizontal'] }, { vertical: { id: 'v' } }), 'parcial');
});
