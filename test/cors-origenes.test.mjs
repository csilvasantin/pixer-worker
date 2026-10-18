import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// admira.store y xpaceos.com son gemelos: los dos tienen que poder hablar con la API.
const preflight = origin => worker.fetch(new Request('https://api.admira.store/signage/feed?limit=1', {
  method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
}), {}, { waitUntil() {} });

test('admira.store y www.admira.store pasan el preflight igual que xpaceos.com', async () => {
  for (const origin of ['https://www.admira.store', 'https://admira.store', 'https://www.xpaceos.com']) {
    const r = await preflight(origin);
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), origin);
  }
});

test('un origen que no está en la lista no se refleja', async () => {
  const r = await preflight('https://admira.store.example.com');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://csilvasantin.github.io');
});
