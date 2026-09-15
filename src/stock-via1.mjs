// stock-via1.mjs — Vía 1 «cerrar el pipeline vivo» (FLT-100477 · ventana 0142 · MorfeoMacMini · MacMini · 15-09-2026).
// Lógica pura (sin red) para: (1) num asignado AL PUBLICAR, (2) etiquetas honestas por dimensiones,
// (3) reparto a parrilla por segmentación además de por etiqueta, (4) traza folleto → Stock → pantalla.
// Cada función se prueba en test/stock-via1.test.mjs; src/index.js solo las cablea.

export const NUM_KV_KEY = 'stock:num:last';

/** Mayor num válido de una lista de metas/items. */
export function maxNum(items) {
  let max = 0;
  for (const m of (Array.isArray(items) ? items : [])) { const n = +(m && m.num); if (Number.isFinite(n) && n > max) max = n; }
  return max;
}

/**
 * Siguiente num al publicar: max(contador KV, mayor num del índice) + 1. Antes el publish salía sin
 * num y el asset vivía «sin número» hasta el próximo rebuild del índice (la referencia humana #N y
 * /play<N> no existían al nacer). El contador KV evita que dos publish seguidos, con el índice aún
 * viejo, repitan número; si aun así coincidieran, renumerarDuplicados lo sana en el rebuild.
 */
export function siguienteNum(indexItems, kvLast) {
  const kv = Number.isFinite(+kvLast) ? +kvLast : 0;
  return Math.max(kv, maxNum(indexItems)) + 1;
}

/** Metas con num repetido: conserva el más antiguo y da números nuevos a los demás. Devuelve los cambiados. */
export function renumerarDuplicados(metas) {
  const porNum = new Map();
  for (const m of (Array.isArray(metas) ? metas : [])) {
    const n = +(m && m.num); if (!Number.isFinite(n) || n <= 0) continue;
    if (!porNum.has(n)) porNum.set(n, []); porNum.get(n).push(m);
  }
  let max = maxNum(metas); const cambiados = [];
  for (const [, lista] of porNum) {
    if (lista.length < 2) continue;
    lista.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    for (const m of lista.slice(1)) { m.num = ++max; cambiados.push(m); }
  }
  return cambiados;
}

/**
 * Etiquetas honestas por dimensiones: `vertical`/`horizontal` las pone el cliente según el formato que
 * pidió; con las dimensiones reales del máster (validacion.ancho/alto) el Stock las corrige. Devuelve
 * {tags, orientacion, corregida}. Sin dimensiones no toca nada (orientacion null).
 */
export function etiquetasHonestas(tags, dims) {
  const lista = (Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  const w = dims && +dims.ancho, h = dims && +dims.alto;
  if (!(w > 0 && h > 0)) return { tags: lista, orientacion: null, corregida: false };
  const orientacion = h > w ? 'vertical' : (w > h ? 'horizontal' : 'cuadrado');
  const declarada = lista.find((t) => t === 'vertical' || t === 'horizontal' || t === 'cuadrado') || null;
  const sin = lista.filter((t) => t !== 'vertical' && t !== 'horizontal' && t !== 'cuadrado');
  const idx = declarada ? lista.indexOf(declarada) : sin.length;
  sin.splice(Math.min(idx, sin.length), 0, orientacion);
  return { tags: [...new Set(sin)], orientacion, corregida: !!declarada && declarada !== orientacion };
}

// ─── Reparto a parrilla: objetivos por etiqueta, por cliente de catálogo o por segmento ───
export const AUDIENCES = ['f', 'm', 'all'];
export const AGES = ['nino', 'joven', 'adulto', 'senior', 'vejez'];
const slug = (v, max = 64) => String(v == null ? '' : v).toLowerCase().trim().replace(/^#/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);

/** Sanea un objetivo {screen, lane, tag?, cliente?, audience?, age?}. null si no vale. */
export function saneaObjetivo(t) {
  if (!t || typeof t !== 'object') return null;
  const screen = String(t.screen || '').trim().slice(0, 80);
  const lane = slug(t.lane, 30) || 'publicidad';
  const tag = slug(t.tag, 40) || null;
  const cliente = slug(t.cliente, 64) || null;
  const audience = AUDIENCES.includes(t.audience) ? t.audience : null;
  const age = AGES.includes(t.age) ? t.age : null;
  if (!screen || !(tag || cliente || audience || age)) return null;
  return { screen, lane, tag, cliente, audience, age };
}
/** Clave estable del objetivo (lo que antes era solo la etiqueta). */
export function claveObjetivo(t) {
  return t.tag || (t.cliente ? `cliente:${t.cliente}` : `seg:${t.audience || 'all'}:${t.age || 'any'}`);
}
/** Objetivos fijos + extra (KV), sin duplicados por screen+lane+clave. */
export function objetivosDeReparto(base, extra) {
  const out = []; const vistos = new Set();
  for (const t of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
    const s = saneaObjetivo(t); if (!s) continue;
    const k = `${s.screen}|${s.lane}|${claveObjetivo(s)}`; if (vistos.has(k)) continue;
    vistos.add(k); out.push(s);
  }
  return out;
}
export function tagsDeItem(item) {
  return new Set((Array.isArray(item && item.tags) ? item.tags : []).map((t) => String(t).toLowerCase().trim().replace(/^#/, '')));
}
/** ¿Casa el item con el objetivo? Devuelve el motivo ('tag' | 'cliente' | 'segmento') o null. */
export function motivoDeReparto(item, target) {
  if (!item || !target) return null;
  if (target.tag && tagsDeItem(item).has(target.tag)) return 'tag';
  if (target.cliente && item.catalogo && slug(item.catalogo.cliente) === target.cliente) return 'cliente';
  if (target.audience || target.age) {
    const seg = item.segmentation || null;
    const auds = new Set([item.audience, ...((seg && seg.audiences) || [])].filter(Boolean));
    const ages = new Set([item.ageBucket, ...((seg && seg.ageBuckets) || [])].filter(Boolean));
    const okAud = !target.audience || target.audience === 'all' ? true : auds.has(target.audience);
    const okAge = !target.age ? true : ages.has(target.age);
    if (okAud && okAge && (auds.size || ages.size)) return 'segmento';
  }
  return null;
}

// ─── Traza folleto → vídeo → Stock → parrilla → pantalla ───
/** Descompone el externalRef/externalId del Composer: admiranext:catalogo:<catalogo_id>:<slug>[:16x9]. */
export function origenDeExternalId(ext) {
  const s = String(ext || '');
  const m = /^admiranext:catalogo:([a-z0-9-]+):([a-z0-9-]+?)(?::16x9)?$/i.exec(s);
  if (m) return { tipo: 'catalogo', catalogo_id: m[1], producto: m[2], horizontal: /:16x9$/i.test(s), catalogo_url: `https://admira.tv/contentcatalogue/?catalogo=${encodeURIComponent(m[1])}` };
  const x = /^admiranext:xtore:([a-z0-9-]+)$/i.exec(s); if (x) return { tipo: 'xtore', lane: x[1] };
  const p = /^admiranext:tiktok-package:([a-z0-9-]+)$/i.exec(s); if (p) return { tipo: 'tiktok-package', paquete: p[1] };
  return s ? { tipo: 'externo', externalId: s } : null;
}
/**
 * Traza de un asset: {asset, origen, reparto[], pantallas[], emision[], estado, siguiente_paso}.
 * status = grid:tag-sync:status; bookingsPorPantalla = {screen: bookings[]} de hoy; nowPorPantalla = {screen: now}.
 */
export function construirTraza({ meta, status, bookingsPorPantalla = {}, nowPorPantalla = {}, hoy = '' } = {}) {
  if (!meta) return null;
  const id = String(meta.id);
  const asset = { id, num: meta.num || null, title: meta.title || meta.prompt || null, type: meta.type, mime: meta.mime || null, orientacion: meta.orientacion || null, tags: meta.tags || [], catalogo: meta.catalogo || null, audience: meta.audience || null, ageBucket: meta.ageBucket || null, createdAt: meta.createdAt || null, url: meta.url || null };
  const origen = origenDeExternalId(meta.externalId || meta.externalIdOrigen || meta.externalRefOrigen || '') || (meta.externalRef ? { tipo: 'externo', externalRef: meta.externalRef } : null);
  const reparto = [];
  for (const t of ((status && status.targets) || [])) {
    const hit = (t.items || []).find((x) => String(x.id) === id);
    if (hit) reparto.push({ screen: t.screen, tag: t.tag, lane: t.lane, por: hit.por || 'tag', syncedAt: status.syncedAt || null });
  }
  const pantallas = [];
  for (const [screen, bookings] of Object.entries(bookingsPorPantalla)) {
    const slots = (Array.isArray(bookings) ? bookings : []).filter((b) => String(b.stockId || '') === id);
    if (slots.length) pantallas.push({ screen, fecha: hoy || null, slots: slots.map((b) => ({ bandId: b.bandId, position: b.position ?? null, lane: b.lane || b.category || null, title: b.title || null })) });
  }
  const emision = [];
  for (const [screen, now] of Object.entries(nowPorPantalla)) {
    const item = now && (now.item || now);
    const sid = item && (item.id || item.stockId || now.showing_id);
    if (sid && String(sid) === id) emision.push({ screen, ts: item.ts || now.ts || null, title: item.title || null });
  }
  const estado = emision.length ? 'en_antena' : pantallas.length ? 'en_parrilla' : reparto.length ? 'repartido' : 'en_stock';
  const siguiente_paso = estado === 'en_stock'
    ? 'No casa con ningún objetivo de reparto: añade una etiqueta de circuito (p. ej. canalkioskpubli) o un objetivo por cliente/segmento en POST /grid/tag-targets.'
    : estado === 'repartido' ? 'Casó con un objetivo pero hoy no ocupa slot: la parrilla municipal-50-50 de esa pantalla no tiene huecos libres en su carril.'
    : estado === 'en_parrilla' ? 'Ocupa slot hoy; la pantalla lo emitirá en su banda (signage/now lo confirma al pasar).' : null;
  return { asset, origen, reparto, pantallas, emision, estado, siguiente_paso };
}
