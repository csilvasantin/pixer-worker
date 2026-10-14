// PresenceClock — reloj de presencia de pantallas en un Durable Object (sin KV).
// /signage/screens leía last_seen del registro KV screen:<id>, que nowUpsertScreenLoc
// sólo reescribe cada HB_REFRESH_MS (270 s) para no agotar el tope diario de KV.
// Resultado: un player vivo que late cada 45-60 s salía con age_seconds 60-270 y
// admira.live/control (umbral 60 s) lo pintaba "sin heartbeat". Este DO guarda el
// último latido de CADA POST en memoria (persistencia SQLite como mucho cada 30 s
// por pantalla) y /signage/screens lo superpone. KV no gasta ni un write más.
// Sin import de cloudflare:workers (index.js se testea con node --test): DO clásico por fetch.

const PERSIST_EVERY_MS = 30 * 1000;
const MAX_SCREENS = 500;

export class PresenceClock {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.seen = new Map();      // screen -> last_seen (ms)
    this.persisted = new Map(); // screen -> último ms escrito en storage
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get('seen');
      if (stored && typeof stored === 'object') {
        for (const [k, v] of Object.entries(stored)) { this.seen.set(k, v); this.persisted.set(k, v); }
      }
    });
  }
  async beat(screen, ts) {
    screen = String(screen || '').slice(0, 60);
    if (!/^[a-z0-9_-]+$/i.test(screen)) return false;
    ts = Number(ts) || Date.now();
    if ((this.seen.get(screen) || 0) >= ts) return true;
    this.seen.set(screen, ts);
    if (this.seen.size > MAX_SCREENS) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.seen.size - MAX_SCREENS);
      for (const [k] of oldest) { this.seen.delete(k); this.persisted.delete(k); }
    }
    if (ts - (this.persisted.get(screen) || 0) >= PERSIST_EVERY_MS) {
      this.persisted.set(screen, ts);
      await this.ctx.storage.put('seen', Object.fromEntries(this.seen));
    }
    return true;
  }
  async all() { return Object.fromEntries(this.seen); }
  async fetch(req) {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      return Response.json({ ok: await this.beat(b.screen, b.ts) });
    }
    return Response.json(await this.all());
  }
}

function stub(env) {
  return env.PRESENCE_CLOCK ? env.PRESENCE_CLOCK.get(env.PRESENCE_CLOCK.idFromName('signage')) : null;
}
export async function presenceBeat(env, screen, ts) {
  const s = stub(env); if (!s) return false;
  try {
    const r = await s.fetch('https://presence/beat', { method: 'POST', body: JSON.stringify({ screen, ts }) });
    return !!(await r.json()).ok;
  } catch { return false; }
}
export async function presenceAll(env) {
  const s = stub(env); if (!s) return null;
  try { return await (await s.fetch('https://presence/all')).json(); } catch { return null; }
}
