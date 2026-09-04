import test from "node:test";
import assert from "node:assert/strict";

// FLT pixeria stock (4-sep-2026): POST /stock/poster guarda el fotograma de un vídeo
// como stock/{id}/poster.jpg y lo deja de thumbnail en el meta y en el índice.
const worker = (await import("../src/index.js")).default;

function bucketFalso(objetos) {
  const store = new Map(Object.entries(objetos));
  return {
    puts: [],
    async get(k) { const v = store.get(k); return v == null ? null : { json: async () => JSON.parse(v), text: async () => v }; },
    async put(k, v, opts) { this.puts.push({ k, opts }); store.set(k, typeof v === 'string' ? v : `<bin ${v.length}>`); },
    async delete(k) { store.delete(k); },
    async list() { return { objects: [...store.keys()].map((key) => ({ key })), truncated: false }; },
    store,
  };
}
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(600, 1)]).toString('base64');
const post = (body) => new Request('https://api.admira.store/stock/poster', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ctx = { waitUntil: (p) => { ctx.pending = p; } };

test('sin clave → 401; con STOCK_POSTER_KEY guarda el póster y actualiza meta e índice', async () => {
  const bucket = bucketFalso({ 'stock/abc-1/meta.json': JSON.stringify({ id: 'abc-1', type: 'video', assetKey: 'stock/abc-1/asset.mp4', size: 5, createdAt: '2026-09-04T10:00:00Z', num: 7 }) });
  const env = { STOCK_BUCKET: bucket, STOCK_POSTER_KEY: 'poster-key' };
  const no = await worker.fetch(post({ id: 'abc-1', base64: jpeg, secret: 'mala' }), env, ctx);
  assert.equal(no.status, 401);
  const r = await worker.fetch(post({ id: 'abc-1', base64: jpeg, secret: 'poster-key', at: 1.2 }), env, ctx);
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.match(d.thumbnail, /^https:\/\/pub-[a-z0-9]+\.r2\.dev\/stock\/abc-1\/poster\.jpg\?v=603$/);
  const meta = JSON.parse(bucket.store.get('stock/abc-1/meta.json'));
  assert.equal(meta.thumbnail, d.thumbnail); assert.equal(meta.posterFrameAt, 1.2); assert.equal(meta.num, 7, 'el meta se conserva');
  const put = bucket.puts.find((p) => p.k === 'stock/abc-1/poster.jpg');
  assert.equal(put.opts.httpMetadata.contentType, 'image/jpeg');
  await ctx.pending; // rebuildStockIndex
  const idx = JSON.parse(bucket.store.get('stock/index.json'));
  assert.equal(idx.items[0].thumbnail, d.thumbnail);
});

test('id desconocido → 404; póster demasiado grande → 413', async () => {
  const bucket = bucketFalso({});
  const env = { STOCK_BUCKET: bucket, NOTIFY_KEY: 'n' };
  assert.equal((await worker.fetch(post({ id: 'nadie', base64: jpeg, secret: 'n' }), env, ctx)).status, 404);
  const grande = Buffer.alloc(401 * 1024, 1).toString('base64');
  assert.equal((await worker.fetch(post({ id: 'nadie', base64: grande, secret: 'n' }), env, ctx)).status, 413);
});
