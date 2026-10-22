// Dedup del Stock — decisión pura, sin I/O, para poder probarla con node:test.
//
// El 11-sep-2026 entró dos veces el mismo vídeo en el Stock. Causa: sin
// `externalId` cada publish inventa un id nuevo (`${ts}-${random}`), así que
// dos peticiones con el MISMO fichero (doble clic, reintento del cliente, dos
// paquetes de admiranext que componen el mismo máster) crean dos assets. Y con
// `externalId` solo se comparaba la identidad, nunca el contenido.
//
// Tres reglas, de más fuerte a más blanda:
//   1. contenido  — sha256 del binario completo (`contentHash` en meta.json).
//                   Índice KV `stock:hash:<sha256>` → id, con repesca en
//                   stock/index.json para los assets cuyo KV no se escribió.
//   2. identidad  — mismo externalId → mismo id opaco. Si el contenido es el
//                   mismo, `reused`; si cambió, se SUSTITUYE el binario y se
//                   conserva el id (`replaced`), que es lo que espera el
//                   creador de admiranext (el máster nuevo ocupa el hueco).
//   3. reciente   — mismo title + motor + sourceUrl en los últimos
//                   STOCK_DEDUP_WINDOW_MIN minutos (10 por defecto) → `reused`
//                   sin descargar nada. Solo sin externalId: con identidad manda
//                   la regla 2.
//
// El hash del carril streaming (sourceUrl / r2Staged) se calcula MIENTRAS se
// escribe en R2 (crypto.DigestStream), así que se conoce después del put. Si
// resulta duplicado, se borra el binario recién escrito: un put+delete en R2
// es despreciable frente a descargar dos veces o retener 200 MB en memoria.

export const STOCK_DEDUP_WINDOW_MIN_DEFAULT = 10;
export const STOCK_HASH_KV_PREFIX = 'stock:hash:';
export const STOCK_RECENT_KV_PREFIX = 'stock:recent:';

export function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

// Ventana de la regla blanda en milisegundos. `0` la desactiva.
export function dedupWindowMs(env) {
  const raw = env && env.STOCK_DEDUP_WINDOW_MIN;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  const minutes = Number.isFinite(n) && n >= 0 ? n : STOCK_DEDUP_WINDOW_MIN_DEFAULT;
  return Math.round(minutes * 60 * 1000);
}

// Tupla de la regla blanda. Sin sourceUrl no hay tupla: title+motor a secas
// es demasiado poco para bloquear (dos imágenes distintas del mismo motor con
// el mismo título en 10 min es un caso normal). Para ésas manda el hash.
export function recentFingerprintInput({ title, motor, sourceUrl } = {}) {
  const t = String(title || '').trim().toLowerCase();
  const m = String(motor || '').trim().toLowerCase();
  const s = String(sourceUrl || '').trim();
  if (!m || !s) return null;
  return `${t}\n${m}\n${s}`;
}

// Decisión final una vez se conoce lo que hay que conocer.
//   id             — id que tendría el asset (determinista si hay externalId)
//   externalId     — identidad externa (o '')
//   existingMeta   — meta.json ya guardado bajo ese id (o null)
//   contentHash    — sha256 del binario que llega (o null si aún no se sabe)
//   hashOwnerId    — id del asset que ya tiene ese contentHash (o null)
//   recentOwnerId  — id que dejó la regla blanda en la ventana (o null)
// Devuelve { action: 'create' | 'reuse' | 'replace', reason, id }.
export function stockDedupDecision({ id, externalId = '', existingMeta = null, contentHash = null, hashOwnerId = null, recentOwnerId = null } = {}) {
  const identityTaken = !!(externalId && existingMeta && existingMeta.id === id && existingMeta.externalRef === id);

  if (identityTaken) {
    const known = existingMeta.contentHash;
    if (contentHash && known && contentHash === known) return { action: 'reuse', reason: 'duplicate_external_id', id };
    if (contentHash && hashOwnerId && hashOwnerId === id) return { action: 'reuse', reason: 'duplicate_external_id', id };
    if (contentHash) return { action: 'replace', reason: known ? 'external_id_new_content' : 'external_id_unhashed', id };
    // Sin hash todavía (antes de descargar): no se puede saber si cambió.
    return { action: 'create', reason: 'needs_content', id };
  }

  if (contentHash && hashOwnerId && hashOwnerId !== id) return { action: 'reuse', reason: 'duplicate_content', id: hashOwnerId };
  if (!externalId && recentOwnerId) return { action: 'reuse', reason: 'duplicate_recent', id: recentOwnerId };
  return { action: 'create', reason: 'new', id };
}

// Al sustituir el binario bajo el mismo id se conservan los campos que NO son
// del fichero: número, valoraciones, consumos, fecha de alta y la cara si la
// nueva publicación no trae una.
export function mergeReplacedMeta(existingMeta, freshMeta, now = Date.now()) {
  const kept = existingMeta && typeof existingMeta === 'object' ? existingMeta : {};
  return {
    ...kept,
    ...freshMeta,
    thumbnail: freshMeta.thumbnail || kept.thumbnail || null,
    createdAt: kept.createdAt || freshMeta.createdAt,
    replacedAt: new Date(now).toISOString(),
    replacedFromHash: kept.contentHash || null,
  };
}

// ─── Importaciones por URL (Telegram → yt-dlp) ────────────────────────────────
// El 22-oct-2026 el mismo vídeo de LinkedIn (https://lnkd.in/p/e9zXSPkK) entró
// TRES veces (#1795, #1796, #1797) en 2 s, con el MISMO sha256. Las reglas de
// arriba existían, pero eran «mirar y luego escribir»: las tres peticiones
// miraron el índice hash→id antes de que ninguna lo escribiera (entre medias
// va la clasificación con Gemini, ~1-2 s, y KV es eventualmente consistente).
// Arreglo: una RESERVA atómica en R2 (put con If-None-Match: *) por contenido y
// por origen. Solo una petición gana; las demás esperan al ganador y responden
// reused. La clave de origen es la URL normalizada (resolviendo acortadores
// como lnkd.in) o, mejor aún, el id del post/vídeo en la plataforma.

export const STOCK_CLAIM_PREFIX = 'dedup-claims/stock/'; // fuera de stock/: los rebuilds recorren ese prefijo
// Una reserva cuyo asset no llegó a existir se considera abandonada pasado este
// tiempo (la parte posterior a la reserva es Gemini + escrituras: segundos).
export const STOCK_CLAIM_STALE_MS = 3 * 60 * 1000;
// Reserva del webhook de Telegram mientras el proxy descarga (monitor = 9 min).
export const TG_IMPORT_CLAIM_STALE_MS = 12 * 60 * 1000;

const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|igsh|igshid|si|feature|rcm|trk|trackingid|lipi|ref|ref_src|ref_url|s|t|origin|highlightedupdateurn|highlightedupdatetype|share_id|is_from_webapp|sender_device|_r)$/i;

// Hosts acortadores que hay que resolver (redirección) antes de normalizar.
export function isShortenerHost(host) {
  return /^(lnkd\.in|bit\.ly|t\.co|tinyurl\.com|ow\.ly|buff\.ly|goo\.gl|vm\.tiktok\.com|vt\.tiktok\.com|fb\.watch|on\.soundcloud\.com|shorturl\.at)$/i.test(String(host || ''));
}

// Clave estable del ORIGEN de una importación. Devuelve null si no es una URL http(s).
//   youtube:<id11> · linkedin:<id numérico del post> · tiktok:<id> · x:<id> · vimeo:<id>
//   o, si no hay id reconocible, url:<host><path>?<query sin tracking> en minúsculas.
export function importSourceKey(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const path = u.pathname;
  let m;
  if (host === 'youtu.be' && (m = path.match(/^\/([A-Za-z0-9_-]{11})/))) return `youtube:${m[1]}`;
  if (/(^|\.)youtube\.com$/.test(host)) {
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return `youtube:${v}`;
    if ((m = path.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/))) return `youtube:${m[1]}`;
  }
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const all = decodeURIComponent(path + ' ' + u.search);
    if ((m = all.match(/(?:ugcPost|activity|share)[-:](\d{10,})/i))) return `linkedin:${m[1]}`;
  }
  if (/(^|\.)tiktok\.com$/.test(host) && (m = path.match(/\/(?:video|photo)\/(\d{8,})/))) return `tiktok:${m[1]}`;
  if (/^(x\.com|twitter\.com)$/.test(host) && (m = path.match(/\/status(?:es)?\/(\d{5,})/))) return `x:${m[1]}`;
  if (host === 'vimeo.com' && (m = path.match(/^\/(?:.*\/)?(\d{5,})(?:\/|$)/))) return `vimeo:${m[1]}`;
  if (/(^|\.)instagram\.com$/.test(host) && (m = path.match(/^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/))) return `instagram:${m[1]}`;
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const q = keep.length ? '?' + keep.map(([k, v]) => `${k}=${v}`).join('&') : '';
  return `url:${host}${path.replace(/\/+$/, '') || '/'}${q}`.toLowerCase();
}

// ¿Sigue vigente una reserva? `ownerAlive` = el asset reservado ya existe.
export function claimIsLive(claim, { now = Date.now(), ownerAlive = false, staleMs = STOCK_CLAIM_STALE_MS } = {}) {
  if (!claim || typeof claim !== 'object') return false;
  if (ownerAlive) return true;
  const at = Date.parse(claim.at || '');
  return Number.isFinite(at) && now - at < staleMs;
}
