import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeDeviceTelemetry, signageNowGetHandler, signageNowPostHandler } from '../src/index.js';

// Bugito · banco de pruebas del Creador de incidencias (DCL-5da4653d859552490fd5ae1d). El canal
// declara en device.display tres medidas más de lo que pinta, sin marca de prueba:
//   canvas  {w,h}  lienzo medido (px CSS)            → detector «cambio de resolución»
//   overlay 0..100 % de la emisión tapado por capas  → detector «popup encima del contenido»
//   visible 0..100 % del lienzo donde se ve contenido → detector «pantalla a medio abrir»
// Tipos estrictos: lo que no tenga la forma exacta no se guarda.

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

const PANEL = { width: 1600, height: 900, cssWidth: 1600, cssHeight: 900, viewportWidth: 1600, viewportHeight: 900, devicePixelRatio: 1, colorDepth: 24, orientation: 'landscape-primary' };
const d = (display) => (sanitizeDeviceTelemetry({ display }) || {}).display || {};

function beat(display) {
  return new Request('https://api.admira.store/signage/now', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen: 'virtual-lab-bugito', producer: 'p-bugito', loc: 'virtual-lab-bugito', role: 'canal', version: 'v.14.10.2026.r9.18:00',
      item: { id: 'pieza-1', type: 'image', url: 'https://api.admira.store/stock/asset/pieza-1' },
      device: { display: { ...PANEL, rotation: 0, fit: 'fill', paintedRotation: 0, painted: 'horizontal', ...display } } }),
  });
}

test('display guarda el lienzo medido y los porcentajes tapado y visible', () => {
  const device = sanitizeDeviceTelemetry({ display: { ...PANEL, canvas: { w: 506.4, h: 900 }, overlay: 37.6, visible: 100, popup: true, fault: 'canvas' } });
  assert.deepEqual(device.display, { ...PANEL, canvas: { w: 506, h: 900 }, overlay: 38, visible: 100 });
  assert.equal('popup' in device.display, false, 'nada fuera de la allowlist');
});

test('canvas sólo {w,h} numéricos positivos; extras fuera', () => {
  assert.deepEqual(d({ canvas: { w: 1600, h: 900, x: 3, fault: 1 } }).canvas, { w: 1600, h: 900 });
  for (const bad of [null, '1600x900', [1600, 900], { w: '1600', h: 900 }, { w: 0, h: 900 }, { w: -1, h: 900 }, { w: 1600 }, { w: NaN, h: 900 }, { w: 1e9, h: 900 }]) {
    assert.equal('canvas' in d({ canvas: bad }), false, JSON.stringify(bad));
  }
});

test('overlay y visible: número entre 0 y 100, entero', () => {
  assert.equal(d({ overlay: 0 }).overlay, 0);
  assert.equal(d({ visible: 49.5 }).visible, 50);
  for (const bad of [-1, 101, '40', null, true, NaN, Infinity]) {
    assert.equal('overlay' in d({ overlay: bad }), false, String(bad));
    assert.equal('visible' in d({ visible: bad }), false, String(bad));
  }
});

test('un popup cambia la firma y se publica; el mismo estado no gasta escritura', async () => {
  const env = memoryEnv();
  const base = { canvas: { w: 1600, h: 900 }, overlay: 0, visible: 100 };
  await signageNowPostHandler(beat(base), env);
  const same = await (await signageNowPostHandler(beat(base), env)).json();
  assert.equal(same.throttled, 'unchanged');
  const tapada = await (await signageNowPostHandler(beat({ ...base, overlay: 38 }), env)).json();
  assert.equal(tapada.throttled, undefined, 'una capa encima es un cambio real');
  const media = await (await signageNowPostHandler(beat({ ...base, overlay: 38, visible: 50, canvas: { w: 506, h: 900 } }), env)).json();
  assert.equal(media.throttled, undefined);
  const now = await (await signageNowGetHandler(null, env, new URL('https://api.admira.store/signage/now?screen=virtual-lab-bugito'))).json();
  assert.deepEqual(now.device.display.canvas, { w: 506, h: 900 });
  assert.equal(now.device.display.overlay, 38);
  assert.equal(now.device.display.visible, 50);
});

test('medidas que bailan sin cruzar umbral no escriben: la firma sólo ve orientación del lienzo y umbrales', async () => {
  const env = memoryEnv();
  let puts = 0;
  const put = env.SIGNAGE_KV.put.bind(env.SIGNAGE_KV);
  env.SIGNAGE_KV.put = async (k, v) => { if (k.startsWith('now:')) puts++; return put(k, v); };
  // Editorial: el marco medido a mitad de la transición (.35 s) y al final; tapado 0→4 %, visible 100→93 %.
  await signageNowPostHandler(beat({ canvas: { w: 1180, h: 664 }, overlay: 0, visible: 100 }), env);
  const baila = await (await signageNowPostHandler(beat({ canvas: { w: 1600, h: 900 }, overlay: 4, visible: 93 }), env)).json();
  assert.equal(baila.throttled, 'unchanged', 'sin cruzar umbral: no escribe');
  assert.equal(puts, 1, 'una sola escritura');
  // Cruzar un umbral sí es un cambio real.
  const cruza = await (await signageNowPostHandler(beat({ canvas: { w: 1600, h: 900 }, overlay: 12, visible: 93 }), env)).json();
  assert.equal(cruza.throttled, undefined); assert.equal(puts, 2);
  const media = await (await signageNowPostHandler(beat({ canvas: { w: 1600, h: 900 }, overlay: 12, visible: 50 }), env)).json();
  assert.equal(media.throttled, undefined); assert.equal(puts, 3);
  const vertical = await (await signageNowPostHandler(beat({ canvas: { w: 506, h: 900 }, overlay: 12, visible: 50 }), env)).json();
  assert.equal(vertical.throttled, undefined, 'el lienzo cambia de orientación'); assert.equal(puts, 4);
  // El valor medido se guarda tal cual (la firma es lo único cuantizado).
  const now = await (await signageNowGetHandler(null, env, new URL('https://api.admira.store/signage/now?screen=virtual-lab-bugito'))).json();
  assert.deepEqual(now.device.display.canvas, { w: 506, h: 900 }); assert.equal(now.device.display.overlay, 12); assert.equal(now.device.display.visible, 50);
});
