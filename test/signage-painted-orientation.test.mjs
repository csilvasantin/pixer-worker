import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeDeviceTelemetry, signageNowGetHandler, signageNowPostHandler } from '../src/index.js';

// Creador de incidencias · formato girado (DCL-34d5bbccb9cc227bb752a419). El canal declara en
// device.display lo que MIDE que pinta (paintedRotation, painted) y el giro del operador
// (rotation, fit). Antes la allowlist los descartaba: ni el mando veía el giro confirmado ni el
// detector podía comparar la orientación pintada con la que espera el plano.

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

const PANEL = { width: 3456, height: 2234, cssWidth: 1728, cssHeight: 1117, viewportWidth: 1728, viewportHeight: 1117, devicePixelRatio: 2, colorDepth: 30, orientation: 'landscape-primary' };

function beat(display) {
  return new Request('https://api.admira.store/signage/now', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'AdmiraMacOSPlayer/1.7.5' },
    body: JSON.stringify({ screen: 'macbookpro16', producer: 'p-mbp16', loc: 'osx', machine: 'macbookpro16', role: 'canal', version: 'v.14.10.2026.r6.12:00',
      item: { id: 'starbucks-1', type: 'video', url: 'https://api.admira.store/stock/asset/starbucks-1' },
      device: { display: { ...PANEL, ...display } } }),
  });
}

test('display conserva el giro del operador, el ajuste y lo que el player mide que pinta', () => {
  const device = sanitizeDeviceTelemetry({ display: { ...PANEL, rotation: 0, fit: 'editorial', paintedRotation: 90, painted: 'vertical', fault: 'rotate', lab: true } });
  assert.deepEqual(device.display, { ...PANEL, rotation: 0, fit: 'editorial', paintedRotation: 90, painted: 'vertical' });
  assert.equal('fault' in device.display, false, 'nada fuera de la allowlist');
});

test('giro en cuartos de vuelta, orientación sólo horizontal | vertical y ajuste sólo editorial | fill | cover', () => {
  const d = (display) => (sanitizeDeviceTelemetry({ display }) || {}).display || {};
  assert.equal(d({ rotation: 270 }).rotation, 270);
  assert.equal(d({ rotation: '90' }).rotation, 90);
  for (const bad of [45, -90, 360, null, '', true, 'noventa']) assert.equal('rotation' in d({ rotation: bad }), false, String(bad));
  assert.equal(d({ painted: 'horizontal' }).painted, 'horizontal');
  for (const fit of ['editorial', 'fill', 'cover']) assert.equal(d({ fit }).fit, fit);
  for (const bad of ['Fill', 'stretch', '<b>x</b>', 1, null]) assert.equal('fit' in d({ fit: bad }), false, String(bad));
  for (const bad of ['Horizontal', 'landscape', 'diagonal', 1, null]) assert.equal('painted' in d({ painted: bad }), false, String(bad));
});

test('un giro cambia la firma y se publica al momento; el mismo estado no gasta escritura', async () => {
  const env = memoryEnv();
  await signageNowPostHandler(beat({ rotation: 0, paintedRotation: 0, painted: 'horizontal' }), env);
  const same = await (await signageNowPostHandler(beat({ rotation: 0, paintedRotation: 0, painted: 'horizontal' }), env)).json();
  assert.equal(same.throttled, 'unchanged');

  const turned = await (await signageNowPostHandler(beat({ rotation: 0, paintedRotation: 90, painted: 'vertical' }), env)).json();
  assert.equal(turned.throttled, undefined, 'pintar girado es un cambio real');
  const now = await (await signageNowGetHandler(null, env, new URL('https://api.admira.store/signage/now?screen=macbookpro16'))).json();
  assert.equal(now.device.display.painted, 'vertical');
  assert.equal(now.device.display.paintedRotation, 90);
  assert.equal(now.device.display.rotation, 0);
});
