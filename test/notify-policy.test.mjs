import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGGREGATE_POLICY,
  INCIDENT_POLICY,
  classifyHttpNotification,
  classifyProbe404Path,
  flushNotificationAggregates,
  formatAggregateSummary,
  formatIncidentRecovery,
  recordNotificationAggregate,
  recordNotificationIncident,
  safeIncidentIdentity,
  safeSourceFingerprint,
} from '../src/notify-policy.mjs';

class FakeKV {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.get(key)?.value ?? null; }
  async put(key, value, options) { this.data.set(key, { value, options }); }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const all = [...this.data.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + limit).map(name => ({ name }));
    const next = start + page.length;
    return { keys: page, list_complete: next >= all.length, cursor: next >= all.length ? undefined : String(next) };
  }
}

const req = (ua = 'curl/8.0', origin = 'https://spoof.invalid') => new Request('https://worker.test/grid/book', {
  method: 'POST', headers: { 'User-Agent': ua, Origin: origin }, body: '{}',
});
const authEvent = async (request = req()) => {
  const id = await safeSourceFingerprint(request, '/grid/book');
  return { kind: 'bad_key_403', path: '/grid/book', ...id };
};

test('reconoce los tres probes GraphQL canónicos', () => {
  for (const path of ['/graphql', '/v1/graphql', '/api/graphql']) assert.equal(classifyProbe404Path(path), true);
});

test('reconoce variantes de discovery acotadas', () => {
  for (const path of ['/api/v2/graphql/', '/graphql/playground', '/.well-known/graphql']) assert.equal(classifyProbe404Path(path), true);
});

test('un POST 404 de negocio continúa inmediato', () => {
  assert.deepEqual(classifyHttpNotification({ path: '/orders/42', method: 'POST', status: 404 }), { action: 'immediate', kind: 'business_error' });
});

test('sólo el 403 bad-key exacto se agrega', () => {
  assert.equal(classifyHttpNotification({ path: '/grid/book', method: 'POST', status: 403, errorCode: 'bad-key' }).action, 'aggregate');
  assert.equal(classifyHttpNotification({ path: '/grid/book', method: 'POST', status: 403, errorCode: 'forbidden' }).action, 'immediate');
});

test('todo 5xx es inmediato incluso en ruta skip', () => {
  assert.equal(classifyHttpNotification({ path: '/healthz', method: 'GET', status: 503, skip: true }).action, 'immediate');
});

test('lectura rutinaria no genera alerta', () => {
  assert.equal(classifyHttpNotification({ path: '/stock/list', method: 'GET', status: 200 }).action, 'skip');
});

test('fingerprint ignora Origin y no expone User-Agent', async () => {
  const a = await safeSourceFingerprint(req('curl/private-build', 'https://one.test'), '/grid/book');
  const b = await safeSourceFingerprint(req('curl/private-build', 'https://two.test'), '/grid/book');
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a).includes('private-build'), false);
});

test('tres bad-key concurrentes conservan eventos y emiten un resumen', async () => {
  const kv = new FakeKV();
  const event = await authEvent();
  let seq = 0;
  const out = await Promise.all(Array.from({ length: 3 }, () => recordNotificationAggregate(kv, event, 1_800_000, () => `id${++seq}`)));
  assert.equal([...kv.data.keys()].filter(k => k.includes(':event:bad_key_403:')).length, 3);
  assert.equal(out.filter(x => x.summary).length, 1);
  assert.equal(Math.max(...out.map(x => x.count)), 3);
});

test('probe no emite individuos y resume al evento veinte', async () => {
  const kv = new FakeKV();
  const identity = await safeSourceFingerprint(req('scanner/1'), '/graphql');
  const event = { kind: 'probe_404', path: '/graphql', ...identity };
  const out = [];
  for (let i = 0; i < AGGREGATE_POLICY.probe_404.threshold; i++) out.push(await recordNotificationAggregate(kv, event, 1_200_000, () => `p${i}`));
  assert.equal(out.slice(0, -1).every(x => !x.summary), true);
  assert.match(out.at(-1).summary, /20 intento/);
});

test('cron consolida bucket cerrado una sola vez', async () => {
  const kv = new FakeKV();
  const event = await authEvent();
  await recordNotificationAggregate(kv, event, 0, () => 'one');
  const sent = [];
  const now = AGGREGATE_POLICY.bad_key_403.windowMs + 1;
  assert.equal((await flushNotificationAggregates(kv, m => sent.push(m), now)).sent, 1);
  assert.equal((await flushNotificationAggregates(kv, m => sent.push(m), now)).sent, 0);
  assert.equal(sent.length, 1);
});

test('sin KV el agregado falla cerrado sin inventar resumen', async () => {
  const result = await recordNotificationAggregate(null, await authEvent(), 0, () => 'x');
  assert.deepEqual(result, { available: false, summary: null, count: 0 });
});

test('resumen contiene sólo ruta, clase y fingerprint seguros', () => {
  const text = formatAggregateSummary({ kind: 'bad_key_403', path: '/grid/book', source: 'cli', fingerprint: 'abc123', count: 3, windowMs: 300000 });
  assert.match(text, /\/grid\/book/);
  assert.match(text, /cli:abc123/);
  for (const forbidden of ['Origin', '127.0.0.1', 'secret=', '{"error"']) assert.equal(text.includes(forbidden), false);
});

test('fingerprint de incidente browser identifica la operación y el fallo, no el UA', async () => {
  const chrome = req('Mozilla/5.0 Chrome/140.0 private-build', 'https://one.test');
  const safari = req('Mozilla/5.0 Safari/19.0 private-build', 'https://two.test');
  const a = await safeIncidentIdentity(chrome, '/grid/book', 502, 'upstream-failed');
  const b = await safeIncidentIdentity(safari, '/grid/book', 502, 'upstream-failed');
  assert.equal(a.source, 'browser');
  assert.equal(a.operationFingerprint, b.operationFingerprint);
  assert.equal(a.failureFingerprint, b.failureFingerprint);
  const changed = await safeIncidentIdentity(safari, '/grid/book', 503, 'unavailable');
  assert.equal(changed.operationFingerprint, a.operationFingerprint);
  assert.notEqual(changed.failureFingerprint, a.failureFingerprint);
  for (const unsafe of ['private-build', 'one.test', 'two.test', 'upstream-failed']) {
    assert.equal(JSON.stringify(a).includes(unsafe), false);
  }
});

test('incidente idéntico avisa primero, limita repeticiones y avisa recuperación', async () => {
  const kv = new FakeKV();
  const identity = await safeIncidentIdentity(req('Mozilla/5.0 Chrome/140.0'), '/orders', 502, 'upstream-failed');
  const failure = { phase: 'failure', method: 'POST', path: '/orders', status: 502, errorCode: 'upstream-failed', ...identity };

  const first = await recordNotificationIncident(kv, failure, 1_000);
  assert.equal(first.action, 'send_first');
  assert.equal(first.count, 1);

  const repeated = await recordNotificationIncident(kv, failure, 2_000);
  assert.equal(repeated.action, 'suppress');
  assert.equal(repeated.count, 2);

  const reminder = await recordNotificationIncident(kv, failure, 1_000 + INCIDENT_POLICY.cooldownMs);
  assert.equal(reminder.action, 'send_reminder');
  assert.equal(reminder.count, 3);
  assert.equal(reminder.suppressed, 1);

  const recovery = await recordNotificationIncident(kv, {
    phase: 'success', method: 'POST', path: '/orders', status: 200,
    source: identity.source, operationFingerprint: identity.operationFingerprint,
  }, 1_000 + INCIDENT_POLICY.cooldownMs + 500);
  assert.equal(recovery.action, 'send_recovery');
  assert.equal(recovery.count, 3);
  assert.match(formatIncidentRecovery(recovery), /RECUPERADO/);

  const healthyAgain = await recordNotificationIncident(kv, {
    phase: 'success', method: 'POST', path: '/orders', status: 200,
    source: identity.source, operationFingerprint: identity.operationFingerprint,
  }, 1_000 + INCIDENT_POLICY.cooldownMs + 1_000);
  assert.equal(healthyAgain.action, 'none');

  const recurrence = await recordNotificationIncident(kv, failure, 1_000 + INCIDENT_POLICY.cooldownMs + 2_000);
  assert.equal(recurrence.action, 'send_first');
});

test('un fallo distinto en la misma operación no queda oculto por el cooldown', async () => {
  const kv = new FakeKV();
  const request = req('Mozilla/5.0 Chrome/140.0');
  const firstIdentity = await safeIncidentIdentity(request, '/orders', 502, 'upstream-failed');
  const changedIdentity = await safeIncidentIdentity(request, '/orders', 503, 'unavailable');
  await recordNotificationIncident(kv, {
    phase: 'failure', method: 'POST', path: '/orders', status: 502, errorCode: 'upstream-failed', ...firstIdentity,
  }, 1_000);
  const changed = await recordNotificationIncident(kv, {
    phase: 'failure', method: 'POST', path: '/orders', status: 503, errorCode: 'unavailable', ...changedIdentity,
  }, 2_000);
  assert.equal(changed.action, 'send_first');
  assert.equal(changed.count, 1);
});

test('sin KV el primer error no se oculta', async () => {
  const identity = await safeIncidentIdentity(req(), '/orders', 500, 'worker-exception');
  const result = await recordNotificationIncident(null, {
    phase: 'failure', method: 'POST', path: '/orders', status: 500, errorCode: 'worker-exception', ...identity,
  }, 1_000);
  assert.equal(result.available, false);
  assert.equal(result.action, 'send_first');
});
