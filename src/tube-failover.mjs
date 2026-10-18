// Importador de URL de Telegram (@AdmiraXPBot) → proxy admira-tube. Elección de base y POST
// con failover SIN doble importación. Módulo puro (fetch inyectable) para poder testearlo.
//
// Orden por defecto (Carlos, 18-oct-2026): Mac Studio primero, Mac Mini de respaldo.
// ADMIRA_TUBE_BASE (secret) admite una lista separada por comas: esas bases van primero y
// las de por defecto detrás (sin duplicados).
//
// Reglas anti-duplicado:
//  1. Se sondea GET {base}/tube/health (4,5 s, igual que el panel web) y se usa la primera sana.
//     «Sana» = HTTP 2xx y el JSON no dice ok:false ni available:false.
//  2. El POST /tube/import-to-stock va a ESA base. Solo se pasa a la siguiente si la anterior
//     respondió explícitamente que NO aceptó: HTTP 5xx, 404, 408 o 429.
//  3. Un 2xx es «aceptado»: no se reintenta nunca en otra base.
//  4. Otro 4xx (400 host no permitido…) es un «no» definitivo: no se repite en la otra base.
//  5. Si el POST lanza o vence ANTES de recibir respuesta, no se sabe si el proxy lo aceptó:
//     NO se reintenta en otra base (podría importarse dos veces). Se devuelve ambiguous:true
//     para que el llamante deje constancia.

export const ADMIRA_TUBE_BASES_DEFAULT = [
  'https://macstudio.tail48b61c.ts.net/admira',
  'https://macmini.tail48b61c.ts.net/admira',
];
export const TUBE_HEALTH_TIMEOUT_MS = 4500;
export const TUBE_POST_TIMEOUT_MS = 10000;

export function parseTubeBases(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw == null ? '' : raw).split(/[\s,;]+/)) {
    const v = part.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function admiraTubeBaseCandidates(env) {
  const seen = new Set();
  const out = [];
  for (const b of [...parseTubeBases(env && env.ADMIRA_TUBE_BASE), ...ADMIRA_TUBE_BASES_DEFAULT]) {
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(b);
  }
  return out;
}

// 'healthy' | 'down' (respondió que no) | 'unknown' (sin respuesta: timeout, DNS, TLS)
export async function tubeHealth(base, { fetchFn = fetch, timeoutMs = TUBE_HEALTH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchFn(base + '/tube/health', { method: 'GET', signal: ctrl.signal, headers: { 'Cache-Control': 'no-store' } });
    if (!r.ok) return 'down';
    let j = null;
    try { j = await r.json(); } catch { return 'healthy'; }
    return j && (j.ok === false || j.available === false) ? 'down' : 'healthy';
  } catch { return 'unknown'; }
  finally { clearTimeout(timer); }
}

export function postNotAccepted(status) {
  return status >= 500 || status === 404 || status === 408 || status === 429;
}

// Devuelve { accepted, base, jobId, status, body, ambiguous, noHealthy, error, attempts }.
export async function importToStockWithFailover(bases, payload, { fetchFn = fetch, healthTimeoutMs = TUBE_HEALTH_TIMEOUT_MS, postTimeoutMs = TUBE_POST_TIMEOUT_MS } = {}) {
  const res = { accepted: false, base: '', jobId: '', status: 0, body: '', ambiguous: false, noHealthy: false, error: '', attempts: [] };

  // 1) Primera base sana; el resto (no sondeadas o sin respuesta) quedan de reserva en orden.
  let order = [];
  const unknown = [];
  let healthyAt = -1;
  for (let i = 0; i < bases.length; i++) {
    const h = await tubeHealth(bases[i], { fetchFn, timeoutMs: healthTimeoutMs });
    res.attempts.push({ base: bases[i], step: 'health', result: h });
    if (h === 'healthy') { healthyAt = i; break; }
    if (h === 'unknown') unknown.push(bases[i]);
  }
  if (healthyAt >= 0) order = [bases[healthyAt], ...unknown, ...bases.slice(healthyAt + 1)];
  else order = unknown;   // ninguna sana: solo las que no contestaron (las que dijeron «no» se descartan)
  if (!order.length) { res.noHealthy = true; return res; }

  // 2) POST solo a la elegida; avanza únicamente tras un «no aceptado» explícito.
  for (const base of order) {
    res.base = base;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), postTimeoutMs);
    let r;
    try {
      r = await fetchFn(base + '/tube/import-to-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      // Sin respuesta tras enviar: puede haberlo aceptado. No se prueba otra base.
      res.ambiguous = true;
      res.error = String(e && e.message ? e.message : e).slice(0, 200);
      res.attempts.push({ base, step: 'post', result: 'ambiguous', error: res.error });
      return res;
    }
    clearTimeout(timer);
    res.status = r.status;
    if (r.ok) {
      const j = await r.json().catch(() => null);
      res.accepted = true;
      res.jobId = j && typeof j.jobId === 'string' ? j.jobId : '';
      res.attempts.push({ base, step: 'post', result: 'accepted', status: r.status });
      return res;
    }
    res.body = await r.text().catch(() => '');
    if (postNotAccepted(r.status)) {
      res.attempts.push({ base, step: 'post', result: 'not-accepted', status: r.status });
      continue;
    }
    res.attempts.push({ base, step: 'post', result: 'rejected', status: r.status });
    return res;
  }
  return res;
}
