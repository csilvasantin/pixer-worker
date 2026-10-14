// Shared context: brand is presentation; project is a server-authorized view.
import { verifyPixeriaApiToken } from './paid-auth.mjs';

export const CONTEXT_KEY = 'ctx:v1:';
export const CONTEXT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OFF = new Set(['', 'off', 'admira', 'all', 'todos', 'todas', 'none', 'default']);
const VERIFY_URLS = [
  'https://admira.studio/auth/verify',
  'https://www.pixeria.com/auth/verify',
  'https://admira-gate.csilvasantin.workers.dev/gate/verify',
];
export function contextId(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('invalid-context-id');
  const id = value.trim().toLowerCase();
  if (OFF.has(id)) return null;
  if (!CONTEXT_ID.test(id)) throw new Error('invalid-context-id');
  return id;
}
export function projectIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(x => typeof x === 'string' && CONTEXT_ID.test(x)))].slice(0, 40);
}
export function locationId(item) {
  // Legacy screen IDs can themselves be location IDs. Never infer from names/tags.
  return String(item?.locationId || item?.loc || item?.location?.id || (/^alsea-sbux-/.test(item?.screen || '') ? item.screen : ''));
}
export function projectsFor(item) {
  return [...new Set([...projectIds(item?.projects), ...(locationId(item).startsWith('alsea-sbux-') ? ['starbucks'] : [])])];
}
export function projectItem(item) {
  return { ...item, locationId: locationId(item) || null, projects: projectsFor(item) };
}
export function belongsToProject(item, project) {
  if (!project) return true;
  // Provisional Starbucks rule: an explicit project tag cannot override location.
  return project === 'starbucks' ? locationId(item).startsWith('alsea-sbux-') : projectsFor(item).includes(project);
}
const response = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
const emailOf = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : '';
export async function contextIdentity(req, env, fetchImpl = fetch) {
  const token = (/^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') || '') || [])[1];
  if (!token || token.length > 4096) return { error: 'session-required', status: 401 };
  let email = '';
  if (env.PIXERIA_SIGNING_KEY) {
    const local = await verifyPixeriaApiToken(token, env.PIXERIA_SIGNING_KEY);
    if (local && Number.isFinite(local.exp)) email = emailOf(local.email);
  }
  if (!email) {
    for (const url of VERIFY_URLS) {
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        if (r.ok && d.ok === true && emailOf(d.email)) { email = emailOf(d.email); break; }
      } catch { /* Never trust an email/role supplied by the caller. */ }
    }
  }
  if (!email) return { error: 'invalid-session', status: 401 };
  try {
    let superusuario;
    if (env.WHITELIST_SITE_TOKEN) {
      const url = 'https://whitelist.admira.store/access?site=pixeria&email=' + encodeURIComponent(email);
      const r = await fetchImpl(url, { headers: { 'X-Whitelist-Token': env.WHITELIST_SITE_TOKEN, Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      if (!r.ok || d.ok !== true || typeof d.superuser !== 'boolean') throw new Error('whitelist-unavailable');
      superusuario = d.superuser === true;
    } else {
      // Same canonical whitelist as admira-gate; fail closed if unavailable.
      const headers = { Accept: 'application/json' };
      if (env.WHITELIST_MACHINE_TOKEN) headers['X-Whitelist-Token'] = env.WHITELIST_MACHINE_TOKEN;
      const r = await fetchImpl('https://whitelist.admira.store/list', { headers, cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      if (!r.ok || !Array.isArray(d.superusers)) throw new Error('whitelist-unavailable');
      superusuario = d.superusers.map(emailOf).includes(email);
    }
    return { email, superusuario };
  } catch { return { error: 'whitelist-unavailable', status: 503 }; }
}
async function savedContext(env, email) {
  const raw = await env.SIGNAGE_KV.get(CONTEXT_KEY + email);
  try {
    const d = JSON.parse(raw || '{}');
    return { marca: contextId(d.marca ?? null), proyecto: contextId(d.proyecto ?? null) };
  } catch { return { marca: null, proyecto: null }; }
}
export async function contextHandler(req, env, fetchImpl = fetch) {
  if (!['GET', 'POST'].includes(req.method)) return response({ error: 'method-not-allowed' }, 405);
  const identity = await contextIdentity(req, env, fetchImpl);
  if (identity.error) return response({ error: identity.error }, identity.status);
  if (!env.SIGNAGE_KV) return response({ error: 'kv-not-bound' }, 503);
  const current = await savedContext(env, identity.email);
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return response({ error: 'bad-json' }, 400); }
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(k => !['marca', 'proyecto'].includes(k))) return response({ error: 'bad-context-fields' }, 400);
    if ('proyecto' in body && !identity.superusuario) return response({ error: 'superuser-required' }, 403);
    try { for (const k of ['marca', 'proyecto']) if (k in body) current[k] = contextId(body[k]); }
    catch { return response({ error: 'invalid-context-id' }, 400); }
    // Revocation clears the formerly authorized filter while preserving presentation.
    if (!identity.superusuario) current.proyecto = null;
    await env.SIGNAGE_KV.put(CONTEXT_KEY + identity.email, JSON.stringify(current));
  }
  return response({ ok: true, ...current, proyecto: identity.superusuario ? current.proyecto : null, superusuario: identity.superusuario });
}
export async function projectScope(req, env, fetchImpl = fetch) {
  const url = new URL(req.url);
  const explicit = url.searchParams.has('proyecto');
  if (!explicit && !req.headers.has('Authorization')) return { proyecto: null };
  const identity = await contextIdentity(req, env, fetchImpl);
  if (identity.error) return identity;
  let proyecto;
  try { proyecto = explicit ? contextId(url.searchParams.get('proyecto')) : env.SIGNAGE_KV ? (await savedContext(env, identity.email)).proyecto : null; }
  catch { return { error: 'invalid-context-id', status: 400 }; }
  if ((explicit || proyecto) && !identity.superusuario) return { error: 'superuser-required', status: 403 };
  return { proyecto, personalized: true };
}
