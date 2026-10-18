import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ADMIRA_TUBE_BASES_DEFAULT, parseTubeBases, admiraTubeBaseCandidates, tubeHealth, importToStockWithFailover,
} from '../src/tube-failover.mjs';

const STUDIO = 'https://macstudio.tail48b61c.ts.net/admira';
const MINI = 'https://macmini.tail48b61c.ts.net/admira';
const jres = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// fetch falso: tabla por URL → Response | Error | función. Registra las llamadas.
function fakeFetch(table) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    const v = table[url];
    if (v === undefined) throw new TypeError('no route ' + url);
    const out = typeof v === 'function' ? await v(opts) : v;
    if (out instanceof Error) throw out;
    return out.clone ? out.clone() : out;
  };
  fn.calls = calls;
  return fn;
}
const posts = (f) => f.calls.filter((c) => c.method === 'POST').map((c) => c.url);

test('defaults: Studio first, Mini second; ADMIRA_TUBE_BASE accepts a comma list and keeps defaults behind', () => {
  assert.deepEqual(ADMIRA_TUBE_BASES_DEFAULT, [STUDIO, MINI]);
  assert.deepEqual(admiraTubeBaseCandidates({}), [STUDIO, MINI]);
  assert.deepEqual(admiraTubeBaseCandidates({ ADMIRA_TUBE_BASE: '' }), [STUDIO, MINI]);
  assert.deepEqual(admiraTubeBaseCandidates({ ADMIRA_TUBE_BASE: ` ${MINI}/ , https://x.example/admira ,, ${MINI}` }), [MINI, 'https://x.example/admira', STUDIO]);
  assert.deepEqual(parseTubeBases('not-a-url, ftp://x, https://a/b//'), ['https://a/b']);
});

test('tubeHealth: healthy / down (available:false, 503) / unknown (throw or timeout)', async () => {
  assert.equal(await tubeHealth(STUDIO, { fetchFn: fakeFetch({ [STUDIO + '/tube/health']: jres(200, { ok: true, available: true }) }) }), 'healthy');
  assert.equal(await tubeHealth(STUDIO, { fetchFn: fakeFetch({ [STUDIO + '/tube/health']: jres(200, { ok: true, available: false }) }) }), 'down');
  assert.equal(await tubeHealth(STUDIO, { fetchFn: fakeFetch({ [STUDIO + '/tube/health']: jres(503, {}) }) }), 'down');
  assert.equal(await tubeHealth(STUDIO, { fetchFn: fakeFetch({}) }), 'unknown');
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  assert.equal(await tubeHealth(STUDIO, { timeoutMs: 20, fetchFn: hang }), 'unknown');
});

test('healthy Studio gets the single POST; Mini is never contacted', async () => {
  const f = fakeFetch({
    [STUDIO + '/tube/health']: jres(200, { ok: true, available: true }),
    [STUDIO + '/tube/import-to-stock']: jres(200, { ok: true, jobId: 'job-1' }),
  });
  const r = await importToStockWithFailover([STUDIO, MINI], { url: 'https://youtu.be/x', format: 'video' }, { fetchFn: f });
  assert.equal(r.accepted, true); assert.equal(r.base, STUDIO); assert.equal(r.jobId, 'job-1');
  assert.deepEqual(posts(f), [STUDIO + '/tube/import-to-stock']);
  assert.ok(!f.calls.some((c) => c.url.startsWith(MINI)));
});

test('Studio health down → Mini receives the POST; Studio never gets one', async () => {
  const f = fakeFetch({
    [STUDIO + '/tube/health']: jres(200, { ok: true, available: false }),
    [MINI + '/tube/health']: jres(200, { ok: true, available: true }),
    [MINI + '/tube/import-to-stock']: jres(200, { jobId: 'job-m' }),
  });
  const r = await importToStockWithFailover([STUDIO, MINI], {}, { fetchFn: f });
  assert.deepEqual([r.accepted, r.base, r.jobId], [true, MINI, 'job-m']);
  assert.deepEqual(posts(f), [MINI + '/tube/import-to-stock']);
});

test('Studio health throws (DNS/TLS) → falls to Mini (per-base try/catch)', async () => {
  const f = fakeFetch({
    [MINI + '/tube/health']: jres(200, { ok: true }),
    [MINI + '/tube/import-to-stock']: jres(200, { jobId: 'job-m' }),
  });
  const r = await importToStockWithFailover([STUDIO, MINI], {}, { fetchFn: f });
  assert.deepEqual([r.accepted, r.base], [true, MINI]);
  assert.deepEqual(posts(f), [MINI + '/tube/import-to-stock']);
});

test('explicit 503 «not available» from the chosen base (nothing accepted) → next base', async () => {
  const f = fakeFetch({
    [STUDIO + '/tube/health']: jres(200, { ok: true, available: true }),
    [STUDIO + '/tube/import-to-stock']: jres(503, { error: 'unavailable' }),
    [MINI + '/tube/import-to-stock']: jres(200, { jobId: 'job-m' }),
  });
  const r = await importToStockWithFailover([STUDIO, MINI], {}, { fetchFn: f });
  assert.deepEqual([r.accepted, r.base], [true, MINI]);
  assert.deepEqual(posts(f), [STUDIO + '/tube/import-to-stock', MINI + '/tube/import-to-stock']);
});

test('2xx without jobId still counts as accepted and is never retried elsewhere', async () => {
  const f = fakeFetch({
    [STUDIO + '/tube/health']: jres(200, { ok: true }),
    [STUDIO + '/tube/import-to-stock']: new Response('ok', { status: 202 }),
  });
  const r = await importToStockWithFailover([STUDIO, MINI], {}, { fetchFn: f });
  assert.deepEqual([r.accepted, r.jobId], [true, '']);
  assert.equal(posts(f).length, 1);
});

test('definitive 4xx (host not allowed) is not repeated on the other base', async () => {
  const f = fakeFetch({
    [STUDIO + '/tube/health']: jres(200, { ok: true }),
    [STUDIO + '/tube/import-to-stock']: jres(400, { error: 'host not allowed' }),
    [MINI + '/tube/import-to-stock']: jres(200, { jobId: 'x' }),
  });
  const r = await importToStockWithFailover([STUDIO, MINI], {}, { fetchFn: f });
  assert.deepEqual([r.accepted, r.status, r.ambiguous], [false, 400, false]);
  assert.match(r.body, /host not allowed/);
  assert.deepEqual(posts(f), [STUDIO + '/tube/import-to-stock']);
});

test('EDGE CASE: POST sent but no response (throw/timeout) → ambiguous, NO retry on the other base', async () => {
  const f = fakeFetch({
    [STUDIO + '/tube/health']: jres(200, { ok: true }),
    [STUDIO + '/tube/import-to-stock']: new Error('Network connection lost'),
    [MINI + '/tube/health']: jres(200, { ok: true }),
    [MINI + '/tube/import-to-stock']: jres(200, { jobId: 'dup' }),
  });
  const r = await importToStockWithFailover([STUDIO, MINI], {}, { fetchFn: f });
  assert.deepEqual([r.accepted, r.ambiguous, r.base], [false, true, STUDIO]);
  assert.deepEqual(posts(f), [STUDIO + '/tube/import-to-stock']);
  // y por timeout propio del POST
  const hang = fakeFetch({
    [STUDIO + '/tube/health']: jres(200, { ok: true }),
    [STUDIO + '/tube/import-to-stock']: (o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))),
    [MINI + '/tube/import-to-stock']: jres(200, { jobId: 'dup' }),
  });
  const r2 = await importToStockWithFailover([STUDIO, MINI], {}, { fetchFn: hang, postTimeoutMs: 20 });
  assert.deepEqual([r2.accepted, r2.ambiguous], [false, true]);
  assert.equal(posts(hang).length, 1);
});

test('all bases explicitly down → no POST at all; all unreachable → still tries them in order', async () => {
  const down = fakeFetch({
    [STUDIO + '/tube/health']: jres(200, { available: false }),
    [MINI + '/tube/health']: jres(503, {}),
  });
  const r = await importToStockWithFailover([STUDIO, MINI], {}, { fetchFn: down });
  assert.deepEqual([r.accepted, r.noHealthy], [false, true]);
  assert.equal(posts(down).length, 0);

  const unreachable = fakeFetch({ [STUDIO + '/tube/import-to-stock']: jres(503, {}), [MINI + '/tube/import-to-stock']: jres(200, { jobId: 'm' }) });
  const r2 = await importToStockWithFailover([STUDIO, MINI], {}, { fetchFn: unreachable });
  assert.deepEqual([r2.accepted, r2.base], [true, MINI]);
});

test('index.js wires the module (no inline loop, no hard-coded single Mini base)', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /importToStockWithFailover\(bases,/);
  assert.doesNotMatch(src, /for \(const base of bases\)/);
  assert.doesNotMatch(src, /ADMIRA_TUBE_BASE_DEFAULT\b/);
});
