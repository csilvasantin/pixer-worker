import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeDeviceTelemetry, sanitizeHealth, signageNowGetHandler, signageNowPostHandler } from '../src/index.js';

// Player de tinta electrónica (role 'eink'): /signage/now debe guardar device.eink
// y health en vez de descartarlos (el puente los colaba como texto en version).

function memoryEnv() {
  const values = new Map();
  return {
    SIGNAGE_KV: {
      async get(key) { return values.has(key) ? values.get(key) : null; },
      async put(key, value) { values.set(key, String(value)); },
    },
    STOCK_BUCKET: { async put() {}, async head() { return null; } },
    values,
  };
}

function einkBeat(eink = {}, health = { ok: true, status: 'ok', error: null }) {
  return new Request('https://api.admira.store/signage/now', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'AdmiraEinkBridge/1.0 (+admira.tv player eink)' },
    body: JSON.stringify({
      screen: 'eink-sy11-ab', producer: 'p-eink-eink-sy11-ab-macbookpro16', machine: 'MacBookPro16',
      loc: 'eink', locName: 'Tinta electrónica · SY11-ab', role: 'eink', version: 'eink-bridge v.10.10.2026.r1.16:45',
      standby: false, health,
      item: { id: 'pieza-1453', num: 1453, type: 'image', url: 'https://api.admira.store/stock/asset/pieza-1453' },
      device: {
        display: { width: 480, height: 800, colorDepth: 2, orientation: 'portrait-primary' },
        eink: Object.assign({
          type: 'eink', model: 'SY11-ab', mac: 'FF:FF:FF:10:B4:B6', firmware: 'SY11-014', resolution: '480x800',
          palette: ['black', 'white', 'yellow', 'red'], imageOnly: true, slowRefresh: true, battery: null,
          status: 'ok', lastSendAt: '2026-10-10T16:36:56+0200', lastError: null, sends: 3, paused: false, pin: 1453,
          bridge: 'MacBookPro16', intruso: { a: 1 },
        }, eink),
      },
    }),
  });
}

test('device.eink se conserva por allowlist y la batería no informada no se convierte en 0', () => {
  const device = sanitizeDeviceTelemetry({ eink: {
    type: 'eink', model: 'SY11-ab', firmware: 'SY11-014', resolution: '480x800', palette: ['black', 'white', 'yellow', 'red'],
    imageOnly: true, slowRefresh: true, battery: null, status: 'ok', lastSendAt: '2026-10-10T16:36:56+0200',
    lastError: null, sends: 3, paused: false, pin: 1453, mac: 'FF:FF', intruso: { a: 1 },
  } });
  assert.deepEqual(device.eink, {
    type: 'eink', model: 'SY11-ab', firmware: 'SY11-014', resolution: '480x800', palette: ['black', 'white', 'yellow', 'red'],
    imageOnly: true, slowRefresh: true, status: 'ok', lastSendAt: '2026-10-10T16:36:56+0200', sends: 3, paused: false, pin: 1453,
  });
  assert.equal(sanitizeDeviceTelemetry({ eink: { battery: 87 } }).eink.battery, 87);
  assert.equal(sanitizeDeviceTelemetry({ eink: { palette: 'black' } }), null, 'la paleta sólo se acepta como lista');
});

test('los grupos clásicos no cambian: un número nulo sigue el contrato anterior', () => {
  assert.deepEqual(sanitizeDeviceTelemetry({ hardware: { cores: null, touchPoints: 0 } }), { hardware: { cores: 0, touchPoints: 0 } });
});

test('health se acepta por allowlist', () => {
  assert.deepEqual(sanitizeHealth({ ok: false, status: 'error', error: 'BLE timeout', extra: 1 }), { ok: false, status: 'error', error: 'BLE timeout' });
  assert.deepEqual(sanitizeHealth({ ok: true, status: 'ok', error: null }), { ok: true, status: 'ok' });
  assert.equal(sanitizeHealth('ok'), null);
});

test('el latido eink guarda device.eink y health en el puntero y en el censo', async () => {
  const env = memoryEnv();
  const posted = await (await signageNowPostHandler(einkBeat(), env)).json();
  assert.equal(posted.ok, true);

  const now = await (await signageNowGetHandler(null, env, new URL('https://api.admira.store/signage/now?screen=eink-sy11-ab'))).json();
  assert.equal(now.device.eink.model, 'SY11-ab');
  assert.equal(now.device.eink.lastSendAt, '2026-10-10T16:36:56+0200');
  assert.equal(now.device.eink.pin, 1453);
  assert.equal('battery' in now.device.eink, false);
  assert.equal('mac' in now.device.eink, false);
  assert.deepEqual(now.health, { ok: true, status: 'ok' });

  const census = JSON.parse(env.values.get('screen:eink-sy11-ab'));
  assert.equal(census.role, 'eink');
  assert.equal(census.device.eink.status, 'ok');
  assert.deepEqual(census.health, { ok: true, status: 'ok' });
});

test('un envío nuevo o un error se reflejan al momento, sin esperar al refresco', async () => {
  const env = memoryEnv();
  await signageNowPostHandler(einkBeat(), env);
  const same = await (await signageNowPostHandler(einkBeat(), env)).json();
  assert.equal(same.throttled, 'unchanged', 'el mismo estado no reescribe KV');

  await signageNowPostHandler(einkBeat(
    { status: 'error', lastError: 'BLE: dispositivo no encontrado', lastSendAt: '2026-10-10T16:51:56+0200', sends: 4 },
    { ok: false, status: 'error', error: 'BLE: dispositivo no encontrado' },
  ), env);
  const now = JSON.parse(env.values.get('now:eink-sy11-ab'));
  assert.equal(now.device.eink.status, 'error');
  assert.equal(now.health.ok, false);
  const census = JSON.parse(env.values.get('screen:eink-sy11-ab'));
  assert.equal(census.device.eink.lastError, 'BLE: dispositivo no encontrado');
  assert.equal(census.health.status, 'error');
});

test('un player clásico sin eink ni health no cambia de forma', async () => {
  const env = memoryEnv();
  await signageNowPostHandler(new Request('https://api.admira.store/signage/now', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/151' },
    body: JSON.stringify({ screen: 'admiranext-mupi', producer: 'chrome-a', loc: 'admiranext', role: 'canal', version: '1.7',
      item: { id: 'a', type: 'video', url: 'https://cdn.example/a.mp4' }, device: { display: { width: 1080, height: 1920 } } }),
  }), env);
  const now = JSON.parse(env.values.get('now:admiranext-mupi'));
  assert.equal(now.health, null);
  assert.deepEqual(now.device, { display: { width: 1080, height: 1920 } });
});
