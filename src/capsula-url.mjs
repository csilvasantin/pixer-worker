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

// #capsula / #formato (Carlos OK vía Woz, 31-oct-2026): opciones de producción del encargo.
// formatos[] admite 'vertical'|'horizontal', 'v'|'h', '-v'|'-h', '9x16'|'16x9', '1080x1920'|'1920x1080'.
export const CAPSULA_BOT = 'AdmiraXPBot';
const ORIENT_ALIAS = { vertical: 'vertical', v: 'vertical', '-v': 'vertical', '9x16': 'vertical', '1080x1920': 'vertical', portrait: 'vertical',
  horizontal: 'horizontal', h: 'horizontal', '-h': 'horizontal', '16x9': 'horizontal', '1920x1080': 'horizontal', landscape: 'horizontal' };
export const capsulaOrient = v => ORIENT_ALIAS[String(v ?? '').trim().toLowerCase()] || null;
export const capsulaOpuesta = o => o === 'vertical' ? 'horizontal' : o === 'horizontal' ? 'vertical' : null;
export function normalizeCapsulaOpciones(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const requestedBy = clean(b.requestedBy, 120);
  const bot = requestedBy === CAPSULA_BOT;
  // Bot #capsula: preroll+postroll+cartela ACTIVADOS por defecto; Creador: apagados (v5.7) salvo true explícito.
  const flag = (v, def) => v === true || v === 'true' ? true : v === false || v === 'false' ? false : def;
  const orientacion = capsulaOrient(b.orientacion);
  let formatos = [...new Set((Array.isArray(b.formatos) ? b.formatos : typeof b.formatos === 'string' ? b.formatos.split(/[\s,+]+/) : []).map(capsulaOrient).filter(Boolean))];
  if (!formatos.length) formatos = orientacion ? [orientacion] : ['vertical', 'horizontal'];
  if (b.formato === true && orientacion && !formatos.includes(capsulaOpuesta(orientacion))) formatos.push(capsulaOpuesta(orientacion));
  const idioma = /^[a-z]{2}(-[A-Za-z]{2})?$/.test(String(b.idioma || '').trim()) ? String(b.idioma).trim() : null;
  return { preroll: flag(b.preroll, bot), postroll: flag(b.postroll, bot), cartela: flag(b.cartela, bot),
    orientacion: orientacion || formatos[0], formatos, idioma, subtitulos: flag(b.subtitulos, bot ? true : false),
    requestedBy, autoApprove: bot && b.autoApprove !== false };
}

// Normaliza el guion (venga de Gemini o editado por Carlos). Devuelve {ok, guion, errors, opciones}.
// `opciones` (2º argumento: el cuerpo del encargo) = preroll/postroll/orientacion/idioma/subtitulos/formatos[].
export function normalizeCapsulaGuion(raw, body) {
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
  const opciones = normalizeCapsulaOpciones({ ...(raw && typeof raw === 'object' ? raw : {}), ...(body && typeof body === 'object' ? body : {}) });
  if (opciones.idioma) guion.idioma = opciones.idioma;
  return { ok: errors.length === 0, guion, errors, opciones };
}

// Assets del Stock que ya son esta cápsula (misma ref → dedup por orientación).
export function capsulaUrlExisting(items, ref, minVersion = 1) {
  const out = {};
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.type !== 'video' || it.externalRef !== ref || it.hidden || it.deleted || it.oculto) continue;
    if (Math.max(1, parseInt(it?.capsuleSource?.version, 10) || 1) < minVersion) continue;
    const tags = it.tags || [];
    for (const o of ['vertical', 'horizontal']) if (tags.includes(o) && !out[o]) out[o] = { id: it.id, num: it.num ?? null, url: it.url || null, version: Math.max(1, parseInt(it?.capsuleSource?.version, 10) || 1) };
  }
  return out;
}

export function capsulaUrlStatus(job, existing) {
  const pedidos = Array.isArray(job?.formatos) && job.formatos.length ? job.formatos : ['vertical', 'horizontal'];
  if (pedidos.every(o => existing[o])) return 'publicada';
  if (existing.vertical || existing.horizontal) return 'parcial';
  return job ? (job.status || 'en-cola') : 'sin-encargo';
}

// Ficha interactiva de la cápsula (v2, 22-oct-2026): fuente y tramo del b-roll en el meta,
// sin depender del prompt. `sourceUrl` no se usa en el body de /stock/publish porque allí
// significa «descarga esto»; por eso va dentro de `capsuleSource`.
export function sanitizeCapsuleSource(raw, externalRef) {
  if (!raw || typeof raw !== 'object' || !/^capsula-url:[a-f0-9]{16}$/.test(String(externalRef || ''))) return null;
  let url; try { url = new URL(String(raw.sourceUrl || '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const n = v => Math.round(Number(v) * 100) / 100;
  const start = n(raw.broll?.start), end = n(raw.broll?.end);
  const broll = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= 120 ? { start, end } : null;
  const version = Math.max(1, Math.min(99, parseInt(raw.version, 10) || 1));
  return { sourceUrl: url.href.slice(0, 1000), credit: String(raw.credit || '').replace(/\s+/g, ' ').trim().slice(0, 120), broll, version, preroll: raw.preroll === true, postroll: raw.postroll === true };
}
export const capsuleVersionOf = item => Math.max(1, parseInt(item?.capsuleSource?.version, 10) || 1);
// Piezas anteriores de la misma cápsula y orientación que una versión nueva sustituye (se ocultan, no se borran).
export function capsulaSuperseded(items, meta) {
  if (!meta?.capsuleSource || !/^capsula-url:/.test(meta.externalRef || '')) return [];
  const o = ['vertical', 'horizontal'].find(x => (meta.tags || []).includes(x)); if (!o) return [];
  const v = capsuleVersionOf(meta);
  return (items || []).filter(it => it && it.id !== meta.id && it.type === 'video' && it.externalRef === meta.externalRef && (it.tags || []).includes(o) && capsuleVersionOf(it) < v).map(it => it.id);
}

// Modo «campaña» del borrador (Creador de campañas para pantallas, 22-oct-2026): misma extracción,
// otro guion. Rellena el paso Contenido: marca/producto, titular corto, llamada a la acción.
export const CAMPANA_URL_LIMITS = { nombre: 60, titular: 42, cta: 60, etiqueta: 80, idea: 280 };
export function campanaUrlPrompt(source) {
  const L = CAMPANA_URL_LIMITS;
  return `Eres redactor publicitario de Admira para campañas en pantallas de tienda (digital signage, lectura en 3 segundos).\n` +
    `A partir del contenido de abajo propone la copia de UNA campaña en español. Devuelve SOLO JSON válido con este esquema exacto:\n` +
    `{"nombre":"producto o marca protagonista, ≤${L.nombre} caracteres","titular":"titular corto e impactante, ≤${L.titular} caracteres","cta":"mensaje o llamada a la acción, ≤${L.cta}","etiqueta":"qué muestra la imagen de la fuente, ≤${L.etiqueta}","idea":"idea clave en una frase, ≤${L.idea}"}\n` +
    `Reglas: sin emojis, sin hashtags, sin comillas, sin Markdown, sin punto final en titular y cta. No inventes datos, precios ni marcas que no estén en el contenido.\n\n` +
    `TIPO: ${source.kind}\nURL: ${source.url}\nTÍTULO: ${source.title}\nAUTOR: ${source.author}\nDESCRIPCIÓN: ${source.description}\n\nTEXTO:\n${String(source.text || '').slice(0, 12000)}`;
}
export function normalizeCampanaBorrador(raw) {
  const L = CAMPANA_URL_LIMITS, g = raw && typeof raw === 'object' ? raw : {};
  const out = { nombre: clean(g.nombre, L.nombre), titular: clean(g.titular, L.titular).replace(/[.。]$/, ''), cta: clean(g.cta, L.cta).replace(/[.。]$/, ''), etiqueta: clean(g.etiqueta, L.etiqueta), idea: clean(g.idea, L.idea) };
  const errors = ['nombre', 'titular', 'cta'].filter(k => !out[k]).map(k => 'missing_' + k);
  return { ok: errors.length === 0, campana: out, errors };
}
