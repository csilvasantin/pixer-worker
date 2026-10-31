import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImportFlags, buildCapsulaEncargo } from '../src/telegram-capsula.mjs';

test('sin etiquetas: import intacto', () => {
  assert.deepEqual(parseImportFlags('mira esto #ia'), { capsula: false, formato: false, comment: 'mira esto #ia' });
});
test('#capsula se detecta y se quita', () => {
  const f = parseImportFlags('#capsula buen vídeo #ia');
  assert.equal(f.capsula, true); assert.equal(f.formato, false); assert.equal(f.comment, 'buen vídeo #ia');
});
test('#formato solo implica cápsula', () => {
  assert.deepEqual(parseImportFlags('#Formato'), { capsula: true, formato: true, comment: '' });
});
test('no confunde #capsulas ni hashtags pegados', () => {
  assert.equal(parseImportFlags('#capsulas x#capsula').capsula, false);
});
test('encargo: formato → ambas orientaciones desde meta', () => {
  const b = buildCapsulaEncargo({ url: 'u', borrador: { guion: {}, source: {} }, flags: { capsula: true, formato: true }, orientacion: 'horizontal' });
  assert.deepEqual(b.formatos, ['horizontal', 'vertical']);
  assert.equal(b.requestedBy, 'AdmiraXPBot'); assert.equal(b.autoApprove, true);
  assert.equal(b.preroll && b.postroll, true);
});
test('encargo: solo capsula → una orientación', () => {
  const b = buildCapsulaEncargo({ url: 'u', borrador: {}, flags: { capsula: true }, orientacion: 'vertical' });
  assert.deepEqual(b.formatos, ['vertical']);
});
