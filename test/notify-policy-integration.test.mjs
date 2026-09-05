import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  AGORA_AWAKE_MS,
  AGORA_PRESENCE_REFRESH_MS,
  agoraPresenceUpdate,
  shouldFlushNotificationAggregates,
} from '../src/index.js';
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

function agoraPresenceRequest(overrides = {}) {
  return new Request('https://worker.test/agora/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'agora/1.0' },
    body: JSON.stringify({
      key: 'test-key', identity: 'Codex·gmail', host: 'test-host',
      persona: 'OraculoMacMini', tokens: 100, reqs: 2, ...overrides,
    }),
  });
}

function presenceWriteCount(kv) {
  return kv.ops.filter(operation => operation.op === 'put' && operation.key === 'agora:presence').length;
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

test('POST /agora/presence 503 no envía una alerta inmediata a Telegram', async () => {
  const originalFetch = globalThis.fetch;
  const telegram = telegramFetchSpy();
  globalThis.fetch = telegram.fetch;
  try {
    const response = await runRequest(new Request('https://worker.test/agora/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'agora/1.0' },
      body: JSON.stringify({ key: 'test-key', identity: 'Codex·gmail', host: 'test-host' }),
    }), {
      AGORA_SYNC_KEY: 'test-key',
      KV_WRITES_OFF: '1',
      TELEGRAM_BOT_TOKEN: 'fake-token',
      TELEGRAM_CHAT_ID: 'fake-chat',
    });
    assert.equal(response.status, 503);
    assert.equal(telegram.calls.length, 0, 'el latido fallido de Agora permanece fuera de Telegram');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('presencia idéntica se deduplica pero un cambio real escribe inmediatamente', async () => {
  const kv = new MemoryKv();
  const env = { SIGNAGE_KV: kv, AGORA_SYNC_KEY: 'test-key' };

  const first = await runRequest(agoraPresenceRequest(), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).deduplicated, false);
  assert.equal(presenceWriteCount(kv), 1);

  const repeated = await runRequest(agoraPresenceRequest(), env);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).deduplicated, true);
  assert.equal(presenceWriteCount(kv), 1, 'un latido idéntico dentro del TTL no reescribe presencia');

  const changed = await runRequest(agoraPresenceRequest({ tokens: 101 }), env);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).deduplicated, false);
  assert.equal(presenceWriteCount(kv), 2, 'un cambio de estado persiste sin esperar al refresco');
});

test('cada campo observable de presencia invalida la deduplicación', () => {
  const now = Date.now();
  const current = {
    ts: now - 1_000,
    host: 'test-host', persona: 'OraculoMacMini', tokens: 100, reqs: 2,
  };
  for (const change of [
    { host: 'other-host' },
    { persona: 'SubOraculoMacMini' },
    { tokens: 101 },
    { reqs: 3 },
  ]) {
    assert.equal(agoraPresenceUpdate(current, { ...current, ...change }, now).shouldWrite, true);
  }
});

test('el vencimiento refresca ts antes del umbral awake de cinco minutos', async () => {
  assert.equal(AGORA_AWAKE_MS, 5 * 60 * 1000);
  assert.ok(AGORA_PRESENCE_REFRESH_MS < AGORA_AWAKE_MS);
  const now = Date.now();
  const previous = {
    ts: now - AGORA_PRESENCE_REFRESH_MS - 1,
    host: 'test-host', persona: 'OraculoMacMini', tokens: 100, reqs: 2,
  };
  assert.equal(agoraPresenceUpdate(previous, previous, now).shouldWrite, true);

  const kv = new MemoryKv();
  kv.data.set('agora:presence', {
    value: JSON.stringify({ 'Codex·gmail': previous }),
    expiresAt: 0,
  });
  const response = await runRequest(agoraPresenceRequest(), {
    SIGNAGE_KV: kv,
    AGORA_SYNC_KEY: 'test-key',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deduplicated, false);
  assert.equal(presenceWriteCount(kv), 1);
  const stored = JSON.parse(await kv.get('agora:presence'))['Codex·gmail'];
  assert.ok(stored.ts > previous.ts, 'el refresco renueva la marca temporal persistida');
});

test('una escritura de presencia necesaria conserva el 503 si KV está bloqueado', async () => {
  const response = await runRequest(agoraPresenceRequest(), {
    AGORA_SYNC_KEY: 'test-key',
    KV_WRITES_OFF: '1',
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'kv-write-blocked');
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
    // FLT-1779 (5-sep-2026): un éxito nunca es noticia, sea el verbo que sea; los errores siguen avisando.
    assert.equal(telegram.calls.length, 6, 'un PUT que sale bien tampoco ensucia Telegram');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ACK browser repetido conserva primer invalid_ack_reference, limita duplicados y avisa recuperación', async () => {
  const originalFetch = globalThis.fetch;
  const telegram = telegramFetchSpy();
  globalThis.fetch = telegram.fetch;
  try {
    let upstream = { status: 400, body: { ok: false, error: 'invalid_ack_reference' } };
    const env = {
      SIGNAGE_KV: new MemoryKv(),
      TELEGRAM_BOT_TOKEN: 'fake-token',
      TELEGRAM_CHAT_ID: 'fake-chat',
      OMNI: {
        async fetch() {
          return new Response(JSON.stringify(upstream.body), {
            status: upstream.status,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    };
    const ack = () => runRequest(new Request('https://worker.test/locations/cmd/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/140.0' },
      body: JSON.stringify({ reference: 'same-invalid-reference' }),
    }), env);

    await Promise.all(Array.from({ length: 8 }, ack));
    assert.equal(telegram.calls.length, 1, 'la ráfaga concurrente conserva el primer error y no manda ocho avisos');
    assert.match(telegram.calls[0].body.text, /400/);
    assert.match(telegram.calls[0].body.text, /POST \/locations\/cmd\/ack/);
    assertSafeSummary(telegram.calls[0].body.text, ['same-invalid-reference', 'invalid_ack_reference', 'Chrome/140.0']);

    upstream = { status: 500, body: { ok: false, error: 'upstream-failed' } };
    const serverFailure = await ack();
    assert.equal(serverFailure.status, 500);
    assert.equal(telegram.calls.length, 2, 'un 5xx distinto nunca queda oculto por el cooldown del 400');
    assert.match(telegram.calls[1].body.text, /500/);
    await ack();
    assert.equal(telegram.calls.length, 3, 'los 5xx conservan alerta inmediata incluso si se repiten');

    upstream = { status: 200, body: { ok: true, ack: true } };
    const response = await ack();
    assert.equal(response.status, 200);
    assert.equal(telegram.calls.length, 4, 'el primer éxito posterior debe anunciar recuperación');
    assert.match(telegram.calls[3].body.text, /RECUPERADO POST \/locations\/cmd\/ack/);

    await ack();
    assert.equal(telegram.calls.length, 4, 'un segundo éxito no repite recuperación');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('otros errores de negocio no heredan el rate-limit específico del ACK inválido', async () => {
  const originalFetch = globalThis.fetch;
  const telegram = telegramFetchSpy();
  globalThis.fetch = telegram.fetch;
  try {
    const env = {
      SIGNAGE_KV: new MemoryKv(),
      TELEGRAM_BOT_TOKEN: 'fake-token',
      TELEGRAM_CHAT_ID: 'fake-chat',
      OMNI: {
        async fetch() {
          return new Response(JSON.stringify({ ok: false, error: 'permission_denied' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    };
    const request = () => runRequest(new Request('https://worker.test/locations/cmd/ack', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, body: '{}',
    }), env);
    await request();
    await request();
    assert.equal(telegram.calls.length, 2);
    assert.ok(telegram.calls.every(call => /400/.test(call.body.text)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
