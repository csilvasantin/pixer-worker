import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('el worker expone la edición de vídeo antes del polling genérico', () => {
  const route = source.indexOf("path === '/xai/video/edit'");
  const poll = source.indexOf("path.startsWith('/xai/video/')");
  assert.ok(route > 0, 'falta POST /xai/video/edit');
  assert.ok(route < poll, 'la ruta exacta debe resolverse antes que el polling genérico');
});

test('la edición usa el endpoint xAI y no acepta entradas opacas', () => {
  assert.match(source, /api\.x\.ai\/v1\/videos\/edits/);
  assert.match(source, /bad-video-url/);
  assert.match(source, /new URL\(videoUrl\)/);
  assert.match(source, /source\.protocol === 'https:'/);
  assert.match(source, /data:video\\\//);
  assert.match(source, /video: \{ url: videoUrl \}/);
});

test('la edición que genera gasto exige token y restringe el origen del vídeo', () => {
  assert.match(source, /unauthorized-video-edit/);
  assert.match(source, /X-AdmiraNeXT-Ingest/);
  assert.match(source, /env\.ADMIRANEXT_INGEST_TOKEN/);
  assert.match(source, /source\.hostname === 'api\.admira\.store'/);
  assert.match(source, /source\.hostname === 'assets\.admira\.store'/);
});
