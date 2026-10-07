// Vocabulario canónico de etiquetas (Carlos, 7-oct-2026: «normaliza al guardar»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAG_CANON, applyCatalogoTags, applyMetaPatch, canonTag, cleanTag, composeTags, itemHasTag, tagKey } from '../src/stock-catalogo.mjs';
import { motivoDeReparto, tagsDeItem } from '../src/stock-via1.mjs';

test('una variante conocida se guarda en su forma buena; lo demás no se toca', () => {
  assert.equal(canonTag('Musica'), 'música');
  assert.equal(canonTag('#TECH'), 'tecnología');
  assert.equal(canonTag('gaming'), 'videojuego');
  assert.equal(canonTag('Videojuegos'), 'videojuego');
  assert.equal(canonTag('digital twin'), 'digital-twin');
  assert.equal(canonTag('robot'), 'robots');
  assert.equal(canonTag('Jazz Fusión'), 'jazz fusión', 'no se inventan ni se quitan tildes fuera de la tabla');
  assert.equal(canonTag('formacion'), 'formacion');
  for (const sistema of ['animaciones', 'song', 'good', 'better', 'best', 'default', 'expandido', 'catalogo']) assert.equal(canonTag(sistema), sistema, sistema + ' es de sistema');
  assert.equal(canonTag('  '), '');
});

test('la tabla no encadena ni se contradice', () => {
  for (const [de, a] of Object.entries(TAG_CANON)) {
    assert.notEqual(de, a);
    assert.equal(canonTag(a), a, a + ' ya es canónica');
    assert.equal(cleanTag(a), a, a + ' sobrevive al saneado');
  }
});

test('al publicar y al editar, las etiquetas libres se canonizan y no se repiten; las del catálogo no', () => {
  assert.deepEqual(composeTags(['Musica', 'música', 'tech', 'IA', 'ai']), ['música', 'tecnología', 'ia']);
  const catalogo = { id: 'robot-2026-10', cliente: 'robot', desde: '2026-10-01' };
  const tags = applyCatalogoTags(['business', 'oferta'], catalogo, { quality: 'good' });
  assert.deepEqual(tags.slice(0, 2), ['negocio', 'ofertas']);
  assert.ok(tags.includes('robot'), 'el hashtag del cliente del catálogo es un identificador: se queda tal cual');
  assert.ok(tags.includes('good'));
  const { meta, changed } = applyMetaPatch({ tags: ['cine', 'good'], quality: 'good' }, { tags_add: ['Peliculas', 'creativity'] });
  assert.equal(changed, true);
  assert.deepEqual(meta.tags, ['cine', 'good', 'películas', 'creatividad'], 'las que ya estaban conservan su sitio');
});

test('editar una pieza antigua quita la forma vieja y deja la buena', () => {
  const { meta } = applyMetaPatch({ tags: ['tech', 'ia', 'good'], quality: 'good' }, { tags_remove: ['tech'], tags_add: ['tecnología'] });
  assert.deepEqual(meta.tags, ['ia', 'good', 'tecnología']);
  const tocada = applyMetaPatch({ tags: ['musica', 'rock', 'good'], quality: 'good' }, { tags_add: ['directo'] }).meta;
  assert.deepEqual(tocada.tags, ['música', 'rock', 'good', 'directo'], 'cualquier edición deja las etiquetas en su forma buena');
});

test('buscar por etiqueta encuentra lo mismo con cualquier forma', () => {
  const pieza = { tags: ['música', 'tecnología', 'videojuego'] };
  for (const q of ['musica', 'Música', '#music', 'tech', 'TECNOLOGIA', 'gaming', 'videojuegos']) assert.equal(itemHasTag(pieza, q), true, q);
  assert.equal(itemHasTag(pieza, 'negocio'), false);
  assert.equal(itemHasTag({ tags: ['tech'] }, 'tecnología'), true, 'también las piezas que aún no se han migrado');
  assert.equal(tagKey('Digital_Twin'), tagKey('digital-twin'));
});

test('el reparto por etiqueta casa sin tildes', () => {
  assert.ok(tagsDeItem({ tags: ['Música', '#Café'] }).has('musica'));
  assert.equal(motivoDeReparto({ tags: ['música'] }, { tag: 'musica' }), 'tag');
  assert.equal(motivoDeReparto({ tags: ['música'] }, { tag: 'música' }), 'tag');
  assert.equal(motivoDeReparto({ tags: ['rock'] }, { tag: 'musica' }), null);
});
