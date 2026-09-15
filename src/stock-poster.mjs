// Póster y validación de los vídeos del Stock (Yokup #3199, 12-sep-2026).
//
// Origen: admira.tv/contentcatalogue enseñaba el previo del «Langostino cocido»
// en NEGRO. El máster no era negro: solo su fotograma 0 (el relleno #020508
// con el que el creador siembra el canvas antes de captureStream(); luma
// Y≈20 en rango limitado) y a partir del fotograma 1 (t=0,014 s) ya hay
// imagen. Pero un webm de MediaRecorder no lleva Duration ni Cues, así que
// el `#t=0.1` del previo no se puede resolver en todos los navegadores y el
// <video> pinta el fotograma 0. Regla de Carlos: el previo NUNCA puede ser un
// fotograma negro/sin información → cada vídeo lleva un póster representativo
// (elegido por luma y varianza, evitando los 0,8 s de cada extremo) y el
// generador valida el máster antes de publicarlo.
//
// Este módulo es puro (sin R2 ni fetch) para poder testearlo con node --test.

export const POSTER_MAX_BYTES = 400 * 1024; // un póster son decenas de KB
export const POSTER_MIN_BYTES = 200;
export const POSTER_MIMES = { 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Acepta `data:image/jpeg;base64,...`, `data:image/webp;base64,...` o base64 a
// pelo (se asume JPEG). Devuelve { bytes, mime, ext } o { error }.
export function parsePoster(input, { decode = defaultDecode } = {}) {
  if (input == null || input === '') return { error: 'missing-poster' };
  if (typeof input !== 'string') return { error: 'bad-poster' };
  let mime = 'image/jpeg';
  let b64 = input.trim();
  const m = /^data:([a-z0-9.+/-]+)(?:;[^,]*)?;base64,(.*)$/is.exec(b64);
  if (m) { mime = m[1].toLowerCase(); b64 = m[2]; }
  else if (b64.startsWith('data:')) return { error: 'bad-poster-data-url' };
  if (!POSTER_MIMES[mime]) return { error: 'bad-poster-mime', expected: Object.keys(POSTER_MIMES) };
  let bytes;
  try { bytes = decode(b64.replace(/\s+/g, '')); } catch { return { error: 'bad-poster-base64' }; }
  if (!bytes || bytes.length < POSTER_MIN_BYTES) return { error: 'poster-too-small' };
  if (bytes.length > POSTER_MAX_BYTES) return { error: 'poster-too-big', max: POSTER_MAX_BYTES };
  if (mime === 'image/jpeg' && !(bytes[0] === 0xff && bytes[1] === 0xd8)) return { error: 'poster-not-jpeg' };
  if (mime === 'image/webp' && !(bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)) return { error: 'poster-not-webp' };
  return { bytes, mime, ext: POSTER_MIMES[mime] };
}

function defaultDecode(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function posterKey(id, ext = 'jpg') { return `stock/${id}/poster.${ext}`; }

// URL pública estable del póster por el worker (además del thumbnail directo a
// R2, que cambia con ?v=). Los consumidores usan `meta.poster`.
export function posterUrl(origin, id) { return `${origin}/stock/poster/${id}`; }

// ¿El thumbnail de este meta es un póster nuestro en R2? (y no una data-URI o
// una URL externa que trajo el publish)
export function posterKeyFromMeta(meta) {
  if (!meta || typeof meta.thumbnail !== 'string') return null;
  const m = /\/stock\/([A-Za-z0-9-]+)\/poster\.(jpg|webp)(?:\?|$)/.exec(meta.thumbnail);
  if (!m || m[1] !== meta.id) return null;
  return posterKey(m[1], m[2]);
}

// Resultado de la validación que manda el generador (o el backfill con ffmpeg).
// Se guarda saneado: { ok, negros, muestras, duracion, motivo, por, at }.
export function sanitizeValidacion(input) {
  if (input == null) return null;
  if (typeof input !== 'object') return null;
  const num = (v, max) => (v == null || !Number.isFinite(+v)) ? null : Math.max(0, Math.min(max, Math.round(+v * 100) / 100));
  const out = {
    ok: input.ok === true,
    negros: num(input.negros, 10000),
    muestras: num(input.muestras, 10000),
    duracion: num(input.duracion, 36000),
    motivo: input.motivo == null ? null : String(input.motivo).slice(0, 200),
    por: input.por == null ? null : String(input.por).slice(0, 80),
    // Dimensiones reales del máster (Vía 1, FLT-100477): las mide el creador al validar; el Stock
    // deriva de ellas la orientación honesta (vertical|horizontal) en vez de fiarse del formato pedido.
    ancho: (Number.isFinite(+input.ancho) && +input.ancho >= 16 && +input.ancho <= 8192) ? Math.round(+input.ancho) : null,
    alto: (Number.isFinite(+input.alto) && +input.alto >= 16 && +input.alto <= 8192) ? Math.round(+input.alto) : null,
    at: (typeof input.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(input.at)) ? input.at.slice(0, 24) : new Date().toISOString(),
  };
  if (!out.ok && !out.motivo) out.motivo = 'sin-motivo';
  return out;
}

// Regla de decisión sobre una lista de muestras {luma, var} (mismo criterio en
// el creador, en el catálogo y en el backfill con ffmpeg):
//  · «negro» = luma < 16 (sobre 0..255) y varianza baja (< 25) → sin información
//  · inválido si > 70 % de las muestras son negras, si dura < 10 s o si no hay
//    pista de vídeo (0 muestras).
export const LUMA_NEGRO = 16;
export const VARIANZA_NEGRO = 25;
export const NEGRO_MAX_RATIO = 0.7;
export const DURACION_MIN = 10;

export function esNegra(muestra) {
  if (!muestra) return true;
  const luma = +muestra.luma, varianza = +(muestra.var ?? muestra.varianza ?? 0);
  return !(luma >= LUMA_NEGRO) || (luma < LUMA_NEGRO + 8 && varianza < VARIANZA_NEGRO);
}

export function evaluarMuestras(muestras, { duracion = null, tienePista = true } = {}) {
  const lista = Array.isArray(muestras) ? muestras : [];
  const total = lista.length;
  const negros = lista.filter(esNegra).length;
  if (!tienePista || total === 0) return { ok: false, negros, muestras: total, duracion, motivo: 'sin pista de vídeo' };
  if (duracion != null && Number.isFinite(+duracion) && +duracion < DURACION_MIN) {
    return { ok: false, negros, muestras: total, duracion, motivo: `duración ${(+duracion).toFixed(1)} s < ${DURACION_MIN} s` };
  }
  if (negros / total > NEGRO_MAX_RATIO) {
    return { ok: false, negros, muestras: total, duracion, motivo: `Vídeo inválido: ${negros}/${total} fotogramas negros` };
  }
  return { ok: true, negros, muestras: total, duracion, motivo: null };
}

// Elige el fotograma con más «información»: luma media entre 40 y 220 y máxima
// varianza; se descartan los 0,8 s iniciales y finales cuando hay alternativa.
// Cada muestra: { t, luma, var }. Devuelve el índice elegido (o -1).
export const MARGEN_EXTREMOS = 0.8;
export function elegirPoster(muestras, { duracion = null } = {}) {
  const lista = Array.isArray(muestras) ? muestras : [];
  if (!lista.length) return -1;
  const dur = (duracion != null && Number.isFinite(+duracion)) ? +duracion : (lista[lista.length - 1].t ?? null);
  const dentro = (m) => m.t == null || dur == null || (m.t >= MARGEN_EXTREMOS && m.t <= dur - MARGEN_EXTREMOS);
  const candidatas = (pred) => lista.map((m, i) => ({ m, i })).filter(({ m }) => !esNegra(m) && pred(m));
  const tiers = [
    candidatas((m) => dentro(m) && m.luma >= 40 && m.luma <= 220),
    candidatas((m) => m.luma >= 40 && m.luma <= 220),
    candidatas(dentro),
    candidatas(() => true),
  ];
  for (const tier of tiers) {
    if (!tier.length) continue;
    tier.sort((a, b) => (+(b.m.var ?? 0)) - (+(a.m.var ?? 0)) || a.i - b.i);
    return tier[0].i;
  }
  return -1;
}
