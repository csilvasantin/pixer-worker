// Generación de pago: sesión de Pixeria (web) o clave de flota (agentes).
// Sin una de las dos, el worker no llama al proveedor.

const encoder = new TextEncoder();

export function isPaidGeneration(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '');
  if (m === 'POST' && p === '/tts') return true;
  if (m === 'POST' && (
    p === '/xai/image' || p === '/xai/video' || p === '/xai/video/scenes' ||
    p === '/image/edit' || p === '/lyria/generate' || p === '/lyria3/generate' ||
    p === '/imagen/generate' || p === '/veo/generate' || p === '/llm/lyrics' || p === '/pvideo'
  )) return true;
  if (m === 'GET' && (p === '/pvideo' || p === '/veo/download')) return true;
  if (m === 'GET' && p.startsWith('/xai/video/') && p !== '/xai/video/scenes') return true;
  if (m === 'GET' && p.startsWith('/veo/status/')) return true;
  return false;
}

function presented(req) {
  const out = [];
  const fleet = req.headers.get('X-Fleet-Key') || req.headers.get('X-Notify-Key') || '';
  if (fleet) out.push(fleet);
  const auth = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (m) out.push(m[1]);
  return out;
}

function same(left, right) {
  left = String(left || '');
  right = String(right || '');
  if (!right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function b64urlToBytes(value) {
  const raw = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlFromBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return b64urlFromBytes(sig);
}

export async function verifyPixeriaApiToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  try {
    if (!secret || !token || String(token).length > 4096) return null;
    const sep = String(token).lastIndexOf('.');
    if (sep < 1) return null;
    const payloadPart = String(token).slice(0, sep);
    const signature = String(token).slice(sep + 1);
    if (!same(signature, await hmac(secret, `api:${payloadPart}`))) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadPart)));
    if (payload.aud !== 'api.admira.store' || payload.v !== 1) return null;
    if (Number(payload.exp) <= now || Number(payload.iat) > now + 60) return null;
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return null;
    return { email, exp: Number(payload.exp) };
  } catch {
    return null;
  }
}

export async function authorizePaidGeneration(req, env, fetchImpl = fetch) {
  const keys = presented(req);
  for (const key of keys) {
    if (same(key, env && env.FLEET_KEY) || same(key, env && env.NOTIFY_KEY)) {
      return { ok: true, via: 'fleet' };
    }
  }
  const bearer = (/^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') || '') || [])[1] || '';
  if (!bearer) return { ok: false };
  if (env && env.PIXERIA_SIGNING_KEY) {
    const local = await verifyPixeriaApiToken(bearer, env.PIXERIA_SIGNING_KEY);
    if (local) return { ok: true, via: 'session', email: local.email };
    return { ok: false };
  }
  const url = (env && env.PIXERIA_AUTH_VERIFY) || 'https://www.pixeria.com/auth/verify';
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: bearer }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data && data.ok) return { ok: true, via: 'session', email: data.email || '' };
  } catch { /* la red no abre la puerta */ }
  return { ok: false };
}
