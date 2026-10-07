import test from 'node:test';
import assert from 'node:assert/strict';

// Límites de espera en las llamadas salientes (7-oct-2026). Si x.ai, Gemini o
// ElevenLabs no contestan, el worker corta antes que el navegador (60/90 s) y
// responde 504 {ok:false,error:'timeout',proveedor,etapa,ms}; si la imagen de x.ai
// no se puede descargar, 502 {error:'descarga_imagen'} en vez de 200 sin imagen.
import {
  LIMITES, ErrorLimite, fetchConLimite, pedirConLimite, crearPresupuesto, conReintentos,
  respuestaLimite, esReintentable,
} from '../src/fetch-limite.mjs';
import { ttsCatalog } from '../src/tts-catalog.mjs';

const worker = (await import('../src/index.js')).default;
const ORIGINALES = { ...LIMITES };
const fetchOriginal = globalThis.fetch;

// Valores de producción, comprobados antes de bajarlos para los tests.
test('límites de producción por debajo de los del cliente (60 s Grok, 90 s Gemini)', () => {
  assert.equal(ORIGINALES.grokImagen, 55000);
  assert.equal(ORIGINALES.geminiImagen, 85000);
  assert.equal(ORIGINALES.texto, 30000);
  assert.equal(ORIGINALES.descarga, 30000);
  assert.ok(ORIGINALES.grokImagen < 60000 && ORIGINALES.geminiImagen < 90000);
});

// En los tests todo vence en unos milisegundos.
function limitesCortos() {
  for (const k of Object.keys(LIMITES)) LIMITES[k] = 40;
  LIMITES.margenReintento = 0;
  LIMITES.esperaReintento = 1;
}
function restaurar() { Object.assign(LIMITES, ORIGINALES); globalThis.fetch = fetchOriginal; }

// fetch que nunca contesta pero respeta la señal, como el real.
function colgado(_url, opts = {}) {
  return new Promise((_, reject) => {
    if (opts.signal) opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}
// fetch que ignora la señal: el límite debe cortar igualmente.
const sordo = () => new Promise(() => {});
const sinRed = async () => { throw new TypeError('fetch failed'); };

// ─── Helper ────────────────────────────────────────────────────────
test('fetchConLimite: timeout → ErrorLimite tipo timeout con proveedor, etapa y ms', async () => {
  await assert.rejects(
    fetchConLimite('https://api.x.ai/x', {}, { ms: 20, proveedor: 'xai', etapa: 'imagen', fetchImpl: colgado }),
    (e) => e instanceof ErrorLimite && e.tipo === 'timeout' && e.proveedor === 'xai' && e.etapa === 'imagen' && e.ms === 20,
  );
});

test('fetchConLimite: corta aunque el fetch ignore la señal', async () => {
  const t0 = Date.now();
  await assert.rejects(fetchConLimite('u', {}, { ms: 20, proveedor: 'p', etapa: 'e', fetchImpl: sordo }), (e) => e.tipo === 'timeout');
  assert.ok(Date.now() - t0 < 1000);
});

test('fetchConLimite: error de red ≠ timeout', async () => {
  await assert.rejects(
    fetchConLimite('u', {}, { ms: 1000, proveedor: 'gemini', etapa: 'edicion', fetchImpl: sinRed }),
    (e) => e instanceof ErrorLimite && e.tipo === 'red' && /fetch failed/.test(e.message),
  );
});

test('fetchConLimite: abort del llamante → tipo abortado (no timeout)', async () => {
  const ctrl = new AbortController();
  const p = fetchConLimite('u', { signal: ctrl.signal }, { ms: 1000, proveedor: 'p', etapa: 'e', fetchImpl: colgado });
  ctrl.abort();
  await assert.rejects(p, (e) => e.tipo === 'abortado');
});

test('fetchConLimite: pasa la señal al fetch y devuelve la respuesta tal cual', async () => {
  let señal;
  const r = await fetchConLimite('u', { method: 'POST' }, { ms: 1000, fetchImpl: async (_u, o) => { señal = o.signal; assert.equal(o.method, 'POST'); return new Response('ok', { status: 201 }); } });
  assert.equal(r.status, 201);
  assert.equal(await r.text(), 'ok');
  assert.ok(señal instanceof AbortSignal);
  assert.equal(señal.aborted, false);
});

test('pedirConLimite: el límite cubre también la lectura del cuerpo', async () => {
  const cuerpoColgado = async () => new Response(new ReadableStream({ start() {} }));
  await assert.rejects(pedirConLimite('u', {}, { ms: 30, proveedor: 'xai', etapa: 'descarga', fetchImpl: cuerpoColgado }), (e) => e.tipo === 'timeout');
  const { r, datos } = await pedirConLimite('u', {}, { ms: 1000, fetchImpl: async () => new Response('no json', { status: 500 }) });
  assert.equal(r.status, 500);
  assert.deepEqual(datos, {});
});

test('respuestaLimite: 504 timeout y 502 red, con el formato que entiende el cliente', async () => {
  const t = respuestaLimite(new ErrorLimite('timeout', { proveedor: 'xai', etapa: 'imagen', ms: 55000 }));
  assert.equal(t.status, 504);
  assert.deepEqual(await t.json(), { ok: false, error: 'timeout', reason: 'timeout', proveedor: 'xai', etapa: 'imagen', ms: 55000, detail: 'xai no respondió en 55 s (imagen)' });
  const red = respuestaLimite(new ErrorLimite('red', { proveedor: 'gemini', etapa: 'edicion', causa: new TypeError('fetch failed') }));
  assert.equal(red.status, 502);
  const d = await red.json();
  assert.equal(d.error, 'red');
  assert.equal(d.reason, 'network');
  assert.equal(respuestaLimite(new Error('otro')), null);
});

// ─── Presupuesto y reintentos ──────────────────────────────────────
test('conReintentos: reintenta 429/5xx dentro del presupuesto y para al primer éxito', async () => {
  const estados = [503, 429, 200];
  let n = 0;
  const pausas = [];
  const res = await conReintentos(async () => ({ r: new Response('', { status: estados[n++] }) }), {
    presupuesto: crearPresupuesto(10000), intentos: 3, espera: 10, margen: 100, dormir: async (ms) => { pausas.push(ms); },
  });
  assert.equal(res.r.status, 200);
  assert.equal(n, 3);
  assert.deepEqual(pausas, [10, 20]);
});

test('conReintentos: no reintenta si no queda presupuesto ni errores que no son 429/5xx', async () => {
  let reloj = 0;
  const presupuesto = crearPresupuesto(1000, () => reloj);
  let n = 0;
  const agotado = await conReintentos(async () => { n++; reloj += 950; return { r: new Response('', { status: 503 }) }; }, {
    presupuesto, intentos: 3, espera: 10, margen: 100, dormir: async () => {},
  });
  assert.equal(agotado.r.status, 503);
  assert.equal(n, 1, 'con 50 ms restantes y 100 ms de margen no se reintenta');
  n = 0;
  const rechazo = await conReintentos(async () => { n++; return { r: new Response('', { status: 400 }) }; }, { presupuesto: crearPresupuesto(10000), intentos: 3, dormir: async () => {} });
  assert.equal(rechazo.r.status, 400);
  assert.equal(n, 1);
  assert.equal(esReintentable(500), true);
  assert.equal(esReintentable(404), false);
});

test('pedirConLimite con presupuesto: corta con lo que queda e informa del total', async () => {
  let reloj = 0;
  const presupuesto = crearPresupuesto(55000, () => reloj);
  reloj = 54980; // quedan 20 ms aunque la descarga admita 30 s
  const t0 = Date.now();
  await assert.rejects(
    pedirConLimite('u', {}, { ms: 30000, presupuesto, proveedor: 'xai', etapa: 'descarga', fetchImpl: colgado }),
    (e) => e.tipo === 'timeout' && e.ms === 55000,
  );
  assert.ok(Date.now() - t0 < 1000);
});

test('crearPresupuesto: tramo nunca supera lo que queda', () => {
  let reloj = 0;
  const p = crearPresupuesto(55000, () => reloj);
  assert.equal(p.tramo(30000), 30000);
  reloj = 40000;
  assert.equal(p.tramo(30000), 15000);
  reloj = 60000;
  assert.equal(p.restante(), 0);
});

// ─── Rutas del worker ──────────────────────────────────────────────
const ENV = { XAI_KEY: 'xai-fixture', GEMINI_API_KEY: 'gemini-fixture', ELEVENLABS_KEY: 'eleven-fixture', POLLINATIONS_KEY: 'poll-fixture', FLEET_KEY: 'flota-fixture' };
const ctx = { waitUntil() {} };
function pedir(path, { method = 'POST', body } = {}) {
  const headers = { 'X-Fleet-Key': ENV.FLEET_KEY, Origin: 'https://www.pixeria.com' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request('https://api.admira.store' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), ENV, ctx);
}
// Router de fetch simulado por prefijo de URL; lo no previsto falla en alto.
function simular(rutas) {
  const llamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    llamadas.push(u);
    for (const [prefijo, fn] of rutas) if (u.startsWith(prefijo)) return fn(u, opts);
    throw new Error('red prohibida en tests: ' + u);
  };
  return llamadas;
}

const RUTAS_COLGADAS = [
  { nombre: 'Grok imagen', path: '/xai/image', body: { prompt: 'p', b64: true }, proveedor: 'xai', etapa: 'imagen' },
  { nombre: 'Gemini edición (Anonimizador)', path: '/image/edit', body: { prompt: 'p', image: 'data:image/png;base64,AAAA' }, proveedor: 'gemini', etapa: 'edicion' },
  { nombre: 'Imagen 4', path: '/imagen/generate', body: { prompt: 'p' }, proveedor: 'gemini', etapa: 'imagen' },
  { nombre: 'Lyria 3', path: '/lyria3/generate', body: { prompt: 'p' }, proveedor: 'gemini', etapa: 'lyria3' },
  { nombre: 'Grok vídeo inicio', path: '/xai/video', body: { prompt: 'p' }, proveedor: 'xai', etapa: 'video-inicio' },
  { nombre: 'Grok vídeo sondeo', path: '/xai/video/req_12345678', method: 'GET', proveedor: 'xai', etapa: 'video-sondeo' },
  { nombre: 'Veo inicio', path: '/veo/generate', body: { prompt: 'p' }, proveedor: 'gemini', etapa: 'veo-inicio' },
  { nombre: 'Veo sondeo', path: '/veo/status/operations/abc', method: 'GET', proveedor: 'gemini', etapa: 'veo-sondeo' },
  { nombre: 'Veo descarga', path: '/veo/download?uri=' + encodeURIComponent('https://generativelanguage.googleapis.com/v1beta/files/x:download'), method: 'GET', proveedor: 'gemini', etapa: 'veo-descarga' },
  { nombre: 'ElevenLabs TTS', path: '/tts', body: { text: 'hola' }, proveedor: 'elevenlabs', etapa: 'tts' },
  { nombre: 'ElevenLabs catálogo', path: '/tts/catalog', method: 'GET', proveedor: 'elevenlabs', etapa: 'catalogo' },
  { nombre: 'Pollinations vídeo', path: '/pvideo?prompt=p', method: 'GET', proveedor: 'pollinations', etapa: 'video' },
  { nombre: 'Proxy de imagen', path: '/image/proxy?url=' + encodeURIComponent('https://example.com/a.jpg'), method: 'GET', proveedor: 'example.com', etapa: 'descarga' },
];

for (const caso of RUTAS_COLGADAS) {
  test(`${caso.nombre}: proveedor que no responde → 504 timeout (${caso.proveedor}/${caso.etapa})`, async (t) => {
    limitesCortos();
    t.after(restaurar);
    simular([['https://', colgado]]);
    const t0 = Date.now();
    const res = await pedir(caso.path, { method: caso.method || 'POST', body: caso.body });
    assert.ok(Date.now() - t0 < 2000, 'responde en cuanto vence el límite');
    assert.equal(res.status, 504);
    const d = await res.json();
    assert.equal(d.ok, false);
    assert.equal(d.error, 'timeout');
    assert.equal(d.reason, 'timeout');
    assert.equal(d.proveedor, caso.proveedor);
    assert.equal(d.etapa, caso.etapa);
    assert.equal(d.ms, 40);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://www.pixeria.com');
  });
}

test('Grok imagen: error de red → 502 red (no 500 worker-exception)', async (t) => {
  limitesCortos();
  t.after(restaurar);
  simular([['https://', sinRed]]);
  const res = await pedir('/xai/image', { body: { prompt: 'p', b64: true } });
  assert.equal(res.status, 502);
  const d = await res.json();
  assert.equal(d.error, 'red');
  assert.equal(d.proveedor, 'xai');
});

const xaiConUrl = () => Response.json({ data: [{ url: 'https://imgen.x.ai/out.jpg' }] });

test('Grok imagen: la descarga de x.ai se cuelga → 504 etapa descarga', async (t) => {
  limitesCortos();
  t.after(restaurar);
  simular([['https://api.x.ai/', xaiConUrl], ['https://imgen.x.ai/', colgado]]);
  const res = await pedir('/xai/image', { body: { prompt: 'p', b64: true } });
  assert.equal(res.status, 504);
  const d = await res.json();
  assert.equal(d.error, 'timeout');
  assert.equal(d.etapa, 'descarga');
});

for (const [motivo, descarga] of [
  ['404', async () => new Response('gone', { status: 404 })],
  ['error de red', sinRed],
  ['cuerpo vacío', async () => new Response(new Uint8Array(0), { status: 200 })],
]) {
  test(`Grok imagen: descarga de x.ai fallida (${motivo}) → 502 descarga_imagen, no 200 sin imagen`, async (t) => {
    t.after(restaurar);
    simular([['https://api.x.ai/', xaiConUrl], ['https://imgen.x.ai/', descarga]]);
    const res = await pedir('/xai/image', { body: { prompt: 'p', b64: true } });
    assert.equal(res.status, 502);
    const d = await res.json();
    assert.equal(d.ok, false);
    assert.equal(d.error, 'descarga_imagen');
    assert.equal(d.reason, 'no-data');
    assert.equal(d.proveedor, 'xai');
    assert.equal(d.etapa, 'descarga');
    assert.ok(d.detail);
  });
}

test('Grok imagen: varias imágenes y una sin descargar → solo las que llegaron', async (t) => {
  t.after(restaurar);
  simular([
    ['https://api.x.ai/', () => Response.json({ data: [{ url: 'https://imgen.x.ai/mala.jpg' }, { url: 'https://imgen.x.ai/buena.jpg' }] })],
    ['https://imgen.x.ai/mala', async () => new Response('', { status: 500 })],
    ['https://imgen.x.ai/buena', async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })],
  ]);
  const res = await pedir('/xai/image', { body: { prompt: 'p', b64: true, n: 2 } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.data.length, 1);
  assert.equal(d.data[0].b64_json, 'AQID');
  assert.equal(d.data[0].mime, 'image/png');
});

test('Grok imagen: 503 de x.ai se reintenta dentro del presupuesto', async (t) => {
  limitesCortos();
  LIMITES.grokImagen = 2000;
  t.after(restaurar);
  let n = 0;
  const llamadas = simular([['https://api.x.ai/', async () => (++n === 1 ? Response.json({ error: 'busy' }, { status: 503 }) : Response.json({ data: [{ b64_json: 'QQ==' }] }))]]);
  const res = await pedir('/xai/image', { body: { prompt: 'p', b64: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: [{ b64_json: 'QQ==' }] });
  assert.equal(llamadas.length, 2);
});

test('Grok imagen: sin presupuesto para reintentar, devuelve el 503 tal cual y una sola llamada', async (t) => {
  limitesCortos();
  LIMITES.grokImagen = 2000;
  LIMITES.margenReintento = 5000; // nunca quedan 5 s de un presupuesto de 2 s
  t.after(restaurar);
  const llamadas = simular([['https://api.x.ai/', async () => Response.json({ error: 'busy' }, { status: 503 })]]);
  const res = await pedir('/xai/image', { body: { prompt: 'p', b64: true } });
  assert.equal(res.status, 503);
  assert.equal(llamadas.length, 1);
});

test('Grok imagen: los reintentos comparten el presupuesto total (no 55 s por intento)', async (t) => {
  limitesCortos();
  LIMITES.grokImagen = 120;
  t.after(restaurar);
  let n = 0;
  simular([['https://api.x.ai/', async (_u, o) => (++n === 1
    ? new Promise((resolve) => setTimeout(() => resolve(Response.json({}, { status: 503 })), 60))
    : colgado(_u, o))]]);
  const t0 = Date.now();
  const res = await pedir('/xai/image', { body: { prompt: 'p', b64: true } });
  const ms = Date.now() - t0;
  assert.equal(res.status, 504);
  assert.equal((await res.json()).etapa, 'imagen-reintento');
  assert.ok(ms < 400, `el reintento vence con el presupuesto restante (${ms} ms)`);
});

test('Gemini edición: 503 y luego imagen → éxito con el mismo contrato', async (t) => {
  limitesCortos();
  LIMITES.geminiImagen = 2000;
  t.after(restaurar);
  let n = 0;
  simular([['https://generativelanguage.googleapis.com/', async () => (++n === 1
    ? Response.json({ error: { message: 'high demand' } }, { status: 503 })
    : Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] } }] }))]]);
  const res = await pedir('/image/edit', { body: { prompt: 'p', image: 'data:image/png;base64,AAAA' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, image: 'data:image/png;base64,QUJD', mime: 'image/png' });
  assert.equal(n, 2);
});

test('éxito sin cambios: Grok b64 directo, URL descargada y rechazo de Gemini intactos', async (t) => {
  t.after(restaurar);
  simular([['https://api.x.ai/', async () => Response.json({ data: [{ b64_json: 'QQ==', revised_prompt: 'r' }] })]]);
  let res = await pedir('/xai/image', { body: { prompt: 'p', b64: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: [{ b64_json: 'QQ==', revised_prompt: 'r' }] });

  simular([['https://api.x.ai/', xaiConUrl], ['https://imgen.x.ai/', async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } })]]);
  res = await pedir('/xai/image', { body: { prompt: 'p', b64: true } });
  assert.deepEqual(await res.json(), { data: [{ url: 'https://imgen.x.ai/out.jpg', b64_json: 'AQID', mime: 'image/jpeg' }] });

  simular([['https://api.x.ai/', xaiConUrl]]);
  res = await pedir('/xai/image', { body: { prompt: 'p' } });
  assert.equal(res.status, 200, 'sin b64 no se descarga nada');
  assert.deepEqual(await res.json(), { data: [{ url: 'https://imgen.x.ai/out.jpg' }] });

  simular([['https://generativelanguage.googleapis.com/', async () => Response.json({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] })]]);
  res = await pedir('/image/edit', { body: { prompt: 'p', image: 'data:image/png;base64,AAAA' } });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, 'safety');
});

test('ttsCatalog: ElevenLabs colgado → ErrorLimite (el router lo convierte en 504)', async (t) => {
  limitesCortos();
  t.after(restaurar);
  await assert.rejects(ttsCatalog({ ELEVENLABS_KEY: 'k' }, colgado), (e) => e instanceof ErrorLimite && e.tipo === 'timeout' && e.etapa === 'catalogo');
});
