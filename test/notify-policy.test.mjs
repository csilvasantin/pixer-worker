import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGGREGATE_POLICY,
  classifyHttpNotification,
  classifyProbe404Path,
  flushNotificationAggregates,
  formatAggregateSummary,
  recordNotificationAggregate,
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
