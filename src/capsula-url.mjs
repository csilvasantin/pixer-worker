// Cápsula «¿Sabías que?» desde una URL (Creador de admira.studio, 22-oct-2026).
//
// Lógica pura (sin I/O) para probarla con node:test. El worker:
//   1. resuelve y normaliza la URL con lo que ya hay (resolveImportUrl + importSourceKey, PR #31),
//   2. extrae título, autor, texto y miniatura de la página,
//   3. pide a Gemini un borrador de guion v5 (gancho · giro · remate) que Carlos edita,
//   4. encola el guion aprobado en R2 (capsula-url/jobs/<hash>.json, reserva atómica).
// El render NO se hace aquí: lo hace el MISMO pipeline de las cápsulas actuales
// (Python + ffmpeg, plantilla_v5.py + publicar_sabias_v5.py) en GrokBotBox, que lee la cola
// con GET /capsula/url/cola y publica en /stock/publish con externalRef = ref (dedup).

export const CAPSULA_URL_JOB_PREFIX = 'capsula-url/jobs/';
export const CAPSULA_URL_TAGS = ['capsula', 'sabiasque'];
export const CAPSULA_URL_LIMITS = { objeto: 90, subtitulo: 60, unidad: 16, gancho: 70, giro: 80, remate: 90, fuente: 80, idea: 280, tema: 24 };
const TEMAS = ['tecnología', 'ciencia', 'negocio', 'creatividad', 'música', 'marketing', 'salud', 'cultura'];

export function capsulaUrlKind(sourceKey) {
  const k = String(sourceKey || '').split(':')[0];
  return ['youtube', 'linkedin', 'tiktok', 'x', 'vimeo', 'instagram'].includes(k) ? k : 'articulo';
}

export async function capsulaUrlRef(sourceKey) {
  const data = new TextEncoder().encode(String(sourceKey || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `capsula-url:${hex.slice(0, 16)}`;
}

export function capsulaUrlJobKey(ref) {
  const m = /^capsula-url:([a-f0-9]{16})$/.exec(String(ref || ''));
  return m ? `${CAPSULA_URL_JOB_PREFIX}${m[1]}.json` : null;
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function capsulaUrlPrompt(source) {
  return `Eres guionista de las cápsulas «¿Sabías que?» de Admira (vídeo de 15 s, plantilla v5: cartela Admira 2 s, explicación 12 s, cierre con logo 1 s).\n` +
    `A partir del contenido de abajo escribe UN guion corto en español con una sola idea clave sorprendente.\n` +
    `Devuelve SOLO JSON válido con este esquema exacto:\n` +
    `{"objeto":"título de la ficha, ≤${CAPSULA_URL_LIMITS.objeto} caracteres","subtitulo":"subtítulo de la cartela, ≤${CAPSULA_URL_LIMITS.subtitulo}","tema":"${TEMAS.join('|')}",` +
    `"cifra":{"hasta":número o null,"unidad":"≤${CAPSULA_URL_LIMITS.unidad} caracteres o vacío"},` +
    `"gancho":"línea 1, sorprende, ≤${CAPSULA_URL_LIMITS.gancho}","giro":"línea 2, el dato que cambia la mirada, ≤${CAPSULA_URL_LIMITS.giro}",` +
    `"remate":"línea 3, consecuencia o lección, ≤${CAPSULA_URL_LIMITS.remate}","fuente":"Fuente: autor o medio · dominio, ≤${CAPSULA_URL_LIMITS.fuente}","idea":"idea clave en una frase, ≤${CAPSULA_URL_LIMITS.idea}"}\n` +
    `Reglas: una idea por línea, frases cortas sin punto final, sin emojis, sin hashtags, sin Markdown. ` +
    `La cifra SOLO si aparece literalmente en el contenido (si no, null y unidad vacía). No inventes datos ni nombres que no estén en el contenido.\n\n` +
    `TIPO: ${source.kind}\nURL: ${source.url}\nTÍTULO: ${source.title}\nAUTOR: ${source.author}\nDESCRIPCIÓN: ${source.description}\n\nTEXTO:\n${String(source.text || '').slice(0, 12000)}`;
}

// Normaliza el guion (venga de Gemini o editado por Carlos). Devuelve {ok, guion, errors}.
export function normalizeCapsulaGuion(raw) {
  const L = CAPSULA_URL_LIMITS, g = raw && typeof raw === 'object' ? raw : {};
  const hastaRaw = g.cifra && typeof g.cifra === 'object' ? g.cifra.hasta : g.cifraHasta;
  const hasta = hastaRaw === '' || hastaRaw == null ? null : Number(String(hastaRaw).replace(/[.\s](?=\d{3}\b)/g, '').replace(',', '.'));
  const tema = clean(g.tema, L.tema).toLowerCase();
  const guion = {
    objeto: clean(g.objeto, L.objeto), subtitulo: clean(g.subtitulo, L.subtitulo),
    tema: TEMAS.includes(tema) ? tema : 'tecnología',
    cifra: { hasta: Number.isFinite(hasta) && hasta > 0 && hasta < 1e12 ? Math.round(hasta * 100) / 100 : null, unidad: clean(g.cifra?.unidad ?? g.cifraUnidad, L.unidad) },
    gancho: clean(g.gancho, L.gancho), giro: clean(g.giro, L.giro), remate: clean(g.remate, L.remate),
    fuente: clean(g.fuente, L.fuente), idea: clean(g.idea, L.idea),
  };
  if (guion.cifra.hasta == null) guion.cifra.unidad = '';
  if (guion.fuente && !/^(fuente|source)\s*:/i.test(guion.fuente)) guion.fuente = clean('Fuente: ' + guion.fuente, L.fuente);
  const errors = ['objeto', 'gancho', 'giro', 'remate', 'fuente'].filter(k => !guion[k]).map(k => 'missing_' + k);
  return { ok: errors.length === 0, guion, errors };
}

// Assets del Stock que ya son esta cápsula (misma ref → dedup por orientación).
export function capsulaUrlExisting(items, ref) {
  const out = {};
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.type !== 'video' || it.externalRef !== ref || it.hidden || it.deleted) continue;
    const tags = it.tags || [];
    for (const o of ['vertical', 'horizontal']) if (tags.includes(o) && !out[o]) out[o] = { id: it.id, num: it.num ?? null, url: it.url || null };
  }
  return out;
}

export function capsulaUrlStatus(job, existing) {
  if (existing.vertical && existing.horizontal) return 'publicada';
  if (existing.vertical || existing.horizontal) return 'parcial';
  return job ? (job.status || 'en-cola') : 'sin-encargo';
}
