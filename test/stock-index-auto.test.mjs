import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { upsertStockIndex, STOCK_INDEX_KEY } from '../src/stock-index.mjs';
import worker, { stockPublishHandler } from '../src/index.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const meta = (id, extra = {}) => ({ id, num: 1, type: 'video', motor: 'local', tags: ['starbucks'],
  assetKey: `stock/${id}/asset.mp4`, createdAt: '2026-10-14T08:00:00.000Z', ...extra });
class Bucket {
  map = new Map(); sequence = 0; puts = []; conflicts = 0;
  onGet = null; onPut = null; onList = null;
  seed(key, value) { this.map.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), etag: `e${++this.sequence}` }); }
  constructor(items = []) { this.seed(STOCK_INDEX_KEY, { items, total: items.length }); }
  async get(key) {
    const record = this.map.get(key);
    const object = record ? { etag: record.etag, httpEtag: `"${record.etag}"`, body: record.value,
      json: async () => JSON.parse(record.value), text: async () => record.value } : null;
    if (this.onGet) await this.onGet(key, object);
    return object;
  }
  async head(key) { const record = this.map.get(key); return record ? { etag: record.etag } : null; }
  async put(key, value, options = {}) {
    this.puts.push({ key, options });
    if (this.onPut) { const result = await this.onPut(key, value, options); if (result !== undefined) return result; }
    const current = this.map.get(key), condition = options.onlyIf;
    if (condition && ((condition.etagMatches !== undefined && condition.etagMatches !== current?.etag)
      || (condition.etagDoesNotMatch === '*' && current))) { this.conflicts++; return null; }
    this.seed(key, typeof value === 'string' ? value : value);
    return { etag: this.map.get(key).etag };
  }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.map.delete(k); }
  async list({ prefix = '' } = {}) {
    const objects = [...this.map.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key }));
    if (this.onList) await this.onList();
    return { objects, truncated: false };
  }
  index() { return JSON.parse(this.map.get(STOCK_INDEX_KEY).value); }
}
class KV {
  map = new Map();
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '' } = {}) { return { keys: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; }
}
const context = () => ({ pending: [], waitUntil(promise) { this.pending.push(Promise.resolve(promise).catch(() => {})); } });
const publishRequest = (content = 'a-real-import-test', extra = {}) => new Request('https://api.admira.store/stock/publish', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    type: 'video', motor: 'local', mime: 'video/mp4', base64: btoa(content),
    comment: '#starbucks #paseodegracia103 #ipad', tags: null, ...extra,
  }),
});

test('simultaneous imports retry the stale ETag and preserve both IDs and the existing catalogue', async () => {
  const bucket = new Bucket([meta('old')]), bothRead = deferred(); let snapshots = 0;
  bucket.onGet = async key => { if (key !== STOCK_INDEX_KEY || snapshots >= 2) return;
    if (++snapshots === 2) bothRead.resolve(); await bothRead.promise; };
  const results = await Promise.all([upsertStockIndex(bucket, meta('first')), upsertStockIndex(bucket, meta('second'))]);
  assert.deepEqual(bucket.index().items.map(x => x.id).sort(), ['first', 'old', 'second']);
  assert.equal(bucket.index().total, 3);
  assert.equal(bucket.conflicts, 1);
  assert.equal(Math.max(...results.map(x => x.attempts)), 2);
  for (const put of bucket.puts) assert.ok(put.options.onlyIf, 'every index write must be conditional');
});

test('null conditional writes exhaust their retry budget without changing the published catalogue', async () => {
  const bucket = new Bucket([meta('old')]);
  bucket.onPut = async key => key === STOCK_INDEX_KEY ? null : undefined;
  await assert.rejects(upsertStockIndex(bucket, meta('new'), x => x, { attempts: 3 }), /conflict/);
  assert.equal(bucket.puts.length, 3);
  assert.deepEqual(bucket.index().items.map(x => x.id), ['old']);
});

test('a storage exception propagates and never reports an index commit', async () => {
  const bucket = new Bucket([meta('old')]); bucket.onPut = async () => { throw new Error('R2 unavailable'); };
  await assert.rejects(upsertStockIndex(bucket, meta('new')), /R2 unavailable/);
  assert.deepEqual(bucket.index().items.map(x => x.id), ['old']);
});

test('corrupt JSON and structurally invalid documents fail closed without overwriting the index', async () => {
  for (const invalid of ['{broken', '{}', '{"items":null}', 'null']) {
    const bucket = new Bucket(); bucket.seed(STOCK_INDEX_KEY, invalid);
    await assert.rejects(upsertStockIndex(bucket, meta('new')));
    assert.equal(bucket.puts.length, 0);
    assert.equal(bucket.map.get(STOCK_INDEX_KEY).value, invalid);
  }
});

test('retries are idempotent, replacement updates the row, and hidden content is removed', async () => {
  const bucket = new Bucket([meta('same', { title: 'old' }), meta('other')]);
  for (let i = 0; i < 2; i++) await upsertStockIndex(bucket, meta('same', { title: 'replacement' }), x => ({ ...x, url: `https://stock.admira.store/${x.assetKey}` }));
  assert.equal(bucket.index().total, 2);
  assert.equal(bucket.index().items.find(x => x.id === 'same').title, 'replacement');
  assert.equal(bucket.index().items.find(x => x.id === 'same').url, 'https://stock.admira.store/stock/same/asset.mp4');
  await upsertStockIndex(bucket, meta('same', { oculto: true }));
  assert.deepEqual(bucket.index().items.map(x => x.id), ['other']);
});

test('the real import receipt waits for its primary index write and includes the operator hashtags', async () => {
  const bucket = new Bucket(), entered = deferred(), release = deferred(), ctx = context();
  bucket.onPut = async key => { if (key === STOCK_INDEX_KEY) { entered.resolve(); await release.promise; } };
  let settled = false;
  const request = stockPublishHandler(publishRequest(), { STOCK_BUCKET: bucket }, ctx).then(r => { settled = true; return r; });
  await entered.promise; assert.equal(settled, false); assert.equal(bucket.index().items.length, 0);
  release.resolve(); const response = await request, receipt = await response.json();
  assert.equal(response.status, 200); assert.equal(receipt.ok, true); assert.equal(receipt.index.status, 'ready');
  const indexed = bucket.index().items.find(x => x.id === receipt.id);
  assert.ok(indexed); assert.deepEqual(indexed.tags.slice(0, 3), ['starbucks', 'paseodegracia103', 'ipad']);
  assert.match(indexed.url, /^https:\/\/stock\.admira\.store\/stock\//);
  assert.ok(bucket.map.has(`stock/${receipt.id}/meta.json`));
  await Promise.all(ctx.pending);
});

test('the real import returns a retryable failure when its saved asset cannot enter the index', async () => {
  const bucket = new Bucket(), ctx = context(); bucket.onPut = async key => key === STOCK_INDEX_KEY ? null : undefined;
  const response = await stockPublishHandler(publishRequest('failed-index-import'), { STOCK_BUCKET: bucket }, ctx);
  const receipt = await response.json();
  assert.equal(response.status, 503); assert.equal(receipt.ok, false);
  assert.equal(receipt.assetPublished, true); assert.equal(receipt.retryable, true);
  assert.equal(receipt.error, 'stock_index_update_failed');
  assert.ok(bucket.map.has(`stock/${receipt.id}/meta.json`)); assert.equal(bucket.index().total, 0);
});

test('dedup reuse repairs a missing index row and waits for confirmation before returning success', async () => {
  const bucket = new Bucket(), kv = new KV(), ctx = context(), id = 'existing-import';
  const content = 'identical-file', hash = createHash('sha256').update(content).digest('hex');
  bucket.seed(`stock/${id}/meta.json`, meta(id, { contentHash: hash }));
  kv.map.set(`stock:hash:${hash}`, id);
  const entered = deferred(), release = deferred();
  bucket.onPut = async key => { if (key === STOCK_INDEX_KEY) { entered.resolve(); await release.promise; } };
  let settled = false;
  const request = stockPublishHandler(publishRequest(content, { contentHash: hash }), { STOCK_BUCKET: bucket, SIGNAGE_KV: kv }, ctx)
    .then(response => { settled = true; return response; });
  await entered.promise; assert.equal(settled, false); release.resolve();
  const response = await request, receipt = await response.json();
  assert.equal(response.status, 200); assert.equal(receipt.reused, true); assert.equal(receipt.id, id);
  assert.equal(receipt.index.status, 'ready'); assert.deepEqual(bucket.index().items.map(x => x.id), [id]);
  assert.equal([...bucket.map.keys()].filter(k => k.endsWith('/meta.json')).length, 1);
  await Promise.all(ctx.pending);
});

test('dedup never claims success when index repair fails', async () => {
  const bucket = new Bucket(), kv = new KV(), id = 'existing-import', content = 'repair-failure';
  const hash = createHash('sha256').update(content).digest('hex');
  bucket.seed(`stock/${id}/meta.json`, meta(id, { contentHash: hash })); kv.map.set(`stock:hash:${hash}`, id);
  bucket.onPut = async key => key === STOCK_INDEX_KEY ? null : undefined;
  const response = await stockPublishHandler(publishRequest(content, { contentHash: hash }), { STOCK_BUCKET: bucket, SIGNAGE_KV: kv }, context());
  const receipt = await response.json();
  assert.equal(response.status, 503); assert.equal(receipt.ok, false); assert.equal(receipt.id, id);
  assert.equal(receipt.retryable, true); assert.equal(bucket.index().total, 0);
});

test('a full rebuild begun before an import cannot overwrite that concurrent import', async () => {
  const bucket = new Bucket([meta('old')]); bucket.seed('stock/old/meta.json', meta('old'));
  let injected = false;
  bucket.onList = async () => {
    if (injected) return; injected = true;
    bucket.seed('stock/new/meta.json', meta('new', { num: 2 }));
    await upsertStockIndex(bucket, meta('new', { num: 2 }));
  };
  const request = new Request('https://api.admira.store/stock/reindex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'test-secret' }) });
  const response = await worker.fetch(request, { STOCK_BUCKET: bucket, NOTIFY_KEY: 'test-secret' }, context());
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  assert.deepEqual(bucket.index().items.map(x => x.id).sort(), ['new', 'old']);
  assert.equal(bucket.conflicts, 1, 'the stale rebuild must fail its compare-and-swap');
});

test('a missing primary index fails closed instead of replacing the historical catalogue with one import', async () => {
  const bucket = new Bucket([meta('history')]);
  bucket.seed('stock/history/meta.json', meta('history')); await bucket.delete(STOCK_INDEX_KEY);
  await assert.rejects(upsertStockIndex(bucket, meta('new')), /missing/);
  assert.equal(bucket.puts.length, 0); assert.equal(bucket.map.has(STOCK_INDEX_KEY), false);
  const response = await stockPublishHandler(publishRequest('missing-primary-index'), { STOCK_BUCKET: bucket }, context());
  const receipt = await response.json();
  assert.equal(response.status, 503); assert.equal(receipt.ok, false); assert.equal(receipt.retryable, true);
  assert.equal(bucket.map.has(STOCK_INDEX_KEY), false);
  assert.ok(bucket.map.has('stock/history/meta.json'));
});

test('empty or false write receipts are never accepted as successful primary index commits', async () => {
  for (const failedReceipt of [undefined, false]) {
    const bucket = new Bucket([meta('history')]); let attempts = 0;
    bucket.put = async () => { attempts++; return failedReceipt; };
    await assert.rejects(upsertStockIndex(bucket, meta('new'), x => x, { attempts: 2 }), /conflict/);
    assert.equal(attempts, 2); assert.deepEqual(bucket.index().items.map(x => x.id), ['history']);
  }
});

test('a genuinely empty bucket or the first import alone can bootstrap the primary index conditionally', async () => {
  for (const ownObjects of [false, true]) {
    const bucket = new Bucket(); await bucket.delete(STOCK_INDEX_KEY);
    if (ownObjects) { bucket.seed('stock/first/meta.json', meta('first')); bucket.seed('stock/first/asset.mp4', 'bytes'); }
    await upsertStockIndex(bucket, meta('first'));
    assert.deepEqual(bucket.index().items.map(x => x.id), ['first']);
    assert.deepEqual(bucket.puts[0].options.onlyIf, { etagDoesNotMatch: '*' });
  }
});

test('bootstrap refuses an incomplete listing or another existing asset', async () => {
  for (const scenario of ['truncated', 'other-asset']) {
    const bucket = new Bucket(); await bucket.delete(STOCK_INDEX_KEY);
    bucket.seed('stock/first/meta.json', meta('first'));
    if (scenario === 'truncated') bucket.list = async () => ({ objects: [{ key: 'stock/first/meta.json' }], truncated: true });
    else bucket.seed('stock/history/meta.json', meta('history'));
    await assert.rejects(upsertStockIndex(bucket, meta('first')), /missing/);
    assert.equal(bucket.puts.length, 0); assert.equal(bucket.map.has(STOCK_INDEX_KEY), false);
  }
});

test('a late receipt for a replaced ID publishes current canonical metadata rather than stale request data', async () => {
  const bucket = new Bucket([meta('same', { title: 'original' })]);
  const latest = meta('same', { title: 'newest replacement', contentHash: 'b'.repeat(64) });
  const stale = meta('same', { title: 'older replacement', contentHash: 'a'.repeat(64) });
  let reloads = 0;
  await upsertStockIndex(bucket, stale, x => x, { loadMeta: async () => { reloads++; return latest; } });
  assert.equal(reloads, 1);
  assert.equal(bucket.index().items[0].title, latest.title); assert.equal(bucket.index().items[0].contentHash, latest.contentHash);
});

test('CAS retry reloads canonical metadata and keeps an intervening import', async () => {
  const bucket = new Bucket([meta('same')]); let current = meta('same', { title: 'old' }), writes = 0, reloads = 0;
  bucket.onPut = async key => {
    if (key === STOCK_INDEX_KEY && ++writes === 1) {
      current = meta('same', { title: 'newest', oculto: true });
      bucket.seed(STOCK_INDEX_KEY, { items: [meta('same'), meta('concurrent')], total: 2 });
      return null;
    }
  };
  const result = await upsertStockIndex(bucket, meta('same', { title: 'stale input' }), x => x, { loadMeta: async () => { reloads++; return current; } });
  assert.equal(result.attempts, 2); assert.equal(reloads, 2);
  assert.deepEqual(bucket.index().items.map(x => x.id), ['concurrent'], 'the latest canonical hidden flag removes the old item');
});

test('a missing or wrong canonical metadata record cannot produce a successful receipt', async () => {
  for (const current of [null, meta('other-id')]) {
    const bucket = new Bucket([meta('same')]);
    await assert.rejects(upsertStockIndex(bucket, meta('same'), x => x, { loadMeta: async () => current }), /invalid_mutation/);
    assert.equal(bucket.puts.length, 0); assert.deepEqual(bucket.index().items.map(x => x.id), ['same']);
  }
});
