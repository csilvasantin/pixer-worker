import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// R2 + KV in memory and a fake xAI: the whole persona flow without network.
function env() {
  const r2 = new Map(), kv = new Map();
  return {
    XAI_KEY: 'k',
    SIGNAGE_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async k => kv.delete(k) },
    STOCK_BUCKET: {
      put: async (k, v, o) => { r2.set(k, { bytes: typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v), meta: o?.httpMetadata }); },
      get: async k => { const o = r2.get(k); if (!o) return null; const text = new TextDecoder().decode(o.bytes);
        return { httpMetadata: o.meta, body: o.bytes, json: async () => JSON.parse(text), arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength) }; },
    },
    r2,
  };
}
const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push(url);
  if (url.endsWith('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: '{"gender":"m","age":"senior","skin":"#d4b8a3","hair":"#d4d4d4","top":"#c8c8c8","bottom":"#a8a8a8","shoes":"#2a2a2a","hairstyle":"short","outfit":"suit","accessory":"none","look":"white goatee, light grey suit"}' } }] }));
  if (url.includes('/assets/people/matrix-walk/grid-')) return new Response(new Uint8Array([1, 2, 3]));
  if (url.endsWith('/images/edits')) { const b = JSON.parse(init.body); assert.equal(b.images.length, 2); return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('walk').toString('base64'), mime_type: 'image/jpeg' }] })); }
  throw new Error('unexpected fetch ' + url);
};
const call = (e, method, path, body) => worker.fetch(new Request('https://api.admira.store' + path, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://www.xpaceos.com' }, body: body ? JSON.stringify(body) : undefined }), e, { waitUntil() {} });

test('a spawn with a persona stores it in R2 (not KV) and flags the queue entry', async () => {
  const e = env();
  const r = await (await call(e, 'POST', '/twin/spawn', { image: png, name: 'Anónimo||{"sex":"hombre","age":"senior"}', persona: png, npc16: png })).json();
  assert.ok(r.ok && /^npc_/.test(r.id));
  assert.ok(e.r2.has(`personas/${r.id}/persona.png`) && e.r2.has(`personas/${r.id}/npc16.png`) && e.r2.has(`personas/${r.id}/manifest.json`));
  const q = JSON.parse(await e.SIGNAGE_KV.get('twin:spawn:queue'));
  assert.equal(q[0].persona, true); assert.ok(!JSON.stringify(q).includes('fake-png') || q[0].img === png);
});

test('build runs describe → front → back once, in order, and serves the files', async () => {
  const e = env();
  const { id } = await (await call(e, 'POST', '/twin/spawn', { image: png, name: 'Anónimo||{"sex":"hombre"}', persona: png })).json();
  assert.equal((await call(e, 'POST', `/twin/persona/build?id=${id}&step=front`)).status, 409);
  const d = await (await call(e, 'POST', `/twin/persona/build?id=${id}&step=describe`)).json();
  assert.equal(d.body, 'male'); assert.equal(d.style.age, 'senior'); assert.equal(d.style.palette.color, '#c8c8c8');
  const before = calls.length;
  await call(e, 'POST', `/twin/persona/build?id=${id}&step=describe`);
  assert.equal(calls.length, before, 'a finished step is never repeated');
  await call(e, 'POST', `/twin/persona/build?id=${id}&step=front`);
  const done = await (await call(e, 'POST', `/twin/persona/build?id=${id}&step=back`)).json();
  assert.equal(done.ready, true); assert.match(done.walk.front, /name=walk-front\.jpg/); assert.match(done.walk.back, /name=walk-back\.jpg/);
  assert.ok(calls.some(u => u.endsWith('grid-male-front.jpg')));
  const file = await call(e, 'GET', `/twin/persona/file?id=${id}&name=walk-front.jpg`);
  assert.equal(file.status, 200); assert.equal(file.headers.get('Access-Control-Allow-Origin'), 'https://www.xpaceos.com');
  assert.equal((await call(e, 'GET', `/twin/persona/file?id=${id}&name=../secret.txt`)).status, 400);
});

test('a step claimed by another store answers busy instead of generating twice', async () => {
  const e = env();
  const { id } = await (await call(e, 'POST', '/twin/spawn', { image: png, persona: png })).json();
  const key = `personas/${id}/manifest.json`, m = JSON.parse(new TextDecoder().decode(e.r2.get(key).bytes));
  m.steps.describe = { claimed: Date.now() }; await e.STOCK_BUCKET.put(key, JSON.stringify(m));
  const r = await call(e, 'POST', `/twin/persona/build?id=${id}&step=describe`);
  assert.equal(r.status, 202); assert.equal((await r.json()).busy, true);
});

test('spawns without a persona keep the old 8-bit-only behaviour', async () => {
  const e = env();
  const r = await (await call(e, 'POST', '/twin/spawn', { image: png, name: 'Anónimo' })).json();
  assert.ok(r.ok); assert.equal([...e.r2.keys()].length, 0);
  assert.equal((await call(e, 'GET', `/twin/persona?id=${r.id}`)).status, 404);
});
