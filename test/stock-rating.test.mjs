import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('la valoración acepta sólo estrellas de 1 a 5 y conserva un voto por navegador', () => {
  assert.match(source, /async function stockRatingHandler/);
  assert.match(source, /Number\.isInteger\(value\) \|\| value < 1 \|\| value > 5/);
  assert.match(source, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(source, /votes\[voterHash\] = value/);
  assert.match(source, /yourRating: value/);
});

test('el índice expone sólo la media y el número de votos', () => {
  assert.match(source, /meta\.rating = rating/);
  assert.match(source, /const rating = \{ average:/);
  assert.match(source, /stock\/\$\{id\}\/ratings\.json/);
  assert.match(source, /path\.match\(\/\^\\\/stock\\\/\[\^\/\]\+\\\/rating\$\//);
});

test('el consumo de cápsulas cuenta una sola apertura por sesión', () => {
  assert.match(source, /\['play', 'consume'\]/);
  assert.match(source, /stock\/\$\{id\}\/consumptions\.json/);
  assert.match(source, /views\[viewerHash\] = Date\.now\(\)/);
  assert.match(source, /meta\.consumptions = consumptions/);
  assert.match(source, /reused = Object\.prototype\.hasOwnProperty\.call\(views, viewerHash\)/);
});
