import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  dedupWindowMs,
  isSha256Hex,
  mergeReplacedMeta,
  recentFingerprintInput,
  stockDedupDecision,
} from '../src/stock-dedup.mjs';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const ID = 'auto-0123456789abcdef0123';
const taken = { id: ID, externalRef: ID, contentHash: H1, assetKey: `stock/${ID}/asset.mp4`, num: 42, rating: { average: 4, votes: 3 }, createdAt: '2026-09-01T00:00:00.000Z', thumbnail: 'https://x/poster.jpg' };

test('sin externalId, mismo contenido en otro asset → reused duplicate_content con el id existente', () => {
  const d = stockDedupDecision({ id: '1-abc', externalId: '', contentHash: H1, hashOwnerId: 'viejo' });
  assert.deepEqual(d, { action: 'reuse', reason: 'duplicate_content', id: 'viejo' });
});

test('sin externalId y sin coincidencia → create', () => {
  const d = stockDedupDecision({ id: '1-abc', contentHash: H1, hashOwnerId: null });
  assert.equal(d.action, 'create');
  assert.equal(d.id, '1-abc');
});

test('regla blanda: reciente solo cuenta sin externalId y cuando no hay hash que mande', () => {
  assert.deepEqual(stockDedupDecision({ id: '1-abc', recentOwnerId: 'reciente' }), { action: 'reuse', reason: 'duplicate_recent', id: 'reciente' });
  assert.equal(stockDedupDecision({ id: ID, externalId: 'admiranext:test:dedup', recentOwnerId: 'reciente' }).action, 'create');
  assert.equal(stockDedupDecision({ id: '1-abc', contentHash: H1, hashOwnerId: 'viejo', recentOwnerId: 'reciente' }).id, 'viejo');
});

test('externalId ocupado con el mismo hash → reused duplicate_external_id', () => {
  const d = stockDedupDecision({ id: ID, externalId: 'admiranext:test:dedup', existingMeta: taken, contentHash: H1 });
  assert.deepEqual(d, { action: 'reuse', reason: 'duplicate_external_id', id: ID });
  const viaIndex = stockDedupDecision({ id: ID, externalId: 'admiranext:test:dedup', existingMeta: { ...taken, contentHash: null }, contentHash: H1, hashOwnerId: ID });
  assert.equal(viaIndex.action, 'reuse');
});

test('externalId ocupado con contenido distinto → replace conservando el id', () => {
  const d = stockDedupDecision({ id: ID, externalId: 'admiranext:test:dedup', existingMeta: taken, contentHash: H2 });
  assert.deepEqual(d, { action: 'replace', reason: 'external_id_new_content', id: ID });
  const legacy = stockDedupDecision({ id: ID, externalId: 'admiranext:test:dedup', existingMeta: { ...taken, contentHash: undefined }, contentHash: H2 });
  assert.deepEqual(legacy, { action: 'replace', reason: 'external_id_unhashed', id: ID });
});

test('externalId ocupado sin hash aún (antes de descargar) → sigue adelante', () => {
  const d = stockDedupDecision({ id: ID, externalId: 'admiranext:test:dedup', existingMeta: taken, contentHash: null });
  assert.equal(d.action, 'create');
  assert.equal(d.reason, 'needs_content');
});

test('un meta bajo el mismo id pero sin externalRef no cuenta como identidad ocupada', () => {
  const d = stockDedupDecision({ id: ID, externalId: 'admiranext:test:dedup', existingMeta: { ...taken, externalRef: null }, contentHash: H2 });
  assert.equal(d.action, 'create');
});

test('al sustituir se conservan num, valoración, alta y cara; cambian hash y tamaño', () => {
  const fresh = { id: ID, contentHash: H2, size: 999, mime: 'video/mp4', ext: 'mp4', assetKey: `stock/${ID}/asset.mp4`, thumbnail: null, createdAt: '2026-09-11T18:00:00.000Z' };
  const m = mergeReplacedMeta(taken, fresh, Date.parse('2026-09-11T18:00:00.000Z'));
  assert.equal(m.num, 42);
  assert.equal(m.rating.votes, 3);
  assert.equal(m.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(m.thumbnail, 'https://x/poster.jpg');
  assert.equal(m.contentHash, H2);
  assert.equal(m.size, 999);
  assert.equal(m.replacedFromHash, H1);
  assert.equal(m.replacedAt, '2026-09-11T18:00:00.000Z');
});

test('ventana configurable por STOCK_DEDUP_WINDOW_MIN (10 min por defecto, 0 apaga)', () => {
  assert.equal(dedupWindowMs({}), 10 * 60 * 1000);
  assert.equal(dedupWindowMs({ STOCK_DEDUP_WINDOW_MIN: '3' }), 3 * 60 * 1000);
  assert.equal(dedupWindowMs({ STOCK_DEDUP_WINDOW_MIN: '0' }), 0);
  assert.equal(dedupWindowMs({ STOCK_DEDUP_WINDOW_MIN: 'x' }), 10 * 60 * 1000);
});

test('la tupla reciente exige motor y sourceUrl y normaliza el título', () => {
  assert.equal(recentFingerprintInput({ title: ' Prueba ', motor: 'Veo', sourceUrl: 'https://a/b.mp4' }), 'prueba\nveo\nhttps://a/b.mp4');
  assert.equal(recentFingerprintInput({ title: 'x', motor: 'Veo' }), null);
  assert.equal(recentFingerprintInput({ title: 'x', sourceUrl: 'https://a' }), null);
});

test('isSha256Hex solo acepta 64 hex en minúsculas', () => {
  assert.ok(isSha256Hex(H1));
  assert.ok(!isSha256Hex(H1.toUpperCase()));
  assert.ok(!isSha256Hex('abc'));
  assert.ok(!isSha256Hex(null));
});

// Cableado en el worker (mismo patrón que el resto de tests del repo).
const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('el publish calcula sha256 en los dos carriles y lo guarda en meta.contentHash', () => {
  assert.match(source, /contentHash = sha256HexOf\(await crypto\.subtle\.digest\('SHA-256', bytes\)\)/);
  assert.match(source, /new crypto\.DigestStream\('SHA-256'\)/);
  assert.match(source, /if \(digest\) contentHash = sha256HexOf\(await digest\.digest\)/);
  assert.match(source, /\n\s+contentHash,\n\s+createdAt: new Date\(ts\)\.toISOString\(\),/);
});

test('los índices KV de dedup se escriben antes de responder y se olvidan al borrar', () => {
  assert.match(source, /await Promise\.all\(\[\n\s+stockRememberHash\(env, contentHash, id\),\n\s+stockRememberRecent\(env, recentInput, id\),/);
  assert.match(source, /if \(meta && meta\.contentHash\) ctx\.waitUntil\(stockForgetHash\(env, meta\.contentHash\)\)/);
  assert.match(source, /STOCK_HASH_KV_PREFIX \+ hash/);
});

test('DELETE /stock/:id exige clave y existe GET /stock/exists', () => {
  assert.match(source, /if \(!\(await stockDeleteAuthorized\(req, env, new URL\(req\.url\)\)\)\) return json\(\{ error: 'unauthorized' \}, \{ status: 401 \}\)/);
  assert.match(source, /path === '\/stock\/exists' && req\.method === 'GET'/);
  assert.match(source, /stockIngestAuthorized\(req\.headers\.get\('X-AdmiraNeXT-Ingest'\), env\.ADMIRANEXT_INGEST_TOKEN\)\) return true/);
});

test('la respuesta de sustitución lleva replaced:true y la de reutilización lleva reason', () => {
  assert.match(source, /\.\.\.\(replacing \? \{ replaced: true, reason: decision\.reason \} : \{\}\)/);
  assert.match(source, /ok: true, reused: true, reason, id: ownerId/);
});
