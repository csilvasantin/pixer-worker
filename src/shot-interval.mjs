// /signage/shot/interval — cada cuántos segundos captura cada player nativo.
// GET  ?screen=X  → { ok, interval, source: 'screen'|'global'|'default', global }  (público: lo lee el player)
// GET  (sin screen) → { ok, default, global, screens: { <screen>: s } }             (público: lo lee el panel)
// PUT  { key, screen?, interval }  — key = GRID_KEY (misma llave que /signage/assign).
//      sin screen (o "*") → global; interval null/"" → borra el override; 0 = capturas apagadas.
export const SHOT_INTERVAL_DEFAULT = 15;
export const SHOT_INTERVAL_MIN = 8;      // el POST /signage/shot limita a 1 subida / 8 s
export const SHOT_INTERVAL_MAX = 3600;
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
const GLOBAL_KEY = 'shotint:global';
const screenKey = (s) => 'shotint:screen:' + s;

export function normalizeInterval(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return 0;
  return Math.round(Math.max(SHOT_INTERVAL_MIN, Math.min(SHOT_INTERVAL_MAX, n)));
}

async function readNum(kv, key) {
  try { const v = await kv.get(key); if (v === null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; } catch { return null; }
}

export async function resolveShotInterval(kv, screen) {
  const global = await readNum(kv, GLOBAL_KEY);
  const own = screen ? await readNum(kv, screenKey(screen)) : null;
  if (own !== null) return { interval: own, source: 'screen', global };
  if (global !== null) return { interval: global, source: 'global', global };
  return { interval: SHOT_INTERVAL_DEFAULT, source: 'default', global };
}

export async function shotIntervalGet(env, url, json) {
  if (!env.SIGNAGE_KV) return json({ ok: false, reason: 'kv-not-bound' }, { status: 500 });
  const screen = String(url.searchParams.get('screen') || '').trim();
  const h = { headers: { 'Cache-Control': 'no-store' } };
  if (screen) {
    if (!SLUG.test(screen)) return json({ ok: false, reason: 'bad-screen' }, { status: 400 });
    return json({ ok: true, screen, ...(await resolveShotInterval(env.SIGNAGE_KV, screen)) }, h);
  }
  const screens = {};
  let cursor;
  do {
    const list = await env.SIGNAGE_KV.list({ prefix: 'shotint:screen:', cursor, limit: 1000 });
    for (const k of list.keys) { const n = await readNum(env.SIGNAGE_KV, k.name); if (n !== null) screens[k.name.slice(15)] = n; }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return json({ ok: true, default: SHOT_INTERVAL_DEFAULT, global: await readNum(env.SIGNAGE_KV, GLOBAL_KEY), screens }, h);
}

export async function shotIntervalPut(req, env, json, keyOk) {
  if (!env.SIGNAGE_KV) return json({ ok: false, reason: 'kv-not-bound' }, { status: 500 });
  let b = {};
  try { b = await req.json(); } catch { return json({ ok: false, reason: 'bad-json' }, { status: 400 }); }
  if (!keyOk(env, b)) return json({ ok: false, reason: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const screen = String(b.screen || '').trim();
  const isGlobal = !screen || screen === '*';
  if (!isGlobal && !SLUG.test(screen)) return json({ ok: false, reason: 'bad-screen' }, { status: 400 });
  const v = normalizeInterval(b.interval);
  if (v === undefined) return json({ ok: false, reason: 'bad-interval' }, { status: 400 });
  const key = isGlobal ? GLOBAL_KEY : screenKey(screen);
  if (v === null) await env.SIGNAGE_KV.delete(key); else await env.SIGNAGE_KV.put(key, String(v));
  return json({ ok: true, scope: isGlobal ? 'global' : 'screen', screen: isGlobal ? null : screen, interval: v });
}
