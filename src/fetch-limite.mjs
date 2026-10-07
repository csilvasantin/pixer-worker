// Límites de espera para las llamadas salientes del worker (7-oct-2026, SubMorfeoMacMini).
//
// Por qué existe: si x.ai, Gemini, ElevenLabs… no contestaban, el fetch se quedaba
// colgado y el navegador acababa cortando por su cuenta (Anonimizador: 60 s Grok,
// 90 s Gemini) sin saber qué había pasado. Ahora cada llamada lleva un límite
// propio, por debajo del del cliente, y el worker responde ANTES con un motivo claro:
//
//   · 504 {ok:false, error:'timeout', reason:'timeout', proveedor, etapa, ms, detail}
//   · 502 {ok:false, error:'red', reason:'network', proveedor, etapa, detail}
//
// fetchConLimite() cubre hasta las cabeceras (para respuestas que se reenvían en
// streaming: audio, vídeo). pedirConLimite() cubre además la lectura del cuerpo,
// que es donde también se puede colgar una respuesta lenta.
// Funciona igual en Workers y en Node (node --test).

// Límites en milisegundos. Es un objeto mutable a propósito: los tests lo bajan a
// unos pocos ms para comprobar los cortes sin esperar de verdad.
export const LIMITES = {
  grokImagen: 55000,     // /xai/image: generación + descarga (cliente: 60 s)
  geminiImagen: 85000,   // /image/edit, /imagen/generate, /segmentado (cliente: 90 s)
  grokEdicion: 85000,    // x.ai images/edits (gemelo persistente)
  texto: 30000,          // chat / texto (Gemini, Grok)
  textoLargo: 45000,     // cápsula de un artículo entero (entrada larga, con razonamiento)
  descarga: 30000,       // descarga de assets (imagen generada, grid, proxy, fuente)
  videoInicio: 30000,    // arranque asíncrono (x.ai video, Veo): solo encola
  videoSondeo: 20000,    // cada sondeo de estado; el cliente vuelve a sondear
  videoDescarga: 30000,  // hasta cabeceras; el cuerpo se reenvía en streaming
  videoSincrono: 180000, // Pollinations genera el mp4 en la misma petición
  voz: 60000,            // ElevenLabs TTS (genera el audio entero antes de responder)
  musica: 120000,        // Lyria (Vertex / Gemini API)
  doblaje: 120000,       // ElevenLabs dubbing (sube el vídeo en la petición)
  catalogo: 30000,       // metadatos (ElevenLabs catálogo)
  auth: 10000,           // token de GCP / verificación de sesión Pixeria
  corto: 10000,          // trozos de TTS gratuito y lectura de etiquetas og: de una página
  margenReintento: 15000, // tiempo mínimo que debe quedar para que un reintento tenga sentido
  esperaReintento: 1500   // pausa antes del reintento por 429/5xx (×n en cada intento)
};

export class ErrorLimite extends Error {
  constructor(tipo, { proveedor = 'desconocido', etapa = 'llamada', ms = 0, causa = null } = {}) {
    const s = Math.round(ms / 1000);
    super(tipo === 'timeout'
      ? `${proveedor} no respondió en ${s} s (${etapa})`
      : tipo === 'abortado'
        ? `${proveedor}: llamada cancelada (${etapa})`
        : `${proveedor} inaccesible (${etapa}): ${String((causa && causa.message) || causa || 'error de red').slice(0, 160)}`);
    this.name = 'ErrorLimite';
    this.tipo = tipo;          // 'timeout' | 'red' | 'abortado'
    this.proveedor = proveedor;
    this.etapa = etapa;
    this.ms = ms;
    this.causa = causa;
  }
}

export function esErrorLimite(e) {
  return !!e && (e instanceof ErrorLimite || e.name === 'ErrorLimite');
}

// Respuesta JSON del worker para un ErrorLimite (o null si no lo es).
export function respuestaLimite(e) {
  if (!esErrorLimite(e)) return null;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (e.tipo === 'timeout') {
    return new Response(JSON.stringify({ ok: false, error: 'timeout', reason: 'timeout', proveedor: e.proveedor, etapa: e.etapa, ms: e.ms, detail: e.message }), { status: 504, headers });
  }
  if (e.tipo === 'abortado') {
    return new Response(JSON.stringify({ ok: false, error: 'abortado', proveedor: e.proveedor, etapa: e.etapa, detail: e.message }), { status: 499, headers });
  }
  return new Response(JSON.stringify({ ok: false, error: 'red', reason: 'network', proveedor: e.proveedor, etapa: e.etapa, detail: e.message }), { status: 502, headers });
}

// Ejecuta fn(); si lanza un ErrorLimite lo convierte en su respuesta JSON.
export async function conLimite(fn) {
  try { return await fn(); }
  catch (e) { const r = respuestaLimite(e); if (r) return r; throw e; }
}

function errorAbort() {
  try { return new DOMException('The operation was aborted.', 'AbortError'); }
  catch { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; }
}

// Núcleo: corre trabajo(signal) con un límite. Aborta la petición al vencer y,
// aunque la implementación de fetch ignorase la señal, la carrera con el
// temporizador garantiza que nunca se espera más de `ms`.
async function conPlazo(trabajo, { ms, presupuesto, proveedor, etapa, signal: externa } = {}) {
  // Con presupuesto, la llamada dura como mucho lo que quede de él (o `ms`, si es
  // menor) y el error informa del presupuesto TOTAL, que es lo que ve el cliente.
  const pedido = presupuesto ? Math.min(ms == null ? Infinity : Number(ms) || 0, presupuesto.restante()) : ms;
  const limite = Math.max(1, Math.floor(Number(pedido) || 0));
  const informe = presupuesto ? presupuesto.total : limite;
  const ctrl = new AbortController();
  let vencido = false, timer = null, alAbortarFuera = null;
  const corte = new Promise((_, reject) => {
    timer = setTimeout(() => {
      vencido = true;
      ctrl.abort(errorAbort());
      reject(new ErrorLimite('timeout', { proveedor, etapa, ms: informe }));
    }, limite);
    if (externa) {
      alAbortarFuera = () => { ctrl.abort(errorAbort()); reject(new ErrorLimite('abortado', { proveedor, etapa, ms: informe })); };
      if (externa.aborted) alAbortarFuera(); else externa.addEventListener('abort', alAbortarFuera, { once: true });
    }
  });
  corte.catch(() => {});
  try {
    return await Promise.race([trabajo(ctrl.signal), corte]);
  } catch (e) {
    if (esErrorLimite(e)) throw e;
    if (vencido) throw new ErrorLimite('timeout', { proveedor, etapa, ms: informe, causa: e });
    if (externa && externa.aborted) throw new ErrorLimite('abortado', { proveedor, etapa, ms: informe, causa: e });
    throw new ErrorLimite('red', { proveedor, etapa, ms: informe, causa: e });
  } finally {
    clearTimeout(timer);
    if (externa && alAbortarFuera) externa.removeEventListener('abort', alAbortarFuera);
  }
}

// fetch con límite hasta las CABECERAS. Para respuestas que se reenvían en streaming.
// opciones: { ms, presupuesto, proveedor, etapa, fetchImpl }
export async function fetchConLimite(url, opts = {}, { ms, presupuesto, proveedor = 'desconocido', etapa = 'llamada', fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  return conPlazo((signal) => f(url, { ...opts, signal }), { ms, presupuesto, proveedor, etapa, signal: opts && opts.signal });
}

// fetch + lectura del cuerpo dentro del MISMO límite.
// leer: 'json' (por defecto; si no es JSON válido devuelve {}), 'text', 'arrayBuffer'.
// Devuelve { r, datos }. r.ok / r.status / r.headers siguen disponibles.
export async function pedirConLimite(url, opts = {}, { ms, presupuesto, proveedor = 'desconocido', etapa = 'llamada', leer = 'json', fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  return conPlazo(async (signal) => {
    const r = await f(url, { ...opts, signal });
    let datos;
    if (leer === 'arrayBuffer') datos = await r.arrayBuffer();
    else if (leer === 'text') datos = await r.text();
    else { const t = await r.text(); try { datos = t ? JSON.parse(t) : {}; } catch { datos = {}; } }
    return { r, datos };
  }, { ms, presupuesto, proveedor, etapa, signal: opts && opts.signal });
}

// Presupuesto total compartido por varias llamadas (generación + descarga + reintentos).
export function crearPresupuesto(msTotal, ahora = () => Date.now()) {
  const inicio = ahora(), total = Math.max(0, Number(msTotal) || 0);
  return {
    total,
    restante() { return Math.max(0, total - (ahora() - inicio)); },
    // Límite para la siguiente llamada: lo que quede, sin pasar de `tope`.
    tramo(tope) { const r = this.restante(); return tope ? Math.min(tope, r) : r; },
  };
}

// 429 o 5xx: el proveedor está saturado o caído un momento → merece otro intento.
export function esReintentable(status) {
  const s = Number(status) || 0;
  return s === 429 || (s >= 500 && s <= 599);
}

const dormirReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reintenta intento(n) mientras devuelva { r } con 429/5xx y quede presupuesto.
// Nunca se pasa del presupuesto: si tras la espera quedaría menos de `margen`,
// no reintenta y devuelve el último resultado tal cual. Los ErrorLimite (timeout,
// red) NO se reintentan: el tiempo ya se ha gastado.
export async function conReintentos(intento, { presupuesto, intentos = 2, espera = LIMITES.esperaReintento, margen = LIMITES.margenReintento, dormir = dormirReal } = {}) {
  let ultimo;
  for (let n = 1; n <= intentos; n++) {
    ultimo = await intento(n);
    if (!ultimo || !ultimo.r || !esReintentable(ultimo.r.status) || n === intentos) return ultimo;
    const pausa = espera * n;
    if (!presupuesto || presupuesto.restante() - pausa < margen) return ultimo;
    await dormir(pausa);
  }
  return ultimo;
}
