import { r2Conditions } from './helpers/r2-conditions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

// 15-nov-2026: /stock/list sin filtros sale de stock/index.json (un objeto) en vez de
// recorrer el bucket. Debe devolver EXACTAMENTE lo mismo que el camino de R2.
const worker = (await import('../src/index.js')).default;
const ctx = { waitUntil() {} };
function bucket(objetos) {
  const store = new Map(Object.entries(objetos));
  return r2Conditions({
    async get(k) { const v = store.get(k); return v == null ? null : { json: async () => JSON.parse(v), text: async () => v }; },
    async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
    async head(k) { return store.has(k) ? { etag: 'e' } : null; },
    async list() { return { objects: [...store.keys()].map(key => ({ key })), truncated: false }; },
    store,
  });
}
const metas = [
  { id: '1794740670236-rsr1ui', type: 'video', assetKey: 'stock/1794740670236-rsr1ui/asset.mp4', size: 1763485, createdAt: '2026-11-15T10:24:30Z', title: 'creel-sr-whatsit', poster: 'https://api.admira.store/stock/poster/x' },
  { id: 'auto-aa', type: 'video', assetKey: 'stock/auto-aa/asset.mp4', size: 7, createdAt: '2026-10-01T00:00:00Z', thumbnail: 'https://api.admira.store/stock/auto-aa/t.jpg' },
  { id: 'link-1786', type: 'link', url: 'https://example.com/x', createdAt: '2026-08-01T00:00:00Z' },
  { id: '1793000000000-old', type: 'image', assetKey: 'stock/1793000000000-old/asset.jpg', size: 3, createdAt: '2026-11-01T00:00:00Z' },
  { id: '1794000000000-hid', type: 'video', assetKey: 'stock/1794000000000-hid/asset.mp4', size: 3, createdAt: '2026-11-10T00:00:00Z', oculto: true },
];
const objetos = Object.fromEntries(metas.map(m => [`stock/${m.id}/meta.json`, JSON.stringify(m)]));
const visibles = metas.filter(m => !m.oculto).map(m => ({ ...m }));

for (const limit of [2, 3, 300]) {
  test(`/stock/list?limit=${limit} desde el índice = camino de R2`, async () => {
    const lento = await (await worker.fetch(new Request(`https://api.admira.store/stock/list?limit=${limit}`), { STOCK_BUCKET: bucket(objetos) }, ctx)).json();
    const conIndice = bucket({ ...objetos, 'stock/index.json': JSON.stringify({ items: visibles, total: visibles.length }) });
    const rapido = await (await worker.fetch(new Request(`https://api.admira.store/stock/list?limit=${limit}`), { STOCK_BUCKET: conIndice }, ctx)).json();
    assert.deepEqual(rapido.items, lento.items);
    assert.equal(rapido.items[0]?.url?.startsWith('https://api.admira.store/stock/asset/'), true);
  });
}

test('/stock/list con filtro u ocultos=1 no usa el índice; sin índice cae al camino de R2', async () => {
  const conIndiceFalso = bucket({ ...objetos, 'stock/index.json': JSON.stringify({ items: [{ id: 'fantasma', createdAt: '2030' }] }) });
  const f = await (await worker.fetch(new Request('https://api.admira.store/stock/list?type=video'), { STOCK_BUCKET: conIndiceFalso }, ctx)).json();
  assert.ok(!f.items.some(m => m.id === 'fantasma'));
  const o = await (await worker.fetch(new Request('https://api.admira.store/stock/list?ocultos=1'), { STOCK_BUCKET: conIndiceFalso }, ctx)).json();
  assert.ok(o.items.some(m => m.oculto));
  const sin = await (await worker.fetch(new Request('https://api.admira.store/stock/list'), { STOCK_BUCKET: bucket(objetos) }, ctx)).json();
  assert.equal(sin.items.length, 4);
});
