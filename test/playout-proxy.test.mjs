import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('the public API proxies playout orchestration through OMNI', () => {
  assert.match(source, /path === '\/playout' \|\| path\.startsWith\('\/playout\/'\)/);
  assert.match(source, /res = await omnipublicityProxyHandler\(req, env\)/);
});

test('the proxy preserves bearer authentication for protected writes', () => {
  assert.match(source, /req\.headers\.get\('Authorization'\)/);
  assert.match(source, /init\.headers\.Authorization = authorization/);
  assert.match(source, /'Access-Control-Allow-Headers': 'Content-Type, Authorization'/);
});
