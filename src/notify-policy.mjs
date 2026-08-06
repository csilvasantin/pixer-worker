// Politica de alertas HTTP de bajo ruido. Los agregados usan eventos KV
// inmutables: Workers KV no ofrece CAS y un contador read-modify-write perderia
// intentos concurrentes. La entrega es at-least-once entre isolates; el marker
// evita duplicados en condiciones normales y el cron consolida ventanas cerradas.

const PREFIX = 'notify:aggregate:v1:';
const EVENT_PREFIX = PREFIX + 'event:';
const SUMMARY_PREFIX = PREFIX + 'summary:';

export const AGGREGATE_POLICY = Object.freeze({
  probe_404: Object.freeze({ windowMs: 10 * 60 * 1000, threshold: 20 }),
  bad_key_403: Object.freeze({ windowMs: 5 * 60 * 1000, threshold: 3 }),
});

const localLocks = new Map();

function normalizedPath(path) {
  const value = String(path || '/').toLowerCase().replace(/\/{2,}/g, '/');
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

export function classifyProbe404Path(path) {
  const value = normalizedPath(path);
  if (value === '/graphql' || value === '/v1/graphql' || value === '/api/graphql') return true;
  if (/^\/(?:api\/)?v\d+\/graphql$/.test(value)) return true;
  if (/^\/graphql\/(?:schema|playground|console|explorer)$/.test(value)) return true;
  return /^\/\.well-known\/(?:graphql|apollo\/server-health)$/.test(value);
}

export function classifyHttpNotification({ path, method, status, errorCode, skip = false }) {
  const verb = String(method || 'GET').toUpperCase();
  const code = Number(status) || 0;
  if (code >= 500) return { action: 'immediate', kind: 'server_error' };
  if (verb === 'POST' && code === 404 && classifyProbe404Path(path)) {
    return { action: 'aggregate', kind: 'probe_404' };
  }
  if (code === 403 && errorCode === 'bad-key') {
    return { action: 'aggregate', kind: 'bad_key_403' };
  }
  if (skip || verb === 'GET') return { action: 'skip', kind: 'routine' };
  return { action: 'immediate', kind: code >= 400 ? 'business_error' : 'business_event' };
}

export function notificationSourceClass(req) {
  const ua = String(req && req.headers && req.headers.get('User-Agent') || '').toLowerCase();
  if (!ua) return 'unknown';
  if (/(bot|crawler|spider|scanner|zgrab|nuclei)/.test(ua)) return 'scanner';
  if (/(curl|wget|httpie)/.test(ua)) return 'cli';
  if (/(python|axios|node-fetch|undici|go-http|java\/|okhttp)/.test(ua)) return 'service';
  if (/(mozilla|chrome|safari|firefox|edg\/)/.test(ua)) return 'browser';
  return 'client';
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function safeSourceFingerprint(req, path) {
  const method = String(req && req.method || 'GET').toUpperCase();
  const ua = String(req && req.headers && req.headers.get('User-Agent') || '');
  // El UA solo existe durante el hash; no se persiste ni aparece en Telegram.
  // Origin/Referer e IP se excluyen deliberadamente de identidad y almacenamiento.
  const fingerprint = (await sha256(`${method}\n${normalizedPath(path)}\n${ua}`)).slice(0, 20);
  return { fingerprint, source: notificationSourceClass(req) };
}

function eventPrefix(kind, bucket, fingerprint) {
  return `${EVENT_PREFIX}${kind}:${bucket}:${fingerprint}:`;
}

function summaryKey(kind, bucket, fingerprint) {
  return `${SUMMARY_PREFIX}${kind}:${bucket}:${fingerprint}`;
}

async function listAll(kv, prefix, limit = 1000) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor, limit: Math.min(1000, limit - keys.length) });
    keys.push(...(page.keys || []));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && keys.length < limit);
  return keys;
}

async function withLocalLock(key, fn) {
  const previous = localLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const chained = previous.then(() => current);
  localLocks.set(key, chained);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (localLocks.get(key) === chained) localLocks.delete(key);
  }
}

export function formatAggregateSummary(record, reason = 'threshold') {
  const label = record.kind === 'bad_key_403' ? 'BAD-KEY 403 AGRUPADO' : 'PROBES 404 AGRUPADOS';
  const why = reason === 'window' ? 'ventana cerrada' : 'umbral alcanzado';
  return `🛡️ <b>${label}</b>\n` +
    `· <code>${String(record.path)}</code> · ${record.count} intento(s)\n` +
    `· origen seguro <code>${record.source}:${record.fingerprint}</code>\n` +
    `· ${why} · ${Math.round(record.windowMs / 60000)} min`;
}

export async function recordNotificationAggregate(kv, event, now = Date.now(), idFactory = () => crypto.randomUUID()) {
  if (!kv || typeof kv.put !== 'function' || typeof kv.list !== 'function') return { available: false, summary: null, count: 0 };
  const policy = AGGREGATE_POLICY[event.kind];
  if (!policy) throw new Error('unknown-notification-aggregate');
  const bucket = Math.floor(now / policy.windowMs) * policy.windowMs;
  const prefix = eventPrefix(event.kind, bucket, event.fingerprint);
  const id = String(idFactory()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || String(now);
  const key = `${prefix}${String(now).padStart(13, '0')}:${id}`;
  const stored = { v: 1, kind: event.kind, path: normalizedPath(event.path), source: event.source, fingerprint: event.fingerprint, at: now, bucket };

  return withLocalLock(prefix, async () => {
    await kv.put(key, JSON.stringify(stored), { expirationTtl: 86400 });
    const keys = await listAll(kv, prefix);
    const count = keys.length;
    const marker = summaryKey(event.kind, bucket, event.fingerprint);
    if (count < policy.threshold || await kv.get(marker)) return { available: true, summary: null, count, key };
    const record = { ...stored, count, windowMs: policy.windowMs };
    await kv.put(marker, JSON.stringify({ v: 1, reportedAt: now, count }), { expirationTtl: 86400 });
    return { available: true, summary: formatAggregateSummary(record, 'threshold'), count, key };
  });
}

export async function flushNotificationAggregates(kv, send, now = Date.now()) {
  if (!kv || typeof kv.list !== 'function') return { scanned: 0, sent: 0 };
  const keys = await listAll(kv, EVENT_PREFIX, 5000);
  const groups = new Map();
  for (const key of keys) {
    let event;
    try { event = JSON.parse(await kv.get(key.name)); } catch { continue; }
    const policy = event && AGGREGATE_POLICY[event.kind];
    if (!policy || now < Number(event.bucket) + policy.windowMs) continue;
    const groupKey = `${event.kind}:${event.bucket}:${event.fingerprint}`;
    const group = groups.get(groupKey) || { ...event, count: 0, windowMs: policy.windowMs };
    group.count += 1;
    groups.set(groupKey, group);
  }
  let sent = 0;
  for (const group of groups.values()) {
    const marker = summaryKey(group.kind, group.bucket, group.fingerprint);
    if (await kv.get(marker)) continue;
    await kv.put(marker, JSON.stringify({ v: 1, reportedAt: now, count: group.count }), { expirationTtl: 86400 });
    await send(formatAggregateSummary(group, 'window'));
    sent += 1;
  }
  return { scanned: keys.length, sent };
}

export const __notifyPolicyTest = {
  classifyProbe404Path,
  classifyHttpNotification,
  notificationSourceClass,
  safeSourceFingerprint,
  recordNotificationAggregate,
  flushNotificationAggregates,
  formatAggregateSummary,
};
