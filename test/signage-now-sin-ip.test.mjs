import test from 'node:test';
import assert from 'node:assert/strict';
const worker = (await import('../src/index.js')).default;

test('GET /signage/now (público) no devuelve la IP del player', async () => {
  const kv = new Map([['now:pantalla-1', JSON.stringify({ item: { id: 'x', title: 't' }, __w: 1, __ip: '203.0.113.7' })]]);
  const env = { SIGNAGE_KV: { get: async k => kv.get(k) ?? null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [] }) } };
  const r = await worker.fetch(new Request('https://api.admira.store/signage/now?screen=pantalla-1'), env, { waitUntil() {} });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.item.id, 'x');
  assert.ok(!('ip' in d));
  assert.ok(!JSON.stringify(d).includes('203.0.113.7'));
});
