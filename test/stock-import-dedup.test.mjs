// Dedup idempotente de importaciones por URL (22-oct-2026: #1795/#1796/#1797 eran el
// mismo vídeo de https://lnkd.in/p/e9zXSPkK, importado tres veces en 2 s).
import { r2Conditions } from './helpers/r2-conditions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stockPublishHandler } from '../src/index.js';
import { importSourceKey, claimIsLive, isShortenerHost } from '../src/stock-dedup.mjs';

const LI = 'https://www.linkedin.com/posts/adilovalber_we-turned-claude-opus-55-into-a-motion-design-ugcPost-7518757011845611520-J1pb/?highlightedUpdateUrn=urn%3Ali%3Aactivity%3A7518933579725238272&utm_source=social_share_send&rcm=ACoAAA';

test('importSourceKey: id del post/vídeo y URL sin tracking', () => {
  assert.equal(importSourceKey(LI), 'linkedin:7518757011845611520');
  assert.equal(importSourceKey('https://www.linkedin.com/feed/update/urn:li:activity:7518757011845611520/'), 'linkedin:7518757011845611520');
  assert.equal(importSourceKey('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'youtube:dQw4w9WgXcQ');
  assert.equal(importSourceKey('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'youtube:dQw4w9WgXcQ');
  assert.equal(importSourceKey('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'youtube:dQw4w9WgXcQ');
  assert.equal(importSourceKey('https://x.com/a/status/123456789'), 'x:123456789');
  assert.equal(importSourceKey('https://Example.com/a/?utm_source=1&id=2#h'), importSourceKey('https://example.com/a?id=2'));
  assert.equal(importSourceKey('no-url'), null);
  assert.ok(isShortenerHost('lnkd.in'));
});

test('claimIsLive: reciente o con asset vivo; abandonada pasado el plazo', () => {
  const now = Date.parse('2026-10-22T13:30:40Z');
  assert.equal(claimIsLive({ at: '2026-10-22T13:30:38Z' }, { now }), true);
  assert.equal(claimIsLive({ at: '2026-10-22T13:00:00Z' }, { now }), false);
  assert.equal(claimIsLive({ at: '2026-10-22T13:00:00Z' }, { now, ownerAlive: true }), true);
  assert.equal(claimIsLive(null, { now }), false);
});

class Bucket {
  map = new Map();
  async get(key) { const v = this.map.get(key); return v == null ? null : { json: async () => JSON.parse(typeof v === 'string' ? v : new TextDecoder().decode(v)), body: new Response(v).body, size: v.length ?? v.byteLength }; }
  async put(key, value) { this.map.set(key, value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : value); }
  async delete(key) { for (const k of [].concat(key)) this.map.delete(k); }
  async list({ prefix = '' } = {}) { return { objects: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }; }
}
const pending = []; const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
const body = (extra = {}) => ({ type: 'video', motor: 'yt-dlp', mime: 'video/mp4', base64: btoa('mismo-video-linkedin'), prompt: 'https://lnkd.in/p/e9zXSPkK', title: 'We tested it on a big task', ...extra });
const req = (b) => new Request('https://api.admira.store/stock/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const metas = (e) => [...e.STOCK_BUCKET.map.keys()].filter(k => /^stock\/[^/]+\/meta\.json$/.test(k));

function withShortener(fn) {
  return async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (u, opts) => {
      if (String(u).startsWith('https://lnkd.in/')) return new Response('', { status: 301, headers: { Location: LI } });
      // Clasificación lenta (~1-2 s en producción): es la ventana de la carrera.
      if (String(u).includes('generativelanguage.googleapis.com')) { await new Promise(r => setTimeout(r, 150)); return new Response('{}', { status: 500 }); }
      return real(u, opts);
    };
    try { await fn(); } finally { globalThis.fetch = real; }
  };
}

test('tres publicaciones simultáneas del mismo vídeo → un solo asset; las otras responden reused con su id', withShortener(async () => {
  const e = { STOCK_BUCKET: r2Conditions(new Bucket()), GEMINI_API_KEY: 'test' };
  const rs = await Promise.all([1, 2, 3].map(() => stockPublishHandler(req(body()), e, ctx).then(r => r.json())));
  await Promise.all(pending);
  assert.equal(metas(e).length, 1, 'un único meta.json');
  const created = rs.filter(r => !r.reused);
  assert.equal(created.length, 1);
  for (const r of rs.filter(r => r.reused)) assert.equal(r.id, created[0].id);
  assert.equal([...e.STOCK_BUCKET.map.keys()].filter(k => /asset\./.test(k)).length, 1, 'sin binarios huérfanos');
}));

test('reimportar la misma URL (aunque el binario cambie) → duplicate_source, no crea entrada', withShortener(async () => {
  const e = { STOCK_BUCKET: r2Conditions(new Bucket()) };
  const first = await (await stockPublishHandler(req(body()), e, ctx)).json();
  await Promise.all(pending);
  const again = await (await stockPublishHandler(req(body({ base64: btoa('re-mux-distinto'), prompt: LI })), e, ctx)).json();
  assert.equal(again.reused, true);
  assert.equal(again.reason, 'duplicate_source');
  assert.equal(again.id, first.id);
  assert.equal(metas(e).length, 1);
}));
