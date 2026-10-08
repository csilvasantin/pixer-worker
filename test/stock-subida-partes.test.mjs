import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Subida por partes al Stock (8-oct-2026 · SubMorfeoMacMini). El Adaptador de
// Pixeria mandaba MP4 de ~70 MB en base64 dentro de un JSON y el isolate pasaba
// de 128 MB (503 «Worker exceeded resource limits»). La vía buena es la que ya
// existía: /stock/upload/init → part → complete y /stock/publish con r2Staged.
// Aquí se fija su contrato: trozos en streaming (nunca arrayBuffer/text del
// cuerpo), tamaño anunciado comprobado al cerrar, abort, limpieza de uploads/ y
// que la entrada del Stock sale IGUAL que con base64.

// Piezas del runtime de Workers que node no trae. Este fichero corre en su
// propio proceso (node --test aísla cada fichero), así que no contaminan a otros.
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
class FixedLengthStream extends TransformStream {
  constructor(length) {
    let visto = 0;
    super({
      transform(chunk, ctl) { visto += chunk.byteLength; if (visto > length) throw new Error('FixedLengthStream: sobran bytes'); ctl.enqueue(chunk); },
      flush() { if (visto !== length) throw new Error('FixedLengthStream: faltan bytes'); },
    });
    this.expectedLength = length;
  }
}
globalThis.FixedLengthStream = FixedLengthStream;
class DigestStream extends WritableStream {
  constructor() {
    const h = createHash('sha256');
    let listo; const digest = new Promise((r) => { listo = r; });
    super({ write(c) { h.update(c); }, close() { const b = h.digest(); listo(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); } });
    this.digest = digest;
  }
}
Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: DigestStream });

const { default: worker, stockStagingSweep } = await import('../src/index.js');

async function leerTodo(v) {
  if (v == null) return new Uint8Array(0);
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const trozos = []; let n = 0;
  for await (const c of v) { trozos.push(c); n += c.byteLength; }
  const out = new Uint8Array(n); let o = 0;
  for (const c of trozos) { out.set(c, o); o += c.byteLength; }
  return out;
}

// R2 falso con multipart: guarda bytes, httpMetadata, customMetadata y fecha.
function bucketFalso() {
  const store = new Map();
  const subidas = new Map();
  let seq = 0;
  const objeto = (key, e) => ({
    key, size: e.bytes.length, httpMetadata: e.httpMetadata || {}, customMetadata: e.customMetadata || {}, uploaded: e.uploaded,
    get body() { return new Blob([e.bytes]).stream(); },
    json: async () => JSON.parse(new TextDecoder().decode(e.bytes)),
    text: async () => new TextDecoder().decode(e.bytes),
    arrayBuffer: async () => e.bytes.slice().buffer,
    writeHttpMetadata(h) { if (e.httpMetadata && e.httpMetadata.contentType) h.set('content-type', e.httpMetadata.contentType); },
  });
  const b = {
    store, subidas, recibidos: [],
    async get(k) { const e = store.get(k); return e ? objeto(k, e) : null; },
    async head(k) { const e = store.get(k); return e ? objeto(k, e) : null; },
    async put(k, v, opts = {}) {
      const bytes = await leerTodo(v);
      store.set(k, { bytes, httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata, uploaded: new Date() });
      return objeto(k, store.get(k));
    },
    async delete(k) { for (const x of [].concat(k)) store.delete(x); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
      const desde = cursor ? Number(cursor) : 0;
      const pagina = keys.slice(desde, desde + limit);
      const truncated = desde + limit < keys.length;
      return { objects: pagina.map(k => objeto(k, store.get(k))), truncated, cursor: truncated ? String(desde + limit) : undefined };
    },
    async createMultipartUpload(key, opts = {}) {
      const uploadId = 'up-' + (++seq);
      subidas.set(uploadId, { key, opts, partes: new Map() });
      return b.resumeMultipartUpload(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        key, uploadId,
        async uploadPart(n, body) {
          const s = subidas.get(uploadId);
          if (!s || s.key !== key) throw new Error('NoSuchUpload');
          b.recibidos.push({ n, body });
          const bytes = await leerTodo(body);
          const etag = 'etag-' + n + '-' + bytes.length;
          s.partes.set(n, { bytes, etag });
          return { partNumber: n, etag };
        },
        async complete(parts) {
          const s = subidas.get(uploadId);
          if (!s || s.key !== key) throw new Error('NoSuchUpload');
          const trozos = parts.map(p => {
            const x = s.partes.get(p.partNumber);
            if (!x || x.etag !== p.etag) throw new Error('InvalidPart');
            return x.bytes;
          });
          const total = trozos.reduce((a, t) => a + t.length, 0);
          const bytes = new Uint8Array(total); let o = 0;
          for (const t of trozos) { bytes.set(t, o); o += t.length; }
          subidas.delete(uploadId);
          store.set(key, { bytes, httpMetadata: s.opts.httpMetadata, customMetadata: s.opts.customMetadata, uploaded: new Date() });
          return objeto(key, store.get(key));
        },
        async abort() {
          if (!subidas.has(uploadId)) throw new Error('NoSuchUpload');
          subidas.delete(uploadId);
        },
      };
    },
  };
  return b;
}

function entorno() {
  const pendientes = [];
  const ctx = { waitUntil: (p) => { pendientes.push(Promise.resolve(p).catch(() => {})); } };
  const env = { STOCK_BUCKET: bucketFalso() };
  const drenar = async () => { while (pendientes.length) await pendientes.shift(); };
  return { env, ctx, drenar };
}

const API = 'https://api.admira.store';
const postJSON = (path, body) => new Request(API + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://www.pixeria.com' }, body: JSON.stringify(body),
});
// Petición de trozo con cuerpo en STREAM y espías: si el handler lo leyera a
// memoria (arrayBuffer/text/json/blob/formData), el test lo detecta.
function peticionTrozo(qs, bytes, { contentLength = bytes.length, metodo = 'PUT' } = {}) {
  const stream = new Blob([bytes]).stream();
  const headers = { 'Content-Type': 'application/octet-stream', Origin: 'https://www.pixeria.com' };
  if (contentLength != null) headers['Content-Length'] = String(contentLength);
  const req = new Request(`${API}/stock/upload/part?${new URLSearchParams(qs)}`, { method: metodo, headers, body: stream, duplex: 'half' });
  const lecturas = [];
  for (const m of ['arrayBuffer', 'text', 'json', 'blob', 'formData', 'bytes', 'clone']) {
    Object.defineProperty(req, m, { configurable: true, value: () => { lecturas.push(m); throw new Error(`el trozo no se lee con ${m}()`); } });
  }
  return { req, stream, lecturas };
}

const PARTE = 25 * 1024 * 1024;
function bytesDePrueba(n, semilla = 7) {
  const b = new Uint8Array(n);
  let x = semilla;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}

async function subirPorPartes(env, ctx, bytes, { mime = 'video/mp4', declarar = bytes.length } = {}) {
  const ini = await (await worker.fetch(postJSON('/stock/upload/init', { mime, size: declarar }), env, ctx)).json();
  assert.equal(ini.ok, true, JSON.stringify(ini));
  const parts = [];
  for (let n = 1, off = 0; off < bytes.length; n++, off += ini.partSize) {
    const { req, lecturas } = peticionTrozo({ key: ini.key, uploadId: ini.uploadId, n }, bytes.subarray(off, Math.min(off + ini.partSize, bytes.length)));
    const r = await worker.fetch(req, env, ctx);
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d));
    assert.deepEqual(lecturas, []);
    parts.push({ partNumber: d.partNumber, etag: d.etag });
  }
  const cr = await worker.fetch(postJSON('/stock/upload/complete', { key: ini.key, uploadId: ini.uploadId, parts }), env, ctx);
  return { ini, parts, cr, cd: await cr.json() };
}

test('init: devuelve key de uploads/, uploadId y partSize de 25 MB; guarda el tamaño anunciado; valida size', async () => {
  const { env, ctx } = entorno();
  const r = await worker.fetch(postJSON('/stock/upload/init', { mime: 'video/mp4', size: 70 * 1024 * 1024 }), env, ctx);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.match(d.key, /^uploads\/[a-z0-9-]{6,64}\.mp4$/);
  assert.ok(d.uploadId);
  assert.equal(d.partSize, PARTE);
  assert.equal(d.maxParts, 400);
  const s = env.STOCK_BUCKET.subidas.get(d.uploadId);
  assert.equal(s.opts.httpMetadata.contentType, 'video/mp4');
  assert.deepEqual(s.opts.customMetadata, { declaredSize: String(70 * 1024 * 1024) });
  // CORS de la casa, igual que /stock/publish.
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://www.pixeria.com');

  for (const size of [-1, 'abc', 1.5]) {
    const m = await worker.fetch(postJSON('/stock/upload/init', { mime: 'video/mp4', size }), env, ctx);
    assert.equal(m.status, 400, String(size));
    assert.equal((await m.json()).error, 'bad-size');
  }
  const grande = await worker.fetch(postJSON('/stock/upload/init', { mime: 'video/mp4', size: 3 * 1024 * 1024 * 1024 }), env, ctx);
  assert.equal(grande.status, 413);
  // Sin size (clientes antiguos): se admite y no se anota tamaño.
  const sin = await (await worker.fetch(postJSON('/stock/upload/init', { mime: 'video/mp4' }), env, ctx)).json();
  assert.equal(sin.ok, true);
  assert.equal(env.STOCK_BUCKET.subidas.get(sin.uploadId).opts.customMetadata, undefined);
});

test('part: el cuerpo pasa a R2 como stream, sin leerlo a memoria (PUT y POST); claves y números fuera de rango → 400; trozo > 25 MB → 413', async () => {
  const { env, ctx } = entorno();
  const ini = await (await worker.fetch(postJSON('/stock/upload/init', { mime: 'video/mp4', size: 3000 }), env, ctx)).json();
  for (const [n, metodo] of [[1, 'PUT'], [2, 'POST']]) {
    const { req, stream, lecturas } = peticionTrozo({ key: ini.key, uploadId: ini.uploadId, n }, bytesDePrueba(1500, n), { metodo });
    const r = await worker.fetch(req, env, ctx);
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d));
    assert.equal(d.partNumber, n);
    assert.match(d.etag, /^etag-/);
    assert.deepEqual(lecturas, [], 'el handler no debe leer el trozo a memoria');
    const recibido = env.STOCK_BUCKET.recibidos.at(-1);
    assert.equal(recibido.n, n);
    assert.ok(recibido.body instanceof ReadableStream, 'uploadPart recibe un ReadableStream');
    assert.equal(recibido.body, stream, 'y es el MISMO stream de la petición, sin copias');
  }

  const malas = [
    [{ key: 'stock/123/asset.mp4', uploadId: ini.uploadId, n: 1 }, 400, 'bad-key'],
    [{ key: ini.key, uploadId: '', n: 1 }, 400, 'bad-key'],
    [{ key: ini.key, uploadId: ini.uploadId, n: 0 }, 400, 'bad-part'],
    [{ key: ini.key, uploadId: ini.uploadId, n: 401 }, 400, 'bad-part'],
  ];
  for (const [qs, status, error] of malas) {
    const { req, lecturas } = peticionTrozo(qs, bytesDePrueba(10));
    const r = await worker.fetch(req, env, ctx);
    assert.equal(r.status, status, JSON.stringify(qs));
    assert.equal((await r.json()).error, error);
    assert.deepEqual(lecturas, []);
  }
  const { req: gordo, lecturas } = peticionTrozo({ key: ini.key, uploadId: ini.uploadId, n: 3 }, bytesDePrueba(10), { contentLength: PARTE + 1 });
  const r = await worker.fetch(gordo, env, ctx);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'part-too-big');
  assert.deepEqual(lecturas, []);
});

test('complete: ensambla y comprueba el tamaño anunciado; si no cuadra → 400 size-mismatch y no queda fichero', async () => {
  const { env, ctx } = entorno();
  const bytes = bytesDePrueba(4000);
  const bien = await subirPorPartes(env, ctx, bytes);
  assert.equal(bien.cr.status, 200, JSON.stringify(bien.cd));
  assert.deepEqual(bien.cd, { ok: true, key: bien.ini.key, size: 4000 });
  assert.deepEqual(env.STOCK_BUCKET.store.get(bien.ini.key).bytes, bytes);

  const mal = await subirPorPartes(env, ctx, bytes, { declarar: 4001 });
  assert.equal(mal.cr.status, 400);
  assert.deepEqual(mal.cd, { error: 'size-mismatch', declared: 4001, size: 4000 });
  assert.equal(env.STOCK_BUCKET.store.has(mal.ini.key), false, 'el fichero que no cuadra se borra');

  // Partes mal formadas o fuera de uploads/.
  for (const body of [
    { key: bien.ini.key, uploadId: 'x', parts: [] },
    { key: bien.ini.key, uploadId: 'x', parts: [{ partNumber: 1 }] },
    { key: 'stock/a/asset.mp4', uploadId: 'x', parts: [{ partNumber: 1, etag: 'e' }] },
  ]) {
    const r = await worker.fetch(postJSON('/stock/upload/complete', body), env, ctx);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('complete sin customMetadata en la respuesta de R2: el tamaño se mira con head', async () => {
  const { env, ctx } = entorno();
  const ini = await (await worker.fetch(postJSON('/stock/upload/init', { mime: 'video/mp4', size: 99 }), env, ctx)).json();
  const { req } = peticionTrozo({ key: ini.key, uploadId: ini.uploadId, n: 1 }, bytesDePrueba(100));
  const p = await (await worker.fetch(req, env, ctx)).json();
  const resume = env.STOCK_BUCKET.resumeMultipartUpload.bind(env.STOCK_BUCKET);
  env.STOCK_BUCKET.resumeMultipartUpload = (k, u) => {
    const up = resume(k, u);
    return { ...up, complete: async (parts) => { const o = await up.complete(parts); return { size: o.size }; } };
  };
  const r = await worker.fetch(postJSON('/stock/upload/complete', { key: ini.key, uploadId: ini.uploadId, parts: [p] }), env, ctx);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'size-mismatch');
});

test('abort: la subida a medias desaparece; abortar dos veces no falla; clave ajena → 400', async () => {
  const { env, ctx } = entorno();
  const ini = await (await worker.fetch(postJSON('/stock/upload/init', { mime: 'video/mp4', size: 100 }), env, ctx)).json();
  const { req } = peticionTrozo({ key: ini.key, uploadId: ini.uploadId, n: 1 }, bytesDePrueba(50));
  await worker.fetch(req, env, ctx);
  assert.equal(env.STOCK_BUCKET.subidas.has(ini.uploadId), true);
  for (let i = 0; i < 2; i++) {
    const r = await worker.fetch(postJSON('/stock/upload/abort', { key: ini.key, uploadId: ini.uploadId }), env, ctx);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, aborted: true });
  }
  assert.equal(env.STOCK_BUCKET.subidas.has(ini.uploadId), false);
  assert.equal(env.STOCK_BUCKET.store.has(ini.key), false);
  const r = await worker.fetch(postJSON('/stock/upload/abort', { key: 'stock/x/meta.json', uploadId: 'u' }), env, ctx);
  assert.equal(r.status, 400);
});

// Lo que el Adaptador manda al publicar (adaptaciones/stock-publish.mjs → stockPayload).
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 3)]);
const metaAdaptador = {
  type: 'video', motor: 'adaptador', mime: 'video/mp4', quality: 'good',
  title: 'Spot · Altadis · 9:16',
  prompt: 'Adaptación · origen 123-abc · formato 9:16 · 1080×1920',
  tags: ['adaptación', '9:16', 'altadis', 'estanco-bcn-001'],
  comment: 'Estanco 001 · pantalla 1',
  externalRef: '123-abc',
  validacion: { ok: true, ancho: 1080, alto: 1920, duracion: 30, por: 'adaptador' },
  dimensions: { width: 1080, height: 1920 },
  costEst: 'adaptador · 0.06MB',
  poster: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
};
// Lo que depende del momento o del id aleatorio no puede coincidir; lo demás sí.
// Fuera: el id y las marcas de tiempo (createdAt, validacion.at…).
function normalizar(obj, id) {
  return JSON.parse(JSON.stringify(obj).split(id).join('<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<fecha>'));
}

test('publish con r2Staged deja en el Stock EXACTAMENTE la misma entrada (meta, índice, binario, póster) que el base64 de los mismos bytes; uploads/ queda vacío', async () => {
  const bytes = bytesDePrueba(60 * 1024 + 17, 11);
  // Carril de siempre: base64 en el JSON.
  const A = entorno();
  const ra = await worker.fetch(postJSON('/stock/publish', { ...metaAdaptador, base64: Buffer.from(bytes).toString('base64') }), A.env, A.ctx);
  const da = await ra.json();
  assert.equal(ra.status, 200, JSON.stringify(da));
  await A.drenar();
  // Carril por partes: init → part → complete → publish {r2Staged}.
  const B = entorno();
  const up = await subirPorPartes(B.env, B.ctx, bytes);
  assert.equal(up.cr.status, 200, JSON.stringify(up.cd));
  const rb = await worker.fetch(postJSON('/stock/publish', { ...metaAdaptador, r2Staged: up.ini.key }), B.env, B.ctx);
  const db = await rb.json();
  assert.equal(rb.status, 200, JSON.stringify(db));
  await B.drenar();

  // Respuesta del publish.
  assert.deepEqual(normalizar(db, db.id), normalizar(da, da.id));
  assert.equal(db.contentHash, createHash('sha256').update(bytes).digest('hex'));
  // meta.json
  const metaA = JSON.parse(new TextDecoder().decode(A.env.STOCK_BUCKET.store.get(`stock/${da.id}/meta.json`).bytes));
  const metaB = JSON.parse(new TextDecoder().decode(B.env.STOCK_BUCKET.store.get(`stock/${db.id}/meta.json`).bytes));
  assert.deepEqual(normalizar(metaB, db.id), normalizar(metaA, da.id));
  assert.equal(metaB.assetKey, `stock/${db.id}/asset.mp4`);
  assert.equal(metaB.size, bytes.length);
  assert.equal(metaB.externalRef, '123-abc');
  assert.equal(metaB.validacion.por, 'adaptador');
  assert.equal(metaB.validacion.ancho, 1080);
  // Binario, cabeceras y póster.
  const assetA = A.env.STOCK_BUCKET.store.get(`stock/${da.id}/asset.mp4`);
  const assetB = B.env.STOCK_BUCKET.store.get(`stock/${db.id}/asset.mp4`);
  assert.deepEqual(assetB.bytes, bytes);
  assert.deepEqual(assetB.httpMetadata, assetA.httpMetadata);
  assert.deepEqual(normalizar(assetB.customMetadata, db.id), normalizar(assetA.customMetadata, da.id));
  assert.deepEqual(B.env.STOCK_BUCKET.store.get(`stock/${db.id}/poster.jpg`).bytes, A.env.STOCK_BUCKET.store.get(`stock/${da.id}/poster.jpg`).bytes);
  // Índice público.
  const idxA = JSON.parse(new TextDecoder().decode(A.env.STOCK_BUCKET.store.get('stock/index.json').bytes));
  const idxB = JSON.parse(new TextDecoder().decode(B.env.STOCK_BUCKET.store.get('stock/index.json').bytes));
  assert.equal(idxB.items.length, 1);
  assert.deepEqual(normalizar(idxB.items[0], db.id), normalizar(idxA.items[0], da.id));
  // La copia de uploads/ ya no está.
  assert.deepEqual([...B.env.STOCK_BUCKET.store.keys()].filter(k => k.startsWith('uploads/')), []);
});

test('publish con r2Staged: un duplicado por contentHash responde reused y también limpia uploads/', async () => {
  const { env, ctx, drenar } = entorno();
  const bytes = bytesDePrueba(5000, 3);
  const primero = await (await worker.fetch(postJSON('/stock/publish', { ...metaAdaptador, base64: Buffer.from(bytes).toString('base64') }), env, ctx)).json();
  await drenar();
  const up = await subirPorPartes(env, ctx, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const r = await (await worker.fetch(postJSON('/stock/publish', { ...metaAdaptador, r2Staged: up.ini.key, contentHash: hash }), env, ctx)).json();
  await drenar();
  assert.equal(r.reused, true);
  assert.equal(r.id, primero.id);
  assert.equal(env.STOCK_BUCKET.store.has(up.ini.key), false);
});

test('/stock/publish base64 de siempre no cambia: sin r2Staged funciona; r2Staged fuera de uploads/ → 400; externalId sin secreto → 401', async () => {
  const { env, ctx, drenar } = entorno();
  const ok = await worker.fetch(postJSON('/stock/publish', { type: 'video', motor: 'adaptador', mime: 'video/mp4', base64: Buffer.from('mp4-pequeno').toString('base64') }), env, ctx);
  assert.equal(ok.status, 200);
  await drenar();
  const mala = await worker.fetch(postJSON('/stock/publish', { type: 'video', motor: 'adaptador', mime: 'video/mp4', r2Staged: 'stock/otro/asset.mp4' }), env, ctx);
  assert.equal(mala.status, 400);
  assert.equal((await mala.json()).error, 'bad-staged-key');
  const ext = await worker.fetch(postJSON('/stock/publish', { type: 'video', motor: 'adaptador', mime: 'video/mp4', base64: 'AAAA', externalId: 'admiranext:catalogo:abcdefgh' }), env, ctx);
  assert.equal(ext.status, 401);
  const nada = await worker.fetch(postJSON('/stock/publish', { type: 'video', motor: 'adaptador', mime: 'video/mp4' }), env, ctx);
  assert.equal(nada.status, 400);
  assert.equal((await nada.json()).error, 'missing-base64-or-sourceUrl');
});

test('barrido: borra de uploads/ lo que lleva más de 24 h y respeta lo reciente y lo publicado', async () => {
  const { env } = entorno();
  const b = env.STOCK_BUCKET;
  const ahora = Date.parse('2026-10-08T12:00:00Z');
  await b.put('uploads/viejo-aaaaaa.mp4', 'x'); b.store.get('uploads/viejo-aaaaaa.mp4').uploaded = new Date(ahora - 25 * 3600e3);
  await b.put('uploads/nuevo-bbbbbb.mp4', 'x'); b.store.get('uploads/nuevo-bbbbbb.mp4').uploaded = new Date(ahora - 3600e3);
  await b.put('stock/1/asset.mp4', 'x'); b.store.get('stock/1/asset.mp4').uploaded = new Date(ahora - 90 * 24 * 3600e3);
  const r = await stockStagingSweep(env, ahora);
  assert.deepEqual(r, { deleted: 1 });
  assert.deepEqual([...b.store.keys()].sort(), ['stock/1/asset.mp4', 'uploads/nuevo-bbbbbb.mp4']);
});

test('el cron de cada 10 min lanza el barrido de uploads/', async () => {
  const { env } = entorno();
  await env.STOCK_BUCKET.put('uploads/viejo-cccccc.mp4', 'x');
  env.STOCK_BUCKET.store.get('uploads/viejo-cccccc.mp4').uploaded = new Date(Date.now() - 48 * 3600e3);
  const pendientes = [];
  await worker.scheduled({ cron: '*/10 * * * *' }, env, { waitUntil: (p) => pendientes.push(Promise.resolve(p).catch(() => {})) });
  await Promise.all(pendientes);
  assert.equal(env.STOCK_BUCKET.store.has('uploads/viejo-cccccc.mp4'), false);
});
