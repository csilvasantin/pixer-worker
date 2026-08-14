import test from 'node:test';
import assert from 'node:assert/strict';

import { signageNowPostHandler } from '../src/index.js';

function envWithExhaustedGeneralBudget() {
  const values = new Map();
  const today = new Date().toISOString().slice(0, 10);
  values.set(`kvbudget:${today}`, '22000');
  return {
    KV_DAILY_WRITE_CAP: '22000',
    KV_CRITICAL_DAILY_WRITE_CAP: '10000',
    SIGNAGE_KV: {
      async get(key, type) {
        const raw = values.get(key) ?? null;
        return type === 'json' && raw ? JSON.parse(raw) : raw;
      },
      async put(key, value) { values.set(key, String(value)); },
    },
    STOCK_BUCKET: {
      async put() {},
      async head() { return null; },
    },
    values,
  };
}

function nativeBeat(itemId = 'white-rabbit') {
  return new Request('https://api.admira.store/signage/now', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'AdmiraMacOSPlayer/1.7 (MacMini) Safari' },
    body: JSON.stringify({
      screen: 'admiranext-mupi', producer: 'player-macmini', machine: 'macmini',
      loc: 'admiranext', locName: 'GrandeGracia', role: 'canal', version: '1.7',
      item: { id: itemId, type: 'video', url: `https://cdn.example/${itemId}.mp4`, dur: 30 },
    }),
  });
}

test('el CMS conserva la presencia aunque el presupuesto general esté agotado', async () => {
  const env = envWithExhaustedGeneralBudget();
  const response = await signageNowPostHandler(nativeBeat(), env);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.equal(body.throttled, 'budget');
  assert.equal(body.presence, true);
  assert.ok(env.values.has('screen:admiranext-mupi'), 'la presencia entra en la reserva crítica');
  assert.ok(env.values.has('signage_screens_index'), 'la pantalla queda indexada para /signage/screens');
  assert.equal(env.values.has('now:admiranext-mupi'), false, 'el puntero no evade el presupuesto general');
});

test('un cambio de canción no consume otra escritura crítica de presencia', async () => {
  const env = envWithExhaustedGeneralBudget();
  await signageNowPostHandler(nativeBeat('white-rabbit'), env);
  const today = new Date().toISOString().slice(0, 10);
  const afterFirst = env.values.get(`kvcritical:${today}`);

  await signageNowPostHandler(nativeBeat('matrix-credits'), env);
  assert.equal(env.values.get(`kvcritical:${today}`), afterFirst);
});
