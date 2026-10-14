// Public index mutations use R2's conditional write: a simultaneous publisher is retried,
// never overwritten. A publish receipt waits for this small mutation, not a full bucket scan.
export const STOCK_INDEX_KEY = 'stock/index.json';
export const STOCK_INDEX_HTTP = { contentType: 'application/json', cacheControl: 'public, max-age=60' };
export const stockIndexCondition = object => object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' };

export function stockIndexItems(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.items)) return doc.items;
  throw new Error('stock_index_invalid');
}

export async function upsertStockIndex(bucket, meta, project = value => value, { attempts = 8, loadMeta } = {}) {
  if (!bucket || !meta || !meta.id) throw new Error('stock_index_invalid_mutation');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const previous = await bucket.get(STOCK_INDEX_KEY);
    if (!previous) {
      // Initial publication can bootstrap a truly new bucket. An established bucket whose
      // index disappeared must be reconciled, never replaced with a one-item catalogue.
      const initial = await bucket.list({ prefix: 'stock/', limit: 8 });
      if (initial.truncated || initial.objects.some(object => !object.key.startsWith(`stock/${meta.id}/`))) throw new Error('stock_index_missing');
    }
    const doc = previous ? await previous.json() : { items: [] };
    // Reload canonical metadata AFTER taking the index snapshot: a late receipt from an older
    // replacement must not overwrite a newer metadata version already committed to R2.
    const current = loadMeta ? await loadMeta() : meta;
    if (!current || current.id !== meta.id) throw new Error('stock_index_invalid_mutation');
    const items = stockIndexItems(doc).filter(item => item && item.id !== current.id);
    if (!current.oculto) items.push(project(current));
    items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    const builtAt = new Date().toISOString();
    const written = await bucket.put(STOCK_INDEX_KEY, JSON.stringify({ items, total: items.length, builtAt }), {
      onlyIf: stockIndexCondition(previous), httpMetadata: STOCK_INDEX_HTTP,
    });
    if (written) return { items, builtAt, attempts: attempt + 1 };
  }
  throw new Error('stock_index_conflict');
}
