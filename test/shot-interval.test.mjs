import test from 'node:test';
import assert from 'node:assert/strict';
import { shotIntervalGet, shotIntervalPut, normalizeInterval } from '../src/shot-interval.mjs';
const json = (o, init = {}) => new Response(JSON.stringify(o), { status: init.status || 200 });
function kv() { const m = new Map(); return { m,
  get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); },
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) }; }
const keyOk = (env, b) => b.key === env.GRID_KEY;
const put = (env, body) => shotIntervalPut(new Request('https://x/', { method: 'PUT', body: JSON.stringify(body) }), env, json, keyOk);
const get = async (env, q) => (await shotIntervalGet(env, new URL('https://x/signage/shot/interval' + q), json)).json();

test('default, global y override por pantalla', async () => {
  const env = { SIGNAGE_KV: kv(), GRID_KEY: 'k' };
  assert.deepEqual((await get(env, '?screen=a')).interval, 15);
  assert.equal((await put(env, { key: 'k', interval: 30 })).status, 200);
  assert.equal((await get(env, '?screen=a')).source, 'global');
  await put(env, { key: 'k', screen: 'a', interval: 2 });
  const a = await get(env, '?screen=a'); assert.equal(a.interval, 8); assert.equal(a.source, 'screen');
  assert.deepEqual((await get(env, '')).screens, { a: 8 });
  await put(env, { key: 'k', screen: 'a', interval: null });
  assert.equal((await get(env, '?screen=a')).interval, 30);
});
test('auth y validación', async () => {
  const env = { SIGNAGE_KV: kv(), GRID_KEY: 'k' };
  assert.equal((await put(env, { key: 'no', interval: 30 })).status, 403);
  assert.equal((await put(env, { key: 'k', screen: 'bad slug!', interval: 30 })).status, 400);
  assert.equal((await put(env, { key: 'k', interval: 'x' })).status, 400);
  assert.equal(normalizeInterval(0), 0);
  assert.equal(normalizeInterval(99999), 3600);
});
