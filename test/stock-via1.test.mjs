import test from 'node:test';
import assert from 'node:assert/strict';
import { siguienteNum, renumerarDuplicados, etiquetasHonestas, objetivosDeReparto, motivoDeReparto, claveObjetivo, origenDeExternalId, construirTraza } from '../src/stock-via1.mjs';

test('num al publicar: max(KV, índice)+1; duplicados se renumeran conservando el más antiguo', () => {
  assert.equal(siguienteNum([{ num: 1012 }, { num: 3 }], 0), 1013);
  assert.equal(siguienteNum([{ num: 1012 }], 1020), 1021, 'el contador KV manda si el índice va viejo');
  assert.equal(siguienteNum([], null), 1);
  const metas = [{ id: 'a', num: 5, createdAt: '2026-09-15T10:00:00Z' }, { id: 'b', num: 5, createdAt: '2026-09-15T10:00:01Z' }, { id: 'c', num: 7, createdAt: '2026-09-15T09:00:00Z' }, { id: 'd', num: 7, createdAt: '2026-09-15T08:00:00Z' }];
  const cambiados = renumerarDuplicados(metas);
  assert.deepEqual(cambiados.map((m) => [m.id, m.num]), [['b', 8], ['c', 9]]);
  assert.equal(metas.find((m) => m.id === 'a').num, 5); assert.equal(metas.find((m) => m.id === 'd').num, 7);
});

test('etiquetas honestas: la orientación real del máster sustituye a la declarada; sin dimensiones no se toca', () => {
  const r = etiquetasHonestas(['admiranext', 'tiktok', 'horizontal', 'catalogo', 'alcampo'], { ancho: 1080, alto: 1920 });
  assert.deepEqual(r.tags, ['admiranext', 'tiktok', 'vertical', 'catalogo', 'alcampo']); assert.equal(r.orientacion, 'vertical'); assert.equal(r.corregida, true);
  const ok = etiquetasHonestas(['tiktok', 'vertical'], { ancho: 1080, alto: 1920 }); assert.equal(ok.corregida, false); assert.deepEqual(ok.tags, ['tiktok', 'vertical']);
  const sin = etiquetasHonestas(['tiktok', 'best'], { ancho: 1920, alto: 1080 }); assert.deepEqual(sin.tags, ['tiktok', 'best', 'horizontal']);
  const nada = etiquetasHonestas(['tiktok', 'vertical'], null); assert.equal(nada.orientacion, null); assert.deepEqual(nada.tags, ['tiktok', 'vertical']);
});

test('reparto: objetivos por etiqueta, por cliente de catálogo o por segmento; sin duplicados', () => {
  const base = [{ screen: 'sim-gracia-kiosko', tag: 'canalkioskpubli', lane: 'publicidad' }];
  const extra = [{ screen: 'sim-gracia-kiosko', tag: '#canalkioskpubli', lane: 'publicidad' }, { screen: 'xtore-escaparate-pn1w', cliente: 'Alcampo', lane: 'publicidad' }, { screen: 'mupi-1', audience: 'f', age: 'joven', lane: 'publicidad' }, { screen: '', tag: 'x' }, { screen: 'y', lane: 'z' }];
  const t = objetivosDeReparto(base, extra);
  assert.deepEqual(t.map(claveObjetivo), ['canalkioskpubli', 'cliente:alcampo', 'seg:f:joven']);
  const pieza = { tags: ['admiranext', 'tiktok', 'vertical', 'catalogo', 'alcampo'], catalogo: { cliente: 'alcampo' }, audience: 'all', segmentation: null };
  assert.equal(motivoDeReparto(pieza, t[0]), null);
  assert.equal(motivoDeReparto(pieza, t[1]), 'cliente');
  assert.equal(motivoDeReparto(pieza, t[2]), null, 'audience all no casa un objetivo f');
  assert.equal(motivoDeReparto({ tags: ['canalkioskpubli'] }, t[0]), 'tag');
  assert.equal(motivoDeReparto({ audience: 'f', segmentation: { ageBuckets: ['joven'] } }, t[2]), 'segmento');
  assert.equal(motivoDeReparto({ audience: 'f', ageBucket: 'adulto' }, t[2]), null);
});

test('traza: origen del externalId, reparto, parrilla y antena → estado y siguiente paso', () => {
  assert.deepEqual(origenDeExternalId('admiranext:catalogo:alcampo-2026-09-10:leche-entera:16x9'), { tipo: 'catalogo', catalogo_id: 'alcampo-2026-09-10', producto: 'leche-entera', horizontal: true, catalogo_url: 'https://admira.tv/contentcatalogue/?catalogo=alcampo-2026-09-10' });
  assert.equal(origenDeExternalId('admiranext:xtore:coche').lane, 'coche');
  const meta = { id: 'auto-1', num: 1013, type: 'video', tags: ['tiktok', 'vertical', 'alcampo'], catalogo: { cliente: 'alcampo' }, externalId: 'admiranext:catalogo:alcampo-2026-09-10:leche', createdAt: '2026-09-15T10:00:00Z' };
  const solo = construirTraza({ meta, status: { targets: [] } });
  assert.equal(solo.estado, 'en_stock'); assert.match(solo.siguiente_paso, /etiqueta de circuito/); assert.equal(solo.origen.tipo, 'catalogo');
  const status = { syncedAt: 1, targets: [{ screen: 'xtore-escaparate-pn1w', tag: 'cliente:alcampo', lane: 'publicidad', items: [{ id: 'auto-1', por: 'cliente' }] }] };
  const rep = construirTraza({ meta, status }); assert.equal(rep.estado, 'repartido'); assert.equal(rep.reparto[0].por, 'cliente');
  const par = construirTraza({ meta, status, hoy: '2026-09-15', bookingsPorPantalla: { 'xtore-escaparate-pn1w': [{ stockId: 'auto-1', bandId: 'b1', position: 2, lane: 'publicidad', title: 'Leche' }, { stockId: 'otro' }] } });
  assert.equal(par.estado, 'en_parrilla'); assert.deepEqual(par.pantallas[0].slots[0], { bandId: 'b1', position: 2, lane: 'publicidad', title: 'Leche' });
  const ant = construirTraza({ meta, status, nowPorPantalla: { 'xtore-escaparate-pn1w': { item: { id: 'auto-1', ts: 5, title: 'Leche' } } } });
  assert.equal(ant.estado, 'en_antena'); assert.equal(ant.emision[0].screen, 'xtore-escaparate-pn1w');
});
