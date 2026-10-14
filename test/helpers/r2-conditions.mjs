import { createHash } from 'node:crypto';

// Add the documented R2 conditional-write contract to older test buckets while retaining
// their byte/stream, multipart, HTTP metadata and inspection behavior.
export function r2Conditions(bucket) {
  const originalGet = bucket.get.bind(bucket), originalPut = bucket.put.bind(bucket);
  const revisions = new Map(), locks = new Map(); let sequence = 0;
  const read = async key => {
    const object = await originalGet(key);
    if (!object) { revisions.delete(key); return null; }
    if (object.etag) return object;
    let etag;
    if (key === 'stock/index.json') {
      etag = createHash('sha256').update(JSON.stringify(await object.json())).digest('hex');
    } else {
      if (!revisions.has(key)) revisions.set(key, `fixture-${++sequence}`);
      etag = revisions.get(key);
    }
    return { ...object, etag, httpEtag: `"${etag}"` };
  };
  bucket.get = read;
  bucket.head = async key => { const object = await read(key); return object ? { ...object, body: undefined } : null; };
  bucket.put = async (key, value, options = {}) => {
    const previous = locks.get(key) || Promise.resolve(); let release;
    const current = new Promise(resolve => { release = resolve; }); locks.set(key, current);
    await previous;
    try {
      const object = await read(key), condition = options.onlyIf;
      if (condition && ((condition.etagMatches !== undefined && condition.etagMatches !== object?.etag)
        || (condition.etagDoesNotMatch === '*' && object))) return null;
      const result = await originalPut(key, value, options);
      if (result === null) return null;
      revisions.set(key, `fixture-${++sequence}`);
      const stored = await read(key);
      if (!stored) throw new Error('test bucket did not commit R2 put');
      return stored;
    } finally { release(); if (locks.get(key) === current) locks.delete(key); }
  };
  return bucket;
}
