import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Yokup #3199 (12-sep-2026): póster representativo y validación de vídeos.
// Endpoints: GET /stock/poster/<id>, POST /stock/poster con X-Notify-Key y
// data URL, PATCH /stock/<id>/meta {oculto, validacion}, /stock/list sin
// ocultos y /stock/exists con poster/validacion.
// crypto.subtle.timingSafeEqual solo existe en Workers: en node --test se
// suple con una comparación constante equivalente (lo usa stockIngestAuthorized).
if (typeof crypto.subtle.timingSafeEqual !== 'function') {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: (a, b) => {
      const x = new Uint8Array(a), y = new Uint8Array(b);
      if (x.length !== y.length) return false;
      let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
      return d === 0;
    },
  });
}
const worker = (await import('../src/index.js')).default;

function bucketFalso(objetos) {
  const store = new Map(Object.entries(objetos));
  return {
    puts: [],
    async get(k) {
      const v = store.get(k);
      if (v == null) return null;
      const bin = v instanceof Uint8Array;
      return {
        json: async () => JSON.parse(v), text: async () => v,
        body: bin ? v : null, size: bin ? v.length : String(v).length,
        writeHttpMetadata() {},
      };
    },
    async put(k, v, opts) { this.puts.push({ k, opts }); store.set(k, typeof v === 'string' ? v : new Uint8Array(v)); },
    async delete(k) { store.delete(k); },
    async list() { return { objects: [...store.keys()].map((key) => ({ key })), truncated: false }; },
    store,
  };
}
const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]);
const jpegDataUrl = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`;
const ctx = { waitUntil: (p) => { ctx.pending = p; } };
const meta = (extra = {}) => JSON.stringify({ id: 'v-1', type: 'video', assetKey: 'stock/v-1/asset.webm', mime: 'video/webm', size: 5, createdAt: '2026-09-11T18:14:54Z', num: 9, tags: ['tiktok'], ...extra });

test('GET /stock/poster/<id>: 404 sin póster; tras POST /stock/poster (X-Notify-Key + data URL + validacion) sirve image/jpeg con caché 1 día y CORS *', async () => {
  const bucket = bucketFalso({ 'stock/v-1/meta.json': meta() });
  const env = { STOCK_BUCKET: bucket, NOTIFY_KEY: 'clave' };
  const sin = await worker.fetch(new Request('https://api.admira.store/stock/poster/v-1'), env, ctx);
  assert.equal(sin.status, 404);

  const r = await worker.fetch(new Request('https://api.admira.store/stock/poster', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Notify-Key': 'clave' },
    body: JSON.stringify({ id: 'v-1', poster: jpegDataUrl, at: 4.46, validacion: { ok: true, negros: 1, muestras: 13, duracion: 15, por: 'ffmpeg' } }),
  }), env, ctx);
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.poster, 'https://api.admira.store/stock/poster/v-1');
  assert.match(d.thumbnail, /^https:\/\/stock\.admira\.store\/stock\/v-1\/poster\.jpg\?v=604$/);
  assert.equal(d.validacion.ok, true); assert.equal(d.validacion.por, 'ffmpeg');
  const m = JSON.parse(bucket.store.get('stock/v-1/meta.json'));
  assert.equal(m.poster, d.poster); assert.equal(m.posterFrameAt, 4.46); assert.equal(m.num, 9);
  await ctx.pending;

  const img = await worker.fetch(new Request('https://api.admira.store/stock/poster/v-1', { headers: { origin: 'https://admira.tv' } }), env, ctx);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(img.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(img.headers.get('access-control-allow-origin'), '*');
  assert.equal(new Uint8Array(await img.arrayBuffer()).length, 604);
  // El índice público lleva poster y thumbnail.
  const idx = JSON.parse(bucket.store.get('stock/index.json'));
  assert.equal(idx.items[0].poster, 'https://api.admira.store/stock/poster/v-1');
  assert.equal(idx.items[0].thumbnail, d.thumbnail);
});

test('POST /stock/poster: clave mala → 401; sin póster ni validación → 400; base64 legado sigue valiendo', async () => {
  const bucket = bucketFalso({ 'stock/v-1/meta.json': meta() });
  const env = { STOCK_BUCKET: bucket, NOTIFY_KEY: 'clave' };
  const post = (body, headers = {}) => worker.fetch(new Request('https://api.admira.store/stock/poster', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, ctx);
  assert.equal((await post({ id: 'v-1', poster: jpegDataUrl }, { 'X-Notify-Key': 'mala' })).status, 401);
  assert.equal((await post({ id: 'v-1', poster: jpegDataUrl })).status, 401, 'sin clave en ningún sitio');
  assert.equal((await post({ id: 'v-1', secret: 'clave' })).status, 400);
  const legado = await post({ id: 'v-1', secret: 'clave', base64: jpegBytes.toString('base64'), mime: 'image/jpeg' });
  assert.equal(legado.status, 200);
  assert.equal((await legado.json()).size, 604);
});

test('PATCH /stock/<id>/meta {oculto:true, validacion:{ok:false,…}} y /stock/list lo deja fuera salvo ?ocultos=1', async () => {
  const bucket = bucketFalso({
    'stock/v-1/meta.json': meta(),
    'stock/v-2/meta.json': meta({ id: 'v-2', assetKey: 'stock/v-2/asset.webm', createdAt: '2026-09-11T18:25:26Z', num: 10 }),
  });
  const env = { STOCK_BUCKET: bucket, NOTIFY_KEY: 'clave' };
  const r = await worker.fetch(new Request('https://api.admira.store/stock/v-1/meta', {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Notify-Key': 'clave' },
    body: JSON.stringify({ oculto: true, validacion: { ok: false, negros: 12, muestras: 12, motivo: 'Vídeo inválido: 12/12 fotogramas negros', por: 'ffmpeg' } }),
  }), env, ctx);
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.changed, true); assert.equal(d.oculto, true); assert.equal(d.validacion.ok, false);
  const m = JSON.parse(bucket.store.get('stock/v-1/meta.json'));
  assert.equal(m.oculto, true); assert.equal(m.validacion.motivo, 'Vídeo inválido: 12/12 fotogramas negros');
  assert.deepEqual(m.tags, ['tiktok'], 'las etiquetas no se tocan');
  try { await ctx.pending; } catch { /* la sincronía con la parrilla no está en este test */ }

  const lista = await (await worker.fetch(new Request('https://api.admira.store/stock/list?type=video'), env, ctx)).json();
  assert.deepEqual(lista.items.map((i) => i.id), ['v-2']);
  const todos = await (await worker.fetch(new Request('https://api.admira.store/stock/list?type=video&ocultos=1'), env, ctx)).json();
  assert.deepEqual(todos.items.map((i) => i.id).sort(), ['v-1', 'v-2']);
  assert.equal(todos.items.find((i) => i.id === 'v-1').poster, null);

  // Volver a enseñarla: oculto:false y validacion:null.
  const r2 = await worker.fetch(new Request('https://api.admira.store/stock/v-1/meta', {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Notify-Key': 'clave' }, body: JSON.stringify({ oculto: false, validacion: null }),
  }), env, ctx);
  assert.equal((await r2.json()).oculto, false);
  const m2 = JSON.parse(bucket.store.get('stock/v-1/meta.json'));
  assert.equal('oculto' in m2, false); assert.equal('validacion' in m2, false);
  // validacion que no es objeto → 400
  const mal = await worker.fetch(new Request('https://api.admira.store/stock/v-1/meta', {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Notify-Key': 'clave' }, body: JSON.stringify({ validacion: 'ok' }),
  }), env, ctx);
  assert.equal(mal.status, 400);
});

test('GET /stock/exists?externalId= devuelve poster, thumbnail, validacion y oculto', async () => {
  const externalId = 'admiranext:catalogo:alcampo-2026-09-10:langostino-cocido';
  const id = `auto-${createHash('sha256').update(externalId).digest('hex').slice(0, 20)}`;
  const bucket = bucketFalso({
    [`stock/${id}/meta.json`]: meta({ id, externalRef: id, assetKey: `stock/${id}/asset.webm`, thumbnail: `https://stock.admira.store/stock/${id}/poster.jpg?v=604`, validacion: { ok: true, negros: 1, muestras: 13 } }),
  });
  const env = { STOCK_BUCKET: bucket };
  const r = await worker.fetch(new Request(`https://api.admira.store/stock/exists?externalId=${encodeURIComponent(externalId)}`), env, ctx);
  const d = await r.json();
  assert.equal(d.exists, true, JSON.stringify(d));
  assert.equal(d.poster, `https://api.admira.store/stock/poster/${id}`);
  assert.match(d.thumbnail, /poster\.jpg\?v=604$/);
  assert.equal(d.validacion.ok, true);
  assert.equal(d.oculto, false);
});
