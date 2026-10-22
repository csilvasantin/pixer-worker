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
