import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { shouldFlushNotificationAggregates } from '../src/index.js';
import {
  AGGREGATE_POLICY,
  recordNotificationAggregate,
  safeSourceFingerprint,
} from '../src/notify-policy.mjs';
import {
  FakeClock,
  MemoryKv,
  assertExactConcurrentCount,
  assertSafeSummary,
} from './support/notify-policy-harness.mjs';

function executionContext() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) { pending.push(Promise.resolve(promise)); },
    async drain() { await Promise.all(pending); },
  };
}

function telegramFetchSpy() {
  const calls = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      const value = String(url);
      if (!value.startsWith('https://api.telegram.org/bot')) {
        throw new Error(`network forbidden in notification integration test: ${value}`);
      }
      calls.push({ url: value, body: JSON.parse(String(init.body || '{}')) });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

async function runRequest(request, env) {
  const ctx = executionContext();
  const response = await worker.fetch(request, env, ctx);
  await ctx.drain();
  return response;
}

test('solo el cron */2 consolida alertas; el solape */10 no duplica el resumen', () => {
  assert.equal(shouldFlushNotificationAggregates({ cron: '*/2 * * * *' }), true);
  assert.equal(shouldFlushNotificationAggregates({ cron: '*/10 * * * *' }), false);
  assert.equal(shouldFlushNotificationAggregates({ cron: '0 21 * * *' }), false);
  assert.equal(shouldFlushNotificationAggregates(null), false);
});

test('la implementación productiva conserva 12/12 shards concurrentes', async () => {
  let sequence = 0;
  const adapter = {
    async record(_input, { kv, now }) {
      await recordNotificationAggregate(kv, {
        kind: 'probe_404',
        path: '/graphql',
        source: 'scanner',
        fingerprint: 'contract-source',
      }, now(), () => `event-${++sequence}`);
    },
    async diagnostics({ kv }) {
      const page = await kv.list({ prefix: 'notify:aggregate:v1:event:probe_404:' });
      return { count: page.keys.length };
    },
  };
  await assertExactConcurrentCount(adapter, { count: 12 });
});

test('un bucket nuevo reinicia umbral y marker sin mezclar la ventana anterior', async () => {
  const clock = new FakeClock(0);
  const kv = new MemoryKv(clock);
  const request = new Request('https://worker.test/grid/book', {
    method: 'POST',
    headers: { 'User-Agent': 'security-test/1' },
    body: '{}',
  });
  const identity = await safeSourceFingerprint(request, '/grid/book');
  const event = { kind: 'bad_key_403', path: '/grid/book', ...identity };
  let sequence = 0;
  const first = await Promise.all(Array.from({ length: 3 }, () =>
    recordNotificationAggregate(kv, event, clock.now(), () => `a-${++sequence}`)));
  assert.equal(first.filter(result => result.summary).length, 1);
  clock.advance(AGGREGATE_POLICY.bad_key_403.windowMs);
  const next = await recordNotificationAggregate(kv, event, clock.now(), () => 'b-1');
  assert.equal(next.count, 1);
  assert.equal(next.summary, null);
  assert.equal(kv.ops.filter(op => op.op === 'put' && op.key.includes(':event:')).every(op => op.ttl === 86400), true);
});

test('GraphQL 404 no envía individuos y sólo resume al umbral 20', async () => {
  const originalFetch = globalThis.fetch;
  const telegram = telegramFetchSpy();
  globalThis.fetch = telegram.fetch;
  try {
    const env = { SIGNAGE_KV: new MemoryKv(), TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_CHAT_ID: 'fake-chat' };
    for (let index = 0; index < 19; index += 1) {
      const response = await runRequest(new Request('https://worker.test/graphql', {
        method: 'POST', headers: { 'User-Agent': 'scanner-contract/1' }, body: '{}',
      }), env);
      assert.equal(response.status, 404);
    }
    assert.equal(telegram.calls.length, 0);
    await runRequest(new Request('https://worker.test/graphql', {
      method: 'POST', headers: { 'User-Agent': 'scanner-contract/1' }, body: '{}',
    }), env);
    assert.equal(telegram.calls.length, 1);
    assert.match(telegram.calls[0].body.text, /20 intento/);
    assertSafeSummary(telegram.calls[0].body.text, ['fake-token', 'fake-chat']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bad-key 403 agrupa 3/3; 404 negocio y 5xx en ruta skip siguen inmediatos', async () => {
  const originalFetch = globalThis.fetch;
  const telegram = telegramFetchSpy();
  globalThis.fetch = telegram.fetch;
  try {
    const env = {
      SIGNAGE_KV: new MemoryKv(),
      GRID_KEY: 'expected-key',
      TELEGRAM_BOT_TOKEN: 'fake-token',
      TELEGRAM_CHAT_ID: 'fake-chat',
    };
    for (let index = 0; index < 2; index += 1) {
      const response = await runRequest(new Request('https://worker.test/grid/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'client-contract/1' },
        body: JSON.stringify({ key: 'wrong-key' }),
      }), env);
      assert.equal(response.status, 403);
    }
    assert.equal(telegram.calls.length, 0);
    await runRequest(new Request('https://worker.test/grid/book', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'client-contract/1' },
      body: JSON.stringify({ key: 'wrong-key' }),
    }), env);
    assert.equal(telegram.calls.length, 1);
    assert.match(telegram.calls[0].body.text, /3 intento/);

    await runRequest(new Request('https://worker.test/orders/42', {
      method: 'POST',
      headers: { Origin: 'https://spoof.invalid/path?token=leak', 'User-Agent': '203.0.113.42 secret=leak' },
      body: JSON.stringify({ token: 'body-secret' }),
    }), env);
    assert.equal(telegram.calls.length, 2, 'el 404 de negocio conserva señal inmediata');
    assertSafeSummary(telegram.calls[1].body.text, [
      'https://spoof.invalid', '203.0.113.42', 'secret=leak', 'body-secret', 'wrong-key',
    ]);

    await runRequest(new Request('https://worker.test/orders/token=path-secret', {
      method: 'POST', body: JSON.stringify({ password: 'body-password' }),
    }), env);
    assert.equal(telegram.calls.length, 3);
    assert.match(telegram.calls[2].body.text, /\/orders\/:redacted/);
    assertSafeSummary(telegram.calls[2].body.text, ['path-secret', 'body-password']);

    const serverError = await runRequest(new Request('https://worker.test/stock/track/asset', {
      method: 'POST',
    }), { TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_CHAT_ID: 'fake-chat' });
    assert.equal(serverError.status, 500);
    assert.equal(telegram.calls.length, 4, '5xx avisa incluso si /stock/* está normalmente silenciado');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sin KV los probes siguen fail-closed y health expone degradación', async () => {
  const originalFetch = globalThis.fetch;
  const telegram = telegramFetchSpy();
  globalThis.fetch = telegram.fetch;
  try {
    const env = { TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_CHAT_ID: 'fake-chat' };
    const probe = await runRequest(new Request('https://worker.test/api/graphql', {
      method: 'POST', body: '{}',
    }), env);
    assert.equal(probe.status, 404);
    assert.equal(telegram.calls.length, 0);
    const health = await runRequest(new Request('https://worker.test/healthz'), env);
    assert.equal((await health.json()).notificationAggregatorAvailable, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('el mando remoto silencia éxitos pero conserva errores en Telegram', async () => {
  const originalFetch = globalThis.fetch;
  const telegram = telegramFetchSpy();
  globalThis.fetch = telegram.fetch;
  try {
    let upstreamStatus = 200;
    const env = {
      TELEGRAM_BOT_TOKEN: 'fake-token',
      TELEGRAM_CHAT_ID: 'fake-chat',
      OMNI: {
        async fetch() {
          return new Response(JSON.stringify(upstreamStatus < 400
            ? { ok: true, cid: 42 }
            : { ok: false, error: 'invalid-command' }), {
            status: upstreamStatus,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    };

    for (const status of [200, 399]) {
      upstreamStatus = status;
      for (const path of ['/locations/cmd', '/locations/cmd/', '/locations/cmd/ack', '/locations/cmd/ack/']) {
        const response = await runRequest(new Request(`https://worker.test${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
          body: '{}',
        }), env);
        assert.equal(response.status, status);
      }
    }
    assert.equal(telegram.calls.length, 0, 'una interacción correcta no ensucia Telegram');

    for (const status of [400, 409, 500]) {
      upstreamStatus = status;
      for (const path of ['/locations/cmd', '/locations/cmd/ack']) {
        const rejected = await runRequest(new Request(`https://worker.test${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
          body: '{}',
        }), env);
        assert.equal(rejected.status, status);
      }
    }
    assert.equal(telegram.calls.length, 6, '4xx y 5xx conservan alerta inmediata en ambas rutas');
    assert.ok(telegram.calls.every(({ body }) => /POST \/locations\/cmd/.test(body.text)));

    upstreamStatus = 200;
    const put = await runRequest(new Request('https://worker.test/locations/cmd', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: '{}',
    }), env);
    assert.equal(put.status, 200);
    assert.equal(telegram.calls.length, 7, 'otros verbos no heredan el silencio reservado al mando');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
