import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STOCK_TAGS_MAX,
  applyCatalogoTags,
  applyMetaPatch,
  buildCatalogos,
  catalogoHashtags,
  composeTags,
  isVigente,
  itemHasTag,
  itemMatchesQuery,
  sanitizeCatalogo,
  slugify,
} from '../src/stock-catalogo.mjs';

const ALCAMPO = { id: 'alcampo-2026-09-10', cliente: 'alcampo', nombre: 'Alcampo · 10–23 sep 2026', desde: '2026-09-10', hasta: '2026-09-23', proyecto: 'admira-tv', producto: 'coca-cola' };

test('sanitizeCatalogo: slugs [a-z0-9-], fechas ISO, nombre ≤120', () => {
  const c = sanitizeCatalogo({ ...ALCAMPO, id: ' Alcampo 2026/09/10 ', cliente: 'ALCAMPO S.A.', producto: 'Langostino cocido · 9,85 €', proyecto: 'Admira TV', nombre: 'x'.repeat(200), desde: '2026-09-10T08:00:00Z', hasta: '23/09/2026' });
  assert.equal(c.id, 'alcampo-2026-09-10');
  assert.equal(c.cliente, 'alcampo-s-a');
  assert.equal(c.producto, 'langostino-cocido-9-85');
  assert.equal(c.proyecto, 'admira-tv');
  assert.equal(c.nombre.length, 120);
  assert.equal(c.desde, '2026-09-10');
  assert.equal(c.hasta, null, 'fecha no ISO se descarta');
  assert.match(JSON.stringify(c), /^[^A-Z]*$/, 'ningún campo slug lleva mayúsculas');
});

test('sanitizeCatalogo: sin id → null; cliente se deriva del id; hasta < desde se iguala', () => {
  assert.equal(sanitizeCatalogo(null), null);
  assert.equal(sanitizeCatalogo({ cliente: 'alcampo' }), null);
  assert.equal(sanitizeCatalogo('alcampo'), null);
  const c = sanitizeCatalogo({ id: 'alcampo-2026-09-10', desde: '2026-09-10', hasta: '2026-09-01' });
  assert.equal(c.cliente, 'alcampo');
  assert.equal(c.hasta, '2026-09-10');
  assert.equal(c.nombre, null);
});

test('slugify quita acentos y símbolos', () => {
  assert.equal(slugify('Mejillón · 2,25 € · Alcampo'), 'mejillon-2-25-alcampo');
  assert.equal(slugify('  '), '');
});

test('hashtags automáticos: catalogo · cliente · id · AAAA-MM', () => {
  assert.deepEqual(catalogoHashtags(sanitizeCatalogo(ALCAMPO)), ['catalogo', 'alcampo', 'alcampo-2026-09-10', '2026-09']);
  assert.deepEqual(catalogoHashtags(sanitizeCatalogo({ id: 'alcampo-x' })), ['catalogo', 'alcampo', 'alcampo-x']);
  assert.deepEqual(catalogoHashtags(null), []);
});

test('tope de tags 10: se recortan los del cliente, nunca los hashtags ni la calidad', () => {
  assert.equal(STOCK_TAGS_MAX, 10);
  const cliente = ['admiranext', 'tiktok', 'vertical', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
  const tags = applyCatalogoTags(cliente, sanitizeCatalogo(ALCAMPO), { quality: 'best' });
  assert.equal(tags.length, 10);
  for (const t of ['catalogo', 'alcampo', 'alcampo-2026-09-10', '2026-09', 'best']) assert.ok(tags.includes(t), t);
  assert.deepEqual(tags.slice(0, 5), ['admiranext', 'tiktok', 'vertical', 'c1', 'c2'], 'los del cliente conservan el orden y se recortan por el final');
  assert.ok(!tags.includes('c8'));
});

test('sin catálogo solo entra la calidad; no se repiten ni se pasa del tope', () => {
  assert.deepEqual(applyCatalogoTags(['#Tiktok', 'tiktok ', 'best'], null, { quality: 'best' }), ['tiktok', 'best']);
  assert.equal(composeTags(Array.from({ length: 30 }, (_, i) => 't' + i)).length, 10);
  assert.deepEqual(composeTags(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
});

test('cambiar de catálogo retira los hashtags del anterior', () => {
  const prev = sanitizeCatalogo(ALCAMPO);
  const next = sanitizeCatalogo({ id: 'carrefour-2026-10-01', cliente: 'carrefour', desde: '2026-10-01' });
  const tags = applyCatalogoTags(['admiranext', ...catalogoHashtags(prev), 'best'], next, { quality: 'best', previous: prev });
  assert.deepEqual(tags, ['admiranext', 'catalogo', 'best', 'carrefour', 'carrefour-2026-10-01', '2026-10']);
});

test('filtros: tag y búsqueda libre q= sobre título, tags y catálogo', () => {
  const item = { id: 'auto-1', num: 7, title: 'Langostino cocido · 9,85 € · Alcampo', tags: ['admiranext', 'catalogo', 'alcampo'], catalogo: sanitizeCatalogo(ALCAMPO) };
  assert.ok(itemHasTag(item, '#Alcampo'));
  assert.ok(!itemHasTag(item, 'carrefour'));
  assert.ok(itemMatchesQuery(item, 'langostino alcampo'));
  assert.ok(itemMatchesQuery(item, '#2026-09-10'), 'busca por id de catálogo');
  assert.ok(itemMatchesQuery(item, 'coca-cola'), 'busca por producto del catálogo');
  assert.ok(!itemMatchesQuery(item, 'mejillon'));
  assert.ok(itemMatchesQuery(item, ''));
});

test('buildCatalogos agrupa, cuenta, ordena por ultimo y calcula vigente', () => {
  const items = [
    { id: 'a', createdAt: '2026-09-11T18:14:54.000Z', catalogo: ALCAMPO },
    { id: 'b', createdAt: '2026-09-12T10:11:46.000Z', catalogo: { ...ALCAMPO, nombre: 'Alcampo corregido' } },
    { id: 'c', createdAt: '2026-08-01T00:00:00.000Z', catalogo: { id: 'dia-2026-08-01', cliente: 'dia', desde: '2026-08-01', hasta: '2026-08-15' } },
    { id: 'd', createdAt: '2026-09-12T00:00:00.000Z' },
  ];
  const cats = buildCatalogos(items, { today: '2026-09-12' });
  assert.equal(cats.length, 2);
  assert.equal(cats[0].id, 'alcampo-2026-09-10');
  assert.equal(cats[0].count, 2);
  assert.equal(cats[0].ultimo, '2026-09-12T10:11:46.000Z');
  assert.equal(cats[0].nombre, 'Alcampo corregido', 'los campos los aporta la pieza más reciente');
  assert.deepEqual(cats[0].ids, ['b', 'a']);
  assert.equal(cats[0].vigente, true);
  assert.equal(cats[0].proyecto, 'admira-tv');
  assert.equal(cats[1].vigente, false);
  assert.equal(buildCatalogos(Array.from({ length: 600 }, (_, i) => ({ id: 'x' + i, createdAt: '2026-09-01', catalogo: { id: 'z' } })))[0].ids.length, 500);
});

test('isVigente respeta los límites y no da vigente sin fechas', () => {
  const c = sanitizeCatalogo(ALCAMPO);
  assert.equal(isVigente(c, '2026-09-10'), true);
  assert.equal(isVigente(c, '2026-09-23'), true);
  assert.equal(isVigente(c, '2026-09-24'), false);
  assert.equal(isVigente(sanitizeCatalogo({ id: 'sin-fechas' }), '2026-09-12'), false);
});

test('applyMetaPatch: backfill de catálogo + tags_add/tags_remove recalcula hashtags', () => {
  const meta = { id: 'auto-b8c9a17f83c5ce996bfd', type: 'video', quality: 'best', tags: ['admiranext', 'tiktok', 'vertical', 'catalogo', 'best'], title: 'Langostino cocido · 9,85 € · Alcampo' };
  const r = applyMetaPatch(meta, { catalogo: { ...ALCAMPO, producto: 'langostino-cocido' }, tags_add: ['pescaderia'], tags_remove: ['vertical'] });
  assert.equal(r.error, null);
  assert.equal(r.changed, true);
  assert.equal(r.meta.catalogo.producto, 'langostino-cocido');
  assert.deepEqual(r.meta.tags, ['admiranext', 'tiktok', 'catalogo', 'best', 'pescaderia', 'alcampo', 'alcampo-2026-09-10', '2026-09']);
  assert.equal(meta.tags.length, 5, 'no muta el meta original');
  // Sin cambios → changed false
  assert.equal(applyMetaPatch(r.meta, { tags_add: ['pescaderia'] }).changed, false);
  // catalogo inválido → error; catalogo null → se retira y se van sus hashtags
  assert.equal(applyMetaPatch(r.meta, { catalogo: { cliente: 'x' } }).error, 'bad-catalogo');
  const off = applyMetaPatch(r.meta, { catalogo: null });
  assert.equal(off.meta.catalogo, undefined);
  assert.deepEqual(off.meta.tags, ['admiranext', 'tiktok', 'best', 'pescaderia']);
});

test('index.js cablea el contrato: tope 10, meta.catalogo, /stock/catalogos, PATCH /stock/:id/meta, CORS', async () => {
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from './stock-catalogo.mjs'"));
  assert.ok(src.includes('.slice(0, STOCK_TAGS_MAX)'), 'publish usa el tope nuevo');
  assert.ok(!src.includes('.filter(Boolean).slice(0,4)'), 'ya no corta a 4');
  assert.ok(src.includes("path === '/stock/catalogos' && req.method === 'GET'"));
  assert.ok(src.includes("req.method === 'PATCH'"));
  assert.ok(src.includes("'POST, GET, PATCH, DELETE, OPTIONS'"));
  assert.ok(src.includes('X-AdmiraNeXT-Ingest, X-Notify-Key'));
  assert.ok(src.includes("url.searchParams.get('catalogo')") && src.includes("url.searchParams.get('cliente')") && src.includes("url.searchParams.get('tag')") && src.includes("url.searchParams.get('q')"));
});
