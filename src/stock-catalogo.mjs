// Catálogo del Stock — reglas puras, sin I/O, para poder probarlas con node:test.
//
// 12-sep-2026 (Yokup #3183, «Stock de Pixeria: opción Catálogo»). Las piezas que
// admiranext genera para un folleto (Alcampo 10–23 sep: langostino, mejillón,
// surimi…) entraban en el Stock como vídeos sueltos: mismo título «· Alcampo»,
// mismas 4 etiquetas (`admiranext,tiktok,vertical` + 1) y ninguna forma de
// preguntar «dame el catálogo de Alcampo de septiembre». Ahora:
//
//   · `POST /stock/publish` acepta `catalogo` {id, cliente, nombre, desde, hasta,
//     proyecto, producto} → se guarda saneado en `meta.catalogo`.
//   · Con catálogo se añaden HASHTAGS automáticos a `tags`: `catalogo`,
//     `<cliente>`, `<catalogo.id>` y `<AAAA-MM de desde>`. El tope de tags sube
//     de 4 a STOCK_TAGS_MAX (10); los automáticos y el de calidad nunca se
//     recortan, se recortan los del cliente.
//   · `GET /stock/list?catalogo=|cliente=|tag=|q=` filtra; `GET /stock/catalogos`
//     agrupa desde el índice; `PATCH /stock/:id/meta` edita/backfill.

import { sanitizeValidacion } from './stock-poster.mjs';

export const STOCK_TAGS_MAX = 10;
// 30 → 80 (Carlos, 7-oct-2026): un hashtag de destino es el nombre único de un centro o de una pantalla
// (#starbucks_paseodegracia_103_pantalla1 = 37 caracteres) y a 30 se cortaba, con dos pantallas en el mismo tag.
export const STOCK_TAG_MAX_LEN = 80;
export const CATALOGO_NOMBRE_MAX = 120;
export const CATALOGOS_MAX_IDS = 500;
export const CATALOGO_TAG = 'catalogo';

// slug `[a-z0-9-]`: minúsculas, sin acentos, todo lo demás → '-'.
export function slugify(value, max = 64) {
  if (value == null) return '';
  return String(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

// Fecha ISO AAAA-MM-DD válida (acepta un ISO completo y se queda con el día).
export function isoDate(value) {
  if (value == null) return null;
  const s = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

export function cleanTag(t) {
  return String(t == null ? '' : t)
    .toLowerCase()
    .trim()
    .replace(/^[#·.\s]+|[#·.\s]+$/g, '')
    .slice(0, STOCK_TAG_MAX_LEN);
}

// ── Vocabulario canónico (Carlos, 7-oct-2026: «normaliza al guardar») ───────────────────
// El Stock tenía la misma etiqueta escrita de varias formas («musica»/«música»), en dos
// idiomas («tech»/«tecnología») y en singular y plural. Se limpiaron los datos y, para que no
// vuelva a ensuciarse, toda etiqueta que se GUARDA pasa por aquí: si es una variante conocida
// se guarda la forma buena. No se inventan tildes: sólo se corrige lo que está en la tabla.
// Fuera a propósito: «animaciones» (etiqueta y categoría de sistema), «song» (marca de tipo de
// la demo 365) y good/better/best (calidad). La tabla de LECTURA equivalente vive en admira.tv
// (canal.html, /parrilla/ y functions/api/_playlist-live.js).
const foldTag = (t) => cleanTag(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\-\s]+/g, ' ').trim();
export const TAG_CANON = Object.freeze({
  // misma palabra, otra grafía
  tecnologia: 'tecnología', musica: 'música', inspiracion: 'inspiración', innovacion: 'innovación', robotica: 'robótica',
  cancion: 'canción', ingenieria: 'ingeniería', 'digital twin': 'digital-twin', adaptacion: 'adaptación',
  cafeteria: 'cafetería', opinion: 'opinión',
  // sinónimos en inglés
  tech: 'tecnología', technology: 'tecnología', music: 'música', muscia: 'música', business: 'negocio', creativity: 'creatividad',
  ai: 'ia', gaming: 'videojuego', robotics: 'robótica',
  // singular y plural: una sola forma
  videojuegos: 'videojuego', historias: 'historia', bebida: 'bebidas', canciones: 'canción', robot: 'robots', comics: 'comic',
  curiosidad: 'curiosidades', oferta: 'ofertas', artistas: 'artista', pelicula: 'películas', peliculas: 'películas',
  personaje: 'personajes', herramienta: 'herramientas',
});
/** Forma en la que se GUARDA una etiqueta: la saneada, o la canónica si es una variante conocida. */
export function canonTag(t) {
  const c = cleanTag(t);
  if (!c) return '';
  return TAG_CANON[foldTag(c)] || c;
}
/** Clave para COMPARAR etiquetas: sin tildes ni separadores y con las equivalencias resueltas. */
export function tagKey(t) {
  return foldTag(canonTag(t));
}

// HASHTAGS ESCRITOS (Carlos, 7-oct-2026): al importar o crear un contenido basta escribir el hashtag en el
// comentario, el título o el texto —«Promo otoño #starbucks #starbucks_paseodegracia_103_pantalla1»— para que la
// pieza nazca con esas etiquetas: la del cliente decide quién la ve y la del centro o la pantalla, dónde se emite.
// No son hashtags un color (#ff8800) ni un número suelto (#103).
const HASHTAG = /(?:^|[\s,;:(«"'¡¿>])#([\p{L}\p{N}][\p{L}\p{N}_-]{1,79})/gu;
export function hashtagsIn(...texts) {
  const out = [];
  for (const text of texts) {
    if (text == null) continue;
    for (const m of String(text).matchAll(HASHTAG)) {
      const raw = m[1];
      if (/^\d+$/.test(raw) || (/^[0-9a-f]{3,8}$/i.test(raw) && /\d/.test(raw))) continue;
      const tag = cleanTag(raw);
      if (tag && !out.includes(tag)) out.push(tag);
    }
  }
  return out.slice(0, STOCK_TAGS_MAX);
}

// Devuelve el catálogo saneado o null si no hay id utilizable.
//   id/cliente/producto/proyecto → slug [a-z0-9-]; fechas → ISO; nombre ≤ 120.
//   Sin cliente se toma el primer tramo del id (`alcampo-2026-09-10` → `alcampo`).
export function sanitizeCatalogo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = slugify(input.id);
  if (!id) return null;
  const cliente = slugify(input.cliente) || (id.split('-')[0] || null);
  const nombre = input.nombre == null ? null : String(input.nombre).trim().slice(0, CATALOGO_NOMBRE_MAX) || null;
  const desde = isoDate(input.desde);
  let hasta = isoDate(input.hasta);
  if (desde && hasta && hasta < desde) hasta = desde;
  return {
    id,
    cliente: cliente || null,
    nombre,
    desde,
    hasta,
    proyecto: slugify(input.proyecto) || null,
    producto: slugify(input.producto) || null,
  };
}

// Hashtags automáticos de un catálogo saneado: catalogo · cliente · id · AAAA-MM.
export function catalogoHashtags(catalogo) {
  if (!catalogo || !catalogo.id) return [];
  const out = [CATALOGO_TAG, catalogo.cliente, catalogo.id, catalogo.desde ? catalogo.desde.slice(0, 7) : null];
  return [...new Set(out.map(cleanTag).filter(Boolean))];
}

// Une etiquetas conservando el orden y sin repetir. Si sobran, se recortan las
// que NO sean obligatorias (`required`), empezando por el final.
export function composeTags(base = [], required = [], max = STOCK_TAGS_MAX) {
  const req = [...new Set((Array.isArray(required) ? required : []).map(cleanTag).filter(Boolean))];
  const seen = new Set();
  const all = [];
  // Las etiquetas libres se guardan en su forma canónica; las obligatorias (hashtags del
  // catálogo y calidad) son identificadores y se dejan tal cual.
  const libres = (Array.isArray(base) ? base : []).map(canonTag);
  for (const t of [...libres, ...req]) {
    const c = cleanTag(t);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    all.push(c);
  }
  if (all.length <= max) return all;
  const keep = new Set(req);
  let extra = all.length - max;
  const out = [];
  for (let i = all.length - 1; i >= 0; i--) {
    if (extra > 0 && !keep.has(all[i])) { extra--; continue; }
    out.unshift(all[i]);
  }
  return out;
}

// Etiquetas finales de una pieza: las del cliente + hashtags del catálogo + calidad.
// `previous` (catálogo anterior) sirve para retirar sus hashtags al cambiar de catálogo.
export function applyCatalogoTags(tags, catalogo, { quality = null, previous = null } = {}) {
  const required = [...catalogoHashtags(catalogo)];
  if (quality) required.push(quality);
  // Se retiran los hashtags del catálogo anterior que el nuevo no vuelva a pedir;
  // los que coinciden se quedan en su sitio para no reordenar sin motivo.
  const drop = new Set((previous ? catalogoHashtags(previous) : []).filter(t => !required.includes(t)));
  const base = (Array.isArray(tags) ? tags : []).map(cleanTag).filter(t => t && !drop.has(t));
  return composeTags(base, required);
}

// Búsqueda libre `q=`: todas las palabras tienen que aparecer en título, prompt,
// comentario, etiquetas, id, num o campos del catálogo.
export function itemMatchesQuery(item, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).map(w => w.replace(/^#/, '')).filter(Boolean);
  if (!words.length) return true;
  if (!item || typeof item !== 'object') return false;
  const cat = item.catalogo && typeof item.catalogo === 'object' ? item.catalogo : {};
  const hay = [
    item.id, item.num, item.title, item.prompt, item.comment, item.type, item.motor,
    ...(Array.isArray(item.tags) ? item.tags : []),
    cat.id, cat.cliente, cat.nombre, cat.producto, cat.proyecto, cat.desde, cat.hasta,
  ].filter(v => v != null && v !== '').join('\n').toLowerCase();
  return words.every(w => hay.includes(w));
}

export function itemHasTag(item, tag) {
  const t = cleanTag(tag);
  if (!t) return true;
  // Se compara sin tildes y con equivalencias: ?tag=musica, ?tag=música y ?tag=music traen lo mismo.
  const k = tagKey(t);
  return (Array.isArray(item && item.tags) ? item.tags : []).some(x => tagKey(x) === k);
}

export function isVigente(catalogo, today) {
  if (!catalogo) return false;
  const d = isoDate(today) || new Date().toISOString().slice(0, 10);
  if (catalogo.desde && d < catalogo.desde) return false;
  if (catalogo.hasta && d > catalogo.hasta) return false;
  return !!(catalogo.desde || catalogo.hasta);
}

// Agrupa las piezas con `meta.catalogo` por id. Los campos del catálogo los
// aporta la pieza más reciente (por si se corrigió el nombre o las fechas).
export function buildCatalogos(items, { today = null, maxIds = CATALOGOS_MAX_IDS } = {}) {
  const byId = new Map();
  const list = (Array.isArray(items) ? items : [])
    .filter(m => m && m.catalogo && typeof m.catalogo === 'object' && m.catalogo.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  for (const m of list) {
    const c = sanitizeCatalogo(m.catalogo);
    if (!c) continue;
    let g = byId.get(c.id);
    if (!g) {
      g = { id: c.id, cliente: c.cliente, nombre: c.nombre, desde: c.desde, hasta: c.hasta, proyecto: c.proyecto, count: 0, ultimo: null, vigente: false, ids: [] };
      byId.set(c.id, g);
    }
    g.count++;
    if (!g.ultimo || String(m.createdAt || '') > g.ultimo) g.ultimo = m.createdAt || g.ultimo;
    if (g.ids.length < maxIds) g.ids.push(m.id);
  }
  const out = [...byId.values()];
  for (const g of out) g.vigente = isVigente(g, today);
  out.sort((a, b) => String(b.ultimo || '').localeCompare(String(a.ultimo || '')));
  return out;
}

// Recalcula `vigente` sobre una lista ya construida (la que se guarda al reindexar).
export function refreshVigente(catalogos, today = null) {
  return (Array.isArray(catalogos) ? catalogos : []).map(g => ({ ...g, vigente: isVigente(g, today) }));
}

// PATCH /stock/:id/meta → {catalogo?, tags_add?, tags_remove?}.
//   catalogo: objeto → se sustituye (saneado); null → se retira; ausente → se deja.
// Devuelve { meta, changed, error }.
export function applyMetaPatch(meta, patch) {
  if (!meta || typeof meta !== 'object') return { meta, changed: false, error: 'bad-meta' };
  if (!patch || typeof patch !== 'object') return { meta, changed: false, error: 'bad-patch' };
  const previous = meta.catalogo && typeof meta.catalogo === 'object' ? sanitizeCatalogo(meta.catalogo) : null;
  let catalogo = previous;
  if ('catalogo' in patch) {
    if (patch.catalogo === null) catalogo = null;
    else {
      catalogo = sanitizeCatalogo(patch.catalogo);
      if (!catalogo) return { meta, changed: false, error: 'bad-catalogo' };
    }
  }
  const remove = new Set((Array.isArray(patch.tags_remove) ? patch.tags_remove : []).map(cleanTag).filter(Boolean));
  const add = (Array.isArray(patch.tags_add) ? patch.tags_add : []).map(cleanTag).filter(Boolean);
  const before = (Array.isArray(meta.tags) ? meta.tags : []).map(cleanTag).filter(Boolean);
  const base = before.filter(t => !remove.has(t)).concat(add);
  const tags = applyCatalogoTags(base, catalogo, { quality: meta.quality || null, previous });
  const next = { ...meta, tags, catalogo };
  if (!catalogo) delete next.catalogo;
  // Yokup #3199: `oculto` (true/false) saca la pieza de listados, índice y
  // catálogos sin borrarla; `validacion` guarda el veredicto {ok, negros,
  // muestras, duracion, motivo, por} (null lo quita).
  let extra = false;
  if ('oculto' in patch) {
    const oculto = patch.oculto === true;
    if (!!meta.oculto !== oculto) extra = true;
    if (oculto) next.oculto = true; else delete next.oculto;
  }
  if ('validacion' in patch) {
    if (patch.validacion === null) {
      if (meta.validacion) extra = true;
      delete next.validacion;
    } else {
      const v = sanitizeValidacion(patch.validacion);
      if (!v) return { meta, changed: false, error: 'bad-validacion' };
      next.validacion = v;
      extra = true;
    }
  }
  const changed = extra || JSON.stringify(before) !== JSON.stringify(tags) || JSON.stringify(previous) !== JSON.stringify(catalogo);
  return { meta: next, changed, error: null };
}
