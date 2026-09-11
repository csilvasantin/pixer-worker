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
