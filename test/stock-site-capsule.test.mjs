import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { siteCapsuleText, siteCapsuleUrl } from '../src/index.js';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('canonicaliza una fuente y elimina únicamente parámetros de seguimiento', () => {
  const url = siteCapsuleUrl('https://developer.nvidia.com/blog/example/?ncid=mail&mkt_tok=secret&chapter=2&utm_source=x#part');
  assert.equal(url.href, 'https://developer.nvidia.com/blog/example/?chapter=2');
});

test('rechaza fuentes capaces de convertir la importación en SSRF', () => {
  for (const value of [
    'http://example.com/a', 'https://localhost/a', 'https://127.0.0.1/a',
    'https://metadata.google.internal/a', 'https://user:pass@example.com/a',
  ]) assert.equal(siteCapsuleUrl(value), null, value);
});

test('extrae el contenido editorial y descarta navegación y scripts', () => {
  const text = siteCapsuleText('<body><nav>No conservar</nav><article><h1>Título</h1><p>Idea &amp; evidencia.</p><script>secreto()</script><p>Aplicación</p></article></body>');
  assert.match(text, /Título/);
  assert.match(text, /Idea & evidencia/);
  assert.match(text, /Aplicación/);
  assert.doesNotMatch(text, /No conservar|secreto/);
});

test('el circuito publica previo y cápsula con tags canónicas y referencia', () => {
  assert.match(source, /path === '\/stock\/site-capsule'/);
  assert.match(source, /type: 'image', motor: 'Site Capsule · preview'/);
  assert.match(source, /type: 'capsula', motor: 'Site Capsule · Gemini'/);
  assert.match(source, /externalRef: preview\.id, thumbnail: preview\.url/);
  assert.match(source, /tags: \['formacion', counselorTag, 'site'\]/);
  assert.match(source, /PARA CARBONO.*PARA SILICIO.*APLICACIÓN/s);
});

test('solo Academy puede solicitar la síntesis y la respuesta distingue reutilización', () => {
  assert.match(source, /origin !== 'https:\/\/admira\.academy'/);
  assert.match(source, /forbidden-origin/);
  assert.match(source, /reused: true/);
  assert.match(source, /reused: false/);
});
