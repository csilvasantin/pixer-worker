// Pixer-Eleven proxy — Cloudflare Worker
// Proxy server-side para llamadas de Pixer.ai a ElevenLabs y xAI/Grok.
// Las API keys viven como secrets de Cloudflare — nunca se exponen al navegador.
//
// Endpoints:
//   POST /tts                  → ElevenLabs text-to-speech (devuelve audio/mpeg)
//   POST /xai/image            → Grok 2 Image (devuelve {data:[{url}]})
//   POST /xai/video            → Grok Imagine Video (devuelve {request_id})
//   GET  /xai/video/{id}       → polling status
//   GET  /healthz              → ping

const ALLOWED_ORIGINS = [
  'https://csilvasantin.github.io',
  'http://ainimation.studio',
  'https://ainimation.studio',
  'http://www.ainimation.studio',
  'https://www.ainimation.studio',
  'https://admira.studio',
  'https://www.admira.studio',
  'https://pixeria.com',
  'https://www.pixeria.com',
  'https://xpaceos.com',
  'https://www.xpaceos.com',
  'https://admira.app',
  'https://www.admira.app',
  'https://admira.live',
  'https://www.admira.live',
  'https://carlossilva.info',
  'https://www.carlossilva.info',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
];
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN_RE.test(origin);
  const allow = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

// ─── Telegram notifications (@AdmiraXPBot → chat TELEGRAM_CHAT_ID) ──
// Real-time alerts en cada llamada relevante para vigilar gasto y uso.
// Fire-and-forget vía ctx.waitUntil — no añade latencia al response.
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(env, text) {
  return sendTelegramTo(env, env.TELEGRAM_CHAT_ID, text);
}
// Envío con el bot genérico (@AdmiraXPBot) a un chat concreto.
async function sendTelegramTo(env, chatId, text) {
  return sendTelegramVia(env.TELEGRAM_BOT_TOKEN, chatId, text);
}
// Envío con un bot ARBITRARIO (cada agente Matrix tiene el suyo) a un chat.
async function sendTelegramVia(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch {}
}

// ── Lectura de la BÓVEDA admira-vault desde el worker (server-side) ──
// El worker corre EN Cloudflare → admira-vault.workers.dev es alcanzable sin
// el bloqueo ISP que sufren las máquinas españolas. Lee con la GRID_KEY (la
// misma de Agora). Caché en memoria 5 min para no pegar a la bóveda en cada msg.
const VAULT_BASE = 'https://admira-vault.csilvasantin.workers.dev';
const _vaultCache = Object.create(null);
async function vaultGet(env, name) {
  const key = env.GRID_KEY || env.AGORA_SYNC_KEY;
  if (!key) return null;
  const c = _vaultCache[name];
  if (c && Date.now() < c.exp) return c.value;
  try {
    const r = await fetch(`${VAULT_BASE}/secret/${encodeURIComponent(name)}?key=${encodeURIComponent(key)}`, { headers: { 'User-Agent': 'pixer-eleven' } });
    if (!r.ok) { _vaultCache[name] = { value: null, exp: Date.now() + 60000 }; return null; }
    const d = await r.json().catch(() => ({}));
    const value = (d && typeof d.value === 'string') ? d.value : null;
    _vaultCache[name] = { value, exp: Date.now() + 300000 };
    return value;
  } catch { return null; }
}
// Destino del espejo Agora→Telegram: grupo AgoraMatrix (chat_id en la bóveda).
// Codex subió el id bajo varios nombres; probamos en orden el primero que valga.
async function agoraTgChatId(env) {
  for (const n of ['TELEGRAM_CHAT_ID_AGORAMATRIX', 'AGORAMATRIX_TELEGRAM_CHAT_ID', 'TELEGRAM_GROUP_AGORAMATRIX_ID', 'AGORAMATRIX_CHAT_ID']) {
    const v = await vaultGet(env, n);
    if (v) return v;
  }
  return env.AGORA_TG_CHAT_ID || env.TELEGRAM_CHAT_ID || null;
}
// Cada agente Matrix escribe en AgoraMatrix con SU bot (Codex subió los tokens
// a la bóveda como TELEGRAM_BOT_TOKEN_<PERSONA>). Mapeamos el `from` del feed
// a su persona; si no se reconoce o no hay token, cae al bot genérico.
function agoraPersonaFor(from) {
  const s = String(from || '').toLowerCase();
  if (s.includes('neo') || s.includes('claude·admira') || s.includes('claude-admira')) return 'NEO';
  if (s.includes('morfeo') || s.includes('claude·gmail') || s.includes('claude-gmail') || s.includes('pixeria')) return 'MORFEO';
  if (s.includes('oracul') || s.includes('codex·gmail') || s.includes('codex-gmail')) return 'ORACULO';
  if (s.includes('trinity') || s.includes('codex·admira') || s.includes('codex-admira')) return 'TRINITY';
  if (s.includes('cypher') || s.includes('grok')) return 'CYPHER';
  return null;
}
async function agoraBotTokenFor(env, from) {
  const p = agoraPersonaFor(from);
  if (p) { const t = await vaultGet(env, 'TELEGRAM_BOT_TOKEN_' + p); if (t) return t; }
  return env.TELEGRAM_BOT_TOKEN;
}

// Diagnóstico: GET /agora/tg-test?key=<GRID_KEY>&persona=MORFEO → intenta enviar
// al grupo AgoraMatrix con el bot de esa persona y devuelve la respuesta CRUDA
// de Telegram (ok / error_code / description) SIN exponer el token. Sirve para
// saber por qué un bot no escribe (no está en el grupo, token mal, chat mal).
async function agoraTgTestHandler(req, env, url) {
  if (!agoraAuth(env, url.searchParams.get('key'))) return json({ error: 'unauthorized' }, { status: 401 });
  const persona = (url.searchParams.get('persona') || 'MORFEO').toUpperCase().replace(/[^A-Z]/g, '');
  const chatId = await agoraTgChatId(env);
  const token = await vaultGet(env, 'TELEGRAM_BOT_TOKEN_' + persona);
  const out = { persona, hasToken: !!token, hasChat: !!chatId, chatTail: chatId ? String(chatId).slice(-4) : null };
  if (!token || !chatId) return json({ ...out, sent: false, reason: 'falta token o chat' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `🟢 <b>${persona}</b> · prueba de canal AgoraMatrix (diagnóstico)`, parse_mode: 'HTML' }),
    });
    const tg = await r.json().catch(() => ({}));
    return json({ ...out, sent: true, status: r.status, tgOk: !!tg.ok, tgError: tg.ok ? null : { code: tg.error_code, desc: tg.description } });
  } catch (e) { return json({ ...out, sent: false, reason: String(e) }); }
}

function notify(ctx, env, text) {
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(sendTelegram(env, text));
  else sendTelegram(env, text).catch(() => {});
}

// Diagnóstico síncrono: intenta enviar un mensaje a Telegram y devuelve la
// respuesta cruda de la API. Útil para detectar token mal, chat_id mal, o
// bot no iniciado por el usuario destino.
// Rutas que NO notificamos para evitar spam (polling, lecturas cacheadas)
const NOTIFY_SKIP_EXACT = new Set([
  '/healthz',
  '/grok/latest.json', // legacy polling de AdmiraXP/Grok: JSON estable, sin spam
  '/signage/heartbeat',
  '/signage/feed',
  '/signage/push', // notificado dentro del handler con asset/origen/target
  '/signage/screens',
  '/signage/now', // puntero "ahora reproduciendo" por pantalla — POST muy frecuente
  '/stock/list',
  '/stock/publish', // notificado dentro del handler con detalle (motor/tipo/tamaño)
  '/stock/reasset', // reproceso de transparencia en lote: no notificar cada uno
  '/notify',        // este endpoint YA envía un mensaje al chat — no duplicar
  '/lead',          // notificado dentro del handler con los datos del contacto
  '/telegram/webhook', // webhook entrante de Telegram (import por URL) — responde él mismo
  '/telegram/setup',
  // (los prefijos /stock/track/ y /stock/asset/ van en NOTIFY_SKIP_PREFIX abajo)
  '/veo/download',
]);
const NOTIFY_SKIP_PREFIX = [
  '/signage/asset/',
  '/signage/ack/',
  '/stock/asset/',
  '/stock/track/', // notificado dentro del handler con stats agregados
  '/stock/',       // DELETE notifica dentro del handler
  '/veo/status/',
  '/xai/video/', // GET polling
  '/agora/',     // coordinación multi-agente: housekeeping de alta frecuencia, no notificar
  '/layout/',    // distribuciones de mobiliario: la UI de pixeria/gemelo da su propio feedback
  '/xpacio',     // monedero/inventario del Xpacio: housekeeping de la UI del Marketplace
];

function shouldNotify(path, method, status) {
  if (status >= 400) return true; // errores siempre
  if (NOTIFY_SKIP_EXACT.has(path)) return false;
  if (NOTIFY_SKIP_PREFIX.some(p => path.startsWith(p))) return false;
  if (method === 'GET') return false; // resto de GETs son lecturas baratas
  return true;
}

function cleanMetaText(v, max = 120) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sourceUrlForNotify(req, body) {
  const meta = body && typeof body.meta === 'object' ? body.meta : {};
  return cleanMetaText(
    meta.page_url || meta.url || body.source_url || req.headers.get('Origin') || req.headers.get('Referer') || 'direct',
    220
  );
}

function signageMetaForItem(body, req) {
  const meta = body && typeof body.meta === 'object' ? body.meta : {};
  return {
    source: cleanMetaText(meta.source || body.source || 'unknown', 80),
    page: cleanMetaText(meta.page || meta.page_title || '', 120),
    page_url: sourceUrlForNotify(req, body),
    asset_id: cleanMetaText(meta.asset_id || body.asset_id || '', 80),
    asset_label: cleanMetaText(meta.asset_label || body.asset_label || body.title || '', 160),
    dispatch_mode: cleanMetaText(meta.dispatch_mode || '', 40),
    selected_count: Number.isFinite(Number(meta.selected_count)) ? Number(meta.selected_count) : null,
  };
}

function grokLatestHandler() {
  return json({
    ok: true,
    source: 'pixer-worker',
    route: '/grok/latest.json',
    latest: null,
    items: [],
    message: 'No hay snapshot Grok activo en este worker. Ruta legacy mantenida para clientes antiguos.',
    ts: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

// ─── ElevenLabs ────────────────────────────────────────────────────
async function ttsHandler(req, env) {
  if (!env.ELEVENLABS_KEY) return json({ error: 'server-missing-key', service: 'elevenlabs' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const { text, voice_id = 'EXAVITQu4vr4xnSDxMaL', model_id = 'eleven_multilingual_v2', voice_settings } = body;
  if (!text || typeof text !== 'string') return json({ error: 'missing-text' }, { status: 400 });
  if (text.length > 5000) return json({ error: 'text-too-long', max: 5000 }, { status: 400 });

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({
      text, model_id,
      voice_settings: voice_settings || { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    return json({ error: 'elevenlabs-failed', status: r.status, detail: errText.slice(0, 500) }, { status: r.status });
  }
  return new Response(r.body, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
}

// ─── xAI / Grok ────────────────────────────────────────────────────
async function xaiImageHandler(req, env) {
  if (!env.XAI_KEY) return json({ error: 'server-missing-key', service: 'xai' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const { prompt, n = 1, model = 'grok-imagine-image' } = body;
  if (!prompt || typeof prompt !== 'string') return json({ error: 'missing-prompt' }, { status: 400 });
  if (prompt.length > 4000) return json({ error: 'prompt-too-long', max: 4000 }, { status: 400 });
  // Modelos válidos: grok-imagine-image (rápido/barato $0.02), grok-imagine-image-pro ($0.07)
  const safeModel = (model === 'grok-imagine-image-pro') ? 'grok-imagine-image-pro' : 'grok-imagine-image';
  // b64:true → devolvemos las imágenes en base64 (data URL). Necesario para
  // procesarlas en canvas en el cliente sin "tainting" CORS (p. ej. recortar el
  // fondo del furni en Pixeria antes de publicarlo al gemelo).
  const wantB64 = body.b64 === true || body.response_format === 'b64_json';

  const r = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.XAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: safeModel, prompt, n: Math.min(4, Math.max(1, n)), response_format: wantB64 ? 'b64_json' : 'url' }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok && wantB64 && data && Array.isArray(data.data)) {
    // Si x.ai devolvió `url` en vez de `b64_json`, la traemos aquí (server-side,
    // sin CORS) y la convertimos a base64 para que el cliente la reciba lista.
    for (const item of data.data) {
      if (item && !item.b64_json && item.url) {
        try {
          const ir = await fetch(item.url);
          if (ir.ok) {
            const buf = await ir.arrayBuffer();
            item.b64_json = bytesToB64(new Uint8Array(buf));
            item.mime = ir.headers.get('Content-Type') || 'image/jpeg';
          }
        } catch (e) {}
      }
    }
  }
  return json(data, { status: r.status });
}

async function xaiVideoStartHandler(req, env) {
  if (!env.XAI_KEY) return json({ error: 'server-missing-key', service: 'xai' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const { prompt, duration = 8, aspect_ratio = '16:9', resolution = '720p' } = body;
  if (!prompt || typeof prompt !== 'string') return json({ error: 'missing-prompt' }, { status: 400 });
  if (prompt.length > 4000) return json({ error: 'prompt-too-long', max: 4000 }, { status: 400 });
  const dur = Math.max(1, Math.min(15, parseInt(duration, 10) || 8));

  const r = await fetch('https://api.x.ai/v1/videos/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.XAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grok-imagine-video', prompt, duration: dur, aspect_ratio, resolution }),
  });
  const data = await r.json().catch(() => ({}));
  return json(data, { status: r.status });
}

async function xaiVideoPollHandler(req, env, requestId) {
  if (!env.XAI_KEY) return json({ error: 'server-missing-key', service: 'xai' }, { status: 500 });
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) return json({ error: 'bad-request-id' }, { status: 400 });

  const r = await fetch(`https://api.x.ai/v1/videos/${encodeURIComponent(requestId)}`, {
    headers: { 'Authorization': `Bearer ${env.XAI_KEY}` },
  });
  const data = await r.json().catch(() => ({}));
  return json(data, { status: r.status });
}

// ─── Pollinations Video (gratis, tier "seed") ──────────────────────
// GET /pvideo?prompt=&model=&duration=&aspect=&audio= → proxy SÍNCRONO a
// gen.pollinations.ai/video/{prompt}, que devuelve el mp4 directo. La key
// (POLLINATIONS_KEY) nunca llega al cliente. Es la opción "Good" gratis.
async function pollinationsVideoHandler(req, env, url) {
  if (!env.POLLINATIONS_KEY) return json({ error: 'server-missing-key', service: 'pollinations' }, { status: 500 });
  const prompt = (url.searchParams.get('prompt') || '').slice(0, 2000);
  if (!prompt) return json({ error: 'missing-prompt' }, { status: 400 });
  const model = (url.searchParams.get('model') || 'wan-fast').slice(0, 40);
  const duration = Math.max(1, Math.min(15, parseInt(url.searchParams.get('duration'), 10) || 6));
  const aspect = (url.searchParams.get('aspect') || '16:9') === '9:16' ? '9:16' : '16:9';
  const audio = url.searchParams.get('audio') === 'true';

  const params = new URLSearchParams({ model, duration: String(duration), aspectRatio: aspect });
  if (audio) params.set('audio', 'true');
  const target = `https://gen.pollinations.ai/video/${encodeURIComponent(prompt)}?${params.toString()}`;

  let r;
  try {
    r = await fetch(target, { headers: { 'Authorization': `Bearer ${env.POLLINATIONS_KEY}` } });
  } catch (e) {
    return json({ error: 'upstream-fetch-failed', message: String(e) }, { status: 502 });
  }
  const cors = corsHeaders(req);
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 300);
    return new Response(detail || 'pollinations-error', { status: r.status, headers: cors });
  }
  // Passthrough del mp4 (síncrono). El frontend lo descarga como blob.
  const headers = new Headers(cors);
  headers.set('Content-Type', r.headers.get('Content-Type') || 'video/mp4');
  headers.set('Cache-Control', 'no-store');
  return new Response(r.body, { status: 200, headers });
}

// ─── Lyria 3 (Vertex AI) ───────────────────────────────────────────
// SA JSON en env.GCP_SA_KEY. Firmar JWT RS256, cambiar por access_token, llamar a /predict.

function b64urlEncode(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlEncodeStr(str) {
  return b64urlEncode(new TextEncoder().encode(str).buffer);
}
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '')
                 .replace(/-----END PRIVATE KEY-----/, '')
                 .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

let _gcpToken = null;
let _gcpTokenExp = 0;

async function getGcpAccessToken(env) {
  if (_gcpToken && Date.now() < _gcpTokenExp - 60000) return _gcpToken;
  if (!env.GCP_SA_KEY) throw new Error('server-missing-key: GCP_SA_KEY');
  const sa = JSON.parse(env.GCP_SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const headerB64 = b64urlEncodeStr(JSON.stringify(header));
  const payloadB64 = b64urlEncodeStr(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlEncode(sig)}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!r.ok) throw new Error(`gcp-token-failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  _gcpToken = data.access_token;
  _gcpTokenExp = Date.now() + (data.expires_in * 1000);
  return _gcpToken;
}

async function lyriaHandler(req, env) {
  if (!env.GCP_SA_KEY) return json({ error: 'server-missing-key', service: 'gcp' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const { prompt, negative_prompt, seed, sample_count = 1, model = 'lyria-002', location = 'us-central1' } = body;
  if (!prompt || typeof prompt !== 'string') return json({ error: 'missing-prompt' }, { status: 400 });
  if (prompt.length > 1500) return json({ error: 'prompt-too-long', max: 1500 }, { status: 400 });

  let sa;
  try { sa = JSON.parse(env.GCP_SA_KEY); } catch { return json({ error: 'bad-sa-key' }, { status: 500 }); }
  const projectId = sa.project_id;
  // Modelos válidos: lyria-002 (Lyria 2), lyria-3, lyria-3-pro (cuando estén GA en tu proyecto)
  const safeModel = ['lyria-002', 'lyria-3', 'lyria-3-pro'].includes(model) ? model : 'lyria-002';

  let token;
  try { token = await getGcpAccessToken(env); }
  catch (e) { return json({ error: 'gcp-auth-failed', message: String(e) }, { status: 500 }); }

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${safeModel}:predict`;
  const instance = { prompt };
  if (negative_prompt) instance.negative_prompt = negative_prompt;
  if (seed != null && sample_count === 1) instance.seed = seed;
  const reqBody = {
    instances: [instance],
    parameters: { sample_count: Math.max(1, Math.min(4, sample_count)) },
  };
  if (seed != null && sample_count === 1) delete reqBody.parameters.sample_count;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  const data = await r.json().catch(() => ({}));
  return json(data, { status: r.status });
}

// ─── Gemini (texto) — para letras de canciones, briefs, etc. ───────
async function geminiHandler(req, env) {
  if (!env.GCP_SA_KEY) return json({ error: 'server-missing-key', service: 'gcp' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const {
    brief = {},
    idioma = 'es',
    model = 'gemini-2.5-flash',
    location = 'us-central1',
    temperature = 0.9,
    maxOutputTokens = 1400,
  } = body;

  let sa;
  try { sa = JSON.parse(env.GCP_SA_KEY); } catch { return json({ error: 'bad-sa-key' }, { status: 500 }); }
  const projectId = sa.project_id;
  const safeModel = ['gemini-2.5-flash', 'gemini-2.5-pro'].includes(model) ? model : 'gemini-2.5-flash';

  // Construye prompt para letras. La IDEA/tema viene de brief.idea o brief.letra
  // (lo que el usuario escribe en el campo Letra como semilla); el estilo de brief.uso.
  const moods = Array.isArray(brief.emocion) ? brief.emocion.join(', ') : '';
  const layers = Array.isArray(brief.capas) ? brief.capas.join(', ') : '';
  const idea = String(brief.idea || brief.letra || '').trim();
  const extra = [moods && `emoción: ${moods}`, layers && `capas: ${layers}`, brief.tonalidad && `tonalidad: ${brief.tonalidad}`, brief.bpm && `${brief.bpm} bpm`].filter(Boolean).join(', ');
  const langName = { es: 'español', en: 'inglés', ca: 'catalán', fr: 'francés', pt: 'portugués', de: 'alemán', it: 'italiano' }[idioma] || idioma;

  const userPrompt = `Eres letrista profesional. Escribe la letra de una canción en ${langName}.

IDEA / TEMA de la canción: ${idea || 'libre — inspírate en el estilo'}
Estilo musical: ${brief.uso || 'libre'}${extra ? '\n' + extra : ''}
Cliente / proyecto: ${brief.cliente || 'sin especificar'}

Transforma la IDEA en versos emotivos, cantables y con rima natural (NO la copies literal: conviértela en canción). Devuelve SOLO la letra estructurada con secciones marcadas: [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], [Outro]. Sin comentarios, sin explicaciones, sin markdown. Máximo 24 líneas.`;

  let token;
  try { token = await getGcpAccessToken(env); }
  catch (e) { return json({ error: 'gcp-auth-failed', message: String(e) }, { status: 500 }); }

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${safeModel}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature, maxOutputTokens, topP: 0.95, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json(data, { status: r.status });
  // Extrae texto
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return json({ text, raw: data });
}

// ─── Lyria 3 (Gemini API) — música con letras y voz cantada ────────
async function lyria3Handler(req, env) {
  if (!env.GEMINI_API_KEY) return json({ error: 'server-missing-key', service: 'gemini' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const {
    prompt = '',
    lyrics = '',
    singer_profile = '',
    model = 'lyria-3-clip-preview',
  } = body;
  if (!prompt && !lyrics) return json({ error: 'missing-prompt-or-lyrics' }, { status: 400 });
  const safeModel = ['lyria-3-clip-preview', 'lyria-3-pro-preview'].includes(model) ? model : 'lyria-3-clip-preview';

  // Construir el prompt completo. Si hay lyrics, instruimos a usarlas.
  const parts = [];
  if (prompt) parts.push(`Music style: ${prompt}`);
  if (singer_profile) parts.push(`Singer: ${singer_profile}`);
  if (lyrics) parts.push(`Use these exact lyrics, do not alter them:\n${lyrics}`);
  const fullText = parts.join('\n\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: fullText }] }],
      generationConfig: {
        responseModalities: ['AUDIO', 'TEXT'],
      },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json(data, { status: r.status });

  // Extraer audio (inlineData base64) y texto opcional
  let audioB64 = null, mimeType = 'audio/wav', generatedText = null;
  for (const cand of (data.candidates || [])) {
    for (const p of (cand?.content?.parts || [])) {
      if (p.inlineData?.data) { audioB64 = p.inlineData.data; mimeType = p.inlineData.mimeType || mimeType; }
      else if (p.text) { generatedText = (generatedText || '') + p.text; }
    }
  }
  if (!audioB64) return json({ error: 'no-audio-in-response', raw: data }, { status: 500 });
  return json({ audio: audioB64, mimeType, text: generatedText, model: safeModel });
}

// ─── Imagen 4 / 4 Ultra (Gemini API) ───────────────────────────────
async function imagenHandler(req, env) {
  if (!env.GEMINI_API_KEY) return json({ error: 'server-missing-key', service: 'gemini' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const {
    prompt = '',
    aspectRatio = '1:1',
    numberOfImages = 1,
    personGeneration = 'allow_adult',
    model = 'imagen-4.0-generate-001',
    imageSize, // opcional: '1K' o '2K' (Ultra)
  } = body;
  if (!prompt) return json({ error: 'missing-prompt' }, { status: 400 });
  const safeModel = ['imagen-4.0-generate-001', 'imagen-4.0-ultra-generate-001'].includes(model) ? model : 'imagen-4.0-generate-001';

  const parameters = {
    sampleCount: Math.max(1, Math.min(4, numberOfImages)),
    aspectRatio,
    personGeneration,
  };
  if (imageSize) parameters.imageSize = imageSize;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:predict`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters }),
  });
  const data = await r.json().catch(() => ({}));
  return json(data, { status: r.status });
}

// ─── Veo 3 / Veo 3 Fast (Gemini API) — async ───────────────────────
async function veoStartHandler(req, env) {
  if (!env.GEMINI_API_KEY) return json({ error: 'server-missing-key', service: 'gemini' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const {
    prompt = '',
    aspectRatio = '16:9',
    durationSeconds = '8',
    resolution = '720p',
    model = 'veo-3.0-fast-generate-001',
  } = body;
  if (!prompt) return json({ error: 'missing-prompt' }, { status: 400 });
  const safeModel = ['veo-3.0-generate-001', 'veo-3.0-fast-generate-001'].includes(model) ? model : 'veo-3.0-fast-generate-001';

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:predictLongRunning`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { aspectRatio, durationSeconds: parseInt(durationSeconds, 10) || 8, resolution },
    }),
  });
  const data = await r.json().catch(() => ({}));
  return json(data, { status: r.status });
}

async function veoPollHandler(req, env, opName) {
  if (!env.GEMINI_API_KEY) return json({ error: 'server-missing-key' }, { status: 500 });
  if (!/^[A-Za-z0-9_./-]+$/.test(opName)) return json({ error: 'bad-op-name' }, { status: 400 });
  const url = `https://generativelanguage.googleapis.com/v1beta/${opName}`;
  const r = await fetch(url, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
  const data = await r.json().catch(() => ({}));
  return json(data, { status: r.status });
}

// Proxy de descarga del video — la URI de Veo requiere la API key, no se puede dar al cliente directamente
async function veoDownloadHandler(req, env, url) {
  if (!env.GEMINI_API_KEY) return json({ error: 'server-missing-key' }, { status: 500 });
  const uri = url.searchParams.get('uri');
  if (!uri) return json({ error: 'missing-uri' }, { status: 400 });
  // Solo permitir URIs del dominio oficial de Veo
  if (!uri.startsWith('https://generativelanguage.googleapis.com/')) {
    return json({ error: 'invalid-uri' }, { status: 400 });
  }
  const r = await fetch(uri, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
  if (!r.ok) {
    const errText = await r.text();
    return json({ error: 'veo-download-failed', status: r.status, detail: errText.slice(0, 300) }, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: { 'Content-Type': r.headers.get('Content-Type') || 'video/mp4', 'Cache-Control': 'no-store' },
  });
}

// ─── Signage (R2) — bridge Pixer.ai → AdmiraXP ─────────────────────
// Migrado de KV a R2 (2026-05-22): el plan Workers Free limita KV a 1000
// writes/día y el heartbeat del gemelo lo agotaba → /signage/push devolvía
// 500 "KV put() limit exceeded". Ahora el feed es un único objeto R2
// `signage/index.json` (array LIFO de items, cap 50) y los assets base64 van
// a `signage/asset/{id}`. El feed se lee con UNA sola lectura R2 (clave: lo
// pollea el gemelo y admira.app cada 5s). Heartbeat/screens siguen en KV
// (telemetría no crítica que ya degrada en silencio si KV está al límite).
const SIGNAGE_INDEX_KEY = 'signage/index.json';
const SIGNAGE_ASSET_PREFIX = 'signage/asset/';
const SIGNAGE_MAX_ITEMS = 50;
const SIGNAGE_BASE = 'https://pixer-eleven.csilvasantin.workers.dev';

async function signageReadIndex(env) {
  try {
    const o = await env.STOCK_BUCKET.get(SIGNAGE_INDEX_KEY);
    if (!o) return [];
    const a = await o.json();
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
async function signageWriteIndex(env, arr) {
  await env.STOCK_BUCKET.put(SIGNAGE_INDEX_KEY, JSON.stringify(arr), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-cache' },
  });
}

// ─── Lead capture (booth Shoptalk · gemelo Admira XP) ──────────────
// POST /lead  → guarda el contacto en SIGNAGE_KV (prefijo lead:) y avisa por
//   Telegram al instante (alerta en el stand + copia de respaldo del dato).
// GET  /leads?token=…&format=csv|json → export protegido para seguimiento
//   comercial post-evento. El token vive en el secret LEADS_TOKEN.
const LEAD_PREFIX = 'lead:';
function leadClean(s, max = 200) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}
function isEmail(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}
function csvCell(s) {
  const v = String(s == null ? '' : s);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

async function leadCreateHandler(req, env, ctx) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const name = leadClean(body.name);
  const email = leadClean(body.email);
  const phone = leadClean(body.phone, 40);
  const company = leadClean(body.company);
  const role = leadClean(body.role, 80);
  const interest = leadClean(body.interest, 80);
  const notes = leadClean(body.notes, 500);
  const consent = body.consent === true || body.consent === 'true';
  if (!name) return json({ error: 'missing-name' }, { status: 400 });
  if (!email && !phone) return json({ error: 'missing-contact' }, { status: 400 });
  if (email && !isEmail(email)) return json({ error: 'bad-email' }, { status: 400 });

  const ts = Date.now();
  const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const source = leadClean(body.source, 60) || 'admira-xp';
  const origin = req.headers.get('Origin') || req.headers.get('Referer') || 'direct';
  const ua = leadClean(req.headers.get('User-Agent'), 200);
  const rec = { id, ts, name, email, phone, company, role, interest, notes, consent, source, origin, ua };
  // Clave ordenable por tiempo (ts de 13 dígitos ⇒ orden lexicográfico = cronológico).
  await env.SIGNAGE_KV.put(`${LEAD_PREFIX}${id}`, JSON.stringify(rec));

  const msg = `🧲 <b>Nuevo lead · ${escHtml(source)}</b>\n` +
              `· <b>${escHtml(name)}</b>${company ? ' · ' + escHtml(company) : ''}\n` +
              (email ? `· ✉️ <code>${escHtml(email)}</code>\n` : '') +
              (phone ? `· ☎️ <code>${escHtml(phone)}</code>\n` : '') +
              (role ? `· 💼 ${escHtml(role)}\n` : '') +
              (interest ? `· 🎯 ${escHtml(interest)}\n` : '') +
              (notes ? `· 📝 ${escHtml(notes)}\n` : '');
  notify(ctx, env, msg);
  return json({ ok: true, id });
}

async function leadExportHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const token = url.searchParams.get('token') || '';
  if (!env.LEADS_TOKEN || token !== env.LEADS_TOKEN) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const leads = [];
  let cursor;
  do {
    const list = await env.SIGNAGE_KV.list({ prefix: LEAD_PREFIX, cursor, limit: 1000 });
    for (const k of list.keys) {
      const v = await env.SIGNAGE_KV.get(k.name);
      if (v) { try { leads.push(JSON.parse(v)); } catch {} }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  leads.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  if (format === 'csv') {
    const cols = ['ts', 'date', 'name', 'email', 'phone', 'company', 'role', 'interest', 'notes', 'consent', 'source', 'origin'];
    const rows = leads.map(l => [
      l.ts, new Date(l.ts).toISOString(), l.name, l.email, l.phone, l.company,
      l.role, l.interest, l.notes, l.consent ? 'yes' : 'no', l.source, l.origin,
    ].map(csvCell).join(','));
    const csv = '﻿' + [cols.join(','), ...rows].join('\r\n');
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="xpaceos-leads.csv"',
        'Cache-Control': 'no-store',
      },
    });
  }
  return json({ ok: true, count: leads.length, leads });
}

async function signagePushHandler(req, env, ctx) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const { kind, src, title, mime, base64, target, priority, interrupt } = body;
  if (!kind || !['image', 'video', 'audio', 'text'].includes(kind)) return json({ error: 'bad-kind' }, { status: 400 });
  if (!src && !base64) return json({ error: 'missing-src-or-base64' }, { status: 400 });
  if (base64 && base64.length > 25 * 1024 * 1024) return json({ error: 'too-big', max_b64: 25 * 1024 * 1024 }, { status: 413 });

  // Targeting por pantalla (opcional): si viene `target`, el item solo lo verá
  // esa pantalla (vía /signage/feed?screen=). Sin target = broadcast a todas.
  const tgt = target ? String(target).slice(0, 60) : null;
  if (tgt && !/^[a-z0-9_-]+$/i.test(tgt)) return json({ error: 'bad-target' }, { status: 400 });

  const ts = Date.now();
  const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const meta = signageMetaForItem(body, req);
  const item = {
    id, ts, kind,
    title: (title || '').slice(0, 200),
    src: src || null,
    mime: mime || null,
    hasBase64: !!base64,
    acked_at: null,
    screen: null,
    target: tgt,
    // Prioridad 0 = envío que interrumpe a pantalla completa lo que se emite.
    priority: (typeof priority === 'number') ? priority : null,
    interrupt: !!interrupt,
    meta,
  };
  if (base64) {
    await env.STOCK_BUCKET.put(`${SIGNAGE_ASSET_PREFIX}${id}`, b64ToBytes(base64), {
      httpMetadata: { contentType: mime || 'application/octet-stream', cacheControl: 'public, max-age=86400' },
    });
  }
  const idx = await signageReadIndex(env);
  idx.unshift(item);
  await signageWriteIndex(env, idx.slice(0, SIGNAGE_MAX_ITEMS));

  const targetLabel = tgt || 'broadcast/TODAS';
  const assetLabel = cleanMetaText(meta.asset_label || title || id, 120);
  const sourceLabel = cleanMetaText(meta.source || 'unknown', 80);
  const modeLabel = cleanMetaText(meta.dispatch_mode || (interrupt ? 'priority-0' : 'now'), 40);
  const countLabel = meta.selected_count ? ` · lote ${meta.selected_count}` : '';
  const srcLabel = src ? `\n· url <code>${escHtml(cleanMetaText(src, 160))}</code>` : '';
  const msg = `📺 <b>SIGNAGE PUSH</b> · ${escHtml(kind)} · ${escHtml(modeLabel)}${countLabel}\n` +
              `· asset <b>${escHtml(assetLabel || id)}</b>\n` +
              `· target <code>${escHtml(targetLabel)}</code>${interrupt ? ' · INTERRUPT' : ''}\n` +
              `· source <b>${escHtml(sourceLabel)}</b>${meta.page ? ` · ${escHtml(meta.page)}` : ''}\n` +
              `· page <code>${escHtml(meta.page_url || 'direct')}</code>${srcLabel}`;
  notify(ctx, env, msg);

  return json({ ok: true, id, url: `${SIGNAGE_BASE}/signage/asset/${id}` });
}

async function signageFeedHandler(req, env, url) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10)));
  const screen = (url.searchParams.get('screen') || '').slice(0, 60);
  const idx = await signageReadIndex(env);
  // Targeting por pantalla: un item con `target` solo lo ve esa pantalla; sin
  // target = broadcast (lo ven todas, retrocompatible). Sin ?screen= no filtra.
  const matching = screen ? idx.filter(it => !it.target || it.target === screen) : idx;
  const items = matching.slice(0, limit).map(item => ({
    ...item,
    url: item.hasBase64 ? `${SIGNAGE_BASE}/signage/asset/${item.id}` : item.src,
  }));
  return json({ items });
}

async function signageAssetHandler(req, env, id) {
  if (!env.STOCK_BUCKET) return new Response('r2-not-bound', { status: 500 });
  if (!/^[A-Za-z0-9-]+$/.test(id)) return new Response('bad-id', { status: 400 });
  const obj = await env.STOCK_BUCKET.get(`${SIGNAGE_ASSET_PREFIX}${id}`);
  if (!obj) return new Response('asset-gone', { status: 404 });
  const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
  return new Response(obj.body, {
    status: 200,
    headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' },
  });
}

// ─── /signage/media/<key> — sirve vídeo/imagen HD desde R2 con Range ──
// Para hospedar la videoteca HD (variantes 720p/480p…) fuera de git/Pages.
// Soporta Range (206) para que el <video> haga seek y empiece sin descargar todo.
async function signageMediaHandler(req, env, key) {
  if (!env.STOCK_BUCKET) return new Response('r2-not-bound', { status: 500 });
  if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes('..')) return new Response('bad-key', { status: 400 });
  const object = await env.STOCK_BUCKET.get(`media/${key}`, { range: req.headers, onlyIf: req.headers });
  if (object === null) return new Response('not-found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=604800');
  if (object.range) {
    let offset = 0, end = object.size - 1;
    if (object.range.offset != null) offset = object.range.offset;
    if (object.range.length != null) end = offset + object.range.length - 1;
    else if (object.range.suffix != null) { offset = object.size - object.range.suffix; end = object.size - 1; }
    headers.set('Content-Range', `bytes ${offset}-${end}/${object.size}`);
    headers.set('Content-Length', String(end - offset + 1));
  } else {
    headers.set('Content-Length', String(object.size));
  }
  const status = object.body ? (req.headers.get('range') ? 206 : 200) : 304;
  return new Response(object.body, { status, headers });
}

// Heartbeat: cada signage.html abierto pinga periódicamente para que sepamos qué pantallas están vivas.
const SCREENS_INDEX = 'signage_screens_index';
const SCREEN_TTL = 10 * 60;        // 10 min sin pings → pantalla muerta (holgura sobre el refresco)
const HB_REFRESH_MS = 90 * 1000;   // si nada cambió, reescribe screen: como mucho cada 90s
const SCREEN_ONLINE_MS = 6 * 60 * 1000; // "online" si se vio hace < 6 min (cubre heartbeat lento del juego a 5min)

// ─── Cortacircuitos de escrituras KV (control de coste) ──────────────
// Cloudflare Workers Paid factura overage de KV sin tope duro. Este guard
// cuenta las escrituras KV del día (UTC) y, al alcanzar el tope, deja de
// escribir hasta el día siguiente → imposible pasar del millón/mes incluido
// sin aprobación. Normal operando ≈ <2k/día, muy por debajo. El contador es
// en sí una escritura, por eso cada write lógico cuenta como 2 (dato+contador).
// Kill-switch instantáneo: var KV_WRITES_OFF=1 (wrangler) corta todo write KV.
const KV_DAILY_WRITE_CAP_DEFAULT = 25000; // físicas/día → ~750k/mes < 1M incluido
function utcDayKey(now) { return 'kvbudget:' + new Date(now).toISOString().slice(0, 10); }
// Reserva presupuesto para UN write lógico (= 2 físicos: el dato + este contador).
// Devuelve true si se puede escribir; false si kill-switch o tope alcanzado.
async function reserveKvWrite(env, now) {
  if (String(env.KV_WRITES_OFF || '') === '1') return false;
  if (!env.SIGNAGE_KV) return false;
  const cap = parseInt(env.KV_DAILY_WRITE_CAP, 10) || KV_DAILY_WRITE_CAP_DEFAULT;
  const key = utcDayKey(now);
  let used = 0;
  try { used = parseInt(await env.SIGNAGE_KV.get(key), 10) || 0; } catch {}
  if (used >= cap) return false;
  // Aviso de uso al 80% del tope diario (una sola vez al día) vía Telegram.
  // Es el "alerta de uso": Carlos se entera ANTES de que el cortacircuitos
  // pause las escrituras, por si hay que subir el tope o investigar un runaway.
  if (used >= cap * 0.8) {
    const wkey = 'kvbudget-warned:' + new Date(now).toISOString().slice(0, 10);
    try {
      if (!(await env.SIGNAGE_KV.get(wkey))) {
        await env.SIGNAGE_KV.put(wkey, '1', { expirationTtl: 172800 });
        sendTelegram(env, `⚠️ <b>KV writes al 80%</b> — ${used}/${cap} hoy (tope diario del cortacircuitos). Al llegar a ${cap} se pausan hasta el reset (00:00 UTC). Si es por escala real, sube <code>KV_DAILY_WRITE_CAP</code>; si no, revisa qué dispara escrituras.`).catch(() => {});
      }
    } catch {}
  }
  try { await env.SIGNAGE_KV.put(key, String(used + 2), { expirationTtl: 172800 }); } catch {}
  return true;
}

async function signageHeartbeatHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let body = {};
  try { body = await req.json(); } catch {}
  const screen = String(body.screen || '').slice(0, 60);
  if (!/^(screen|xtore|signage)-[a-z0-9-]+$/i.test(screen)) return json({ error: 'bad-screen-id', expected: 'screen-* | xtore-* | signage-*' }, { status: 400 });

  const now = Date.now();
  const data = {
    screen,
    last_seen: now,
    user_agent: (req.headers.get('User-Agent') || '').slice(0, 200),
    feed_count: parseInt(body.feed_count, 10) || 0,
    showing_id: body.showing_id || null,
    role: (body.role || 'signage').toString().slice(0, 40),
    version: (body.version || '').toString().slice(0, 40),
    loc: (body.loc || '').toString().slice(0, 60),       // Xpacio al que pertenece (cierra el loop: admira.app lo vende)
    locName: (body.locName || '').toString().slice(0, 80),
  };
  // Silenciar errores de KV (límite diario en Workers Free): el heartbeat es
  // telemetría no crítica; mejor perder algún ping que reventar el worker y
  // spammear Telegram con un error cada pocos segundos. El cliente recibe 200
  // y el sistema de signage sigue funcionando — solo se desactualiza el badge
  // de "screens online" hasta que KV vuelva a aceptar writes (cada 00:00 UTC).
  try {
    // Detección de cambio: solo reescribe si el contenido relevante cambió
    // (showing_id/role/version) o si pasó la ventana de refresco (90s). Así,
    // aunque el cliente pingue cada 20s, KV se escribe como mucho ~1 vez/90s.
    let prev = null;
    try { prev = JSON.parse(await env.SIGNAGE_KV.get(`screen:${screen}`)); } catch {}
    const changed = !prev || prev.showing_id !== data.showing_id ||
                    prev.role !== data.role || prev.version !== data.version ||
                    prev.loc !== data.loc;
    const stale = !prev || (now - (prev.last_seen || 0)) >= HB_REFRESH_MS;
    if (!changed && !stale) {
      return json({ ok: true, last_seen: prev.last_seen, throttled: 'unchanged' });
    }
    if (!(await reserveKvWrite(env, now))) {
      return json({ ok: true, last_seen: now, throttled: 'budget' });
    }
    await env.SIGNAGE_KV.put(`screen:${screen}`, JSON.stringify(data), { expirationTtl: SCREEN_TTL });
    // Índice de pantallas: solo se escribe al aparecer una pantalla nueva (raro).
    let index = [];
    try { index = JSON.parse(await env.SIGNAGE_KV.get(SCREENS_INDEX)) || []; } catch {}
    if (!index.includes(screen)) {
      index.push(screen);
      if (index.length > 100) index = index.slice(-100);
      if (await reserveKvWrite(env, now)) await env.SIGNAGE_KV.put(SCREENS_INDEX, JSON.stringify(index));
    }
    return json({ ok: true, last_seen: now });
  } catch (e) {
    return json({ ok: true, last_seen: now, throttled: true, reason: String(e).slice(0, 120) });
  }
}

async function signageScreensHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let index = [];
  try { index = JSON.parse(await env.SIGNAGE_KV.get(SCREENS_INDEX)) || []; } catch {}
  const now = Date.now();
  const screens = (await Promise.all(index.map(async s => {
    try {
      const raw = await env.SIGNAGE_KV.get(`screen:${s}`);
      if (!raw) return null; // expirado
      const data = JSON.parse(raw);
      data.online = (now - data.last_seen) < SCREEN_ONLINE_MS; // online si visto < 6 min
      data.age_seconds = Math.floor((now - data.last_seen) / 1000);
      return data;
    } catch { return null; }
  }))).filter(Boolean);
  return json({
    screens,
    online_count: screens.filter(s => s.online).length,
    total_count: screens.length,
    fetched_at: now,
  });
}

async function signageAckHandler(req, env, id) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  if (!/^[A-Za-z0-9-]+$/.test(id)) return json({ error: 'bad-id' }, { status: 400 });
  let body = {};
  try { body = await req.json(); } catch {}
  const idx = await signageReadIndex(env);
  const item = idx.find(it => it && it.id === id);
  if (!item) return json({ error: 'not-found' }, { status: 404 });
  item.acked_at = Date.now();
  if (body.screen) item.screen = String(body.screen).slice(0, 60);
  await signageWriteIndex(env, idx);
  return json({ ok: true, id, acked_at: item.acked_at, screen: item.screen || null });
}

async function signageClearHandler(req, env) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  const idx = await signageReadIndex(env);
  await Promise.all(idx.filter(it => it && it.hasBase64).map(it =>
    env.STOCK_BUCKET.delete(`${SIGNAGE_ASSET_PREFIX}${it.id}`).catch(() => {})));
  await env.STOCK_BUCKET.delete(SIGNAGE_INDEX_KEY);
  return json({ ok: true, cleared: idx.length });
}

// ─── /signage/now — puntero "ahora reproduciendo" por pantalla ──────
// Canal ligero para espejar en vivo una pantalla del juego (p. ej. el
// escaparate del digital twin) en una pantalla física: el juego hace POST con
// {screen, item} cada vez que cambia el contenido, y el receptor (pantalla.html)
// hace GET ?screen= y reproduce lo mismo. Un único valor por pantalla.
// El emisor postea en cada cambio + keepalive; el worker deduplica para no
// reescribir KV salvo cambio real o refresco antes de caducar (ver POST).
const SIGNAGE_NOW_TTL = 180;        // 3 min sin escritura → el puntero caduca
const NOW_REFRESH_MS = 90 * 1000;   // si el item no cambió, reescribe como mucho cada 90s

// Firma estable del item ignorando el campo volátil `ts` (que cambia en cada
// keepalive aunque el contenido sea el mismo).
function nowItemSig(item) {
  if (!item || typeof item !== 'object') return '';
  const it = { ...item }; delete it.ts;
  return JSON.stringify(it);
}

async function signageNowGetHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const screen = String(url.searchParams.get('screen') || '').slice(0, 60);
  if (!/^[a-z0-9_-]+$/i.test(screen)) return json({ error: 'bad-screen' }, { status: 400 });
  let stored = null;
  try { stored = JSON.parse(await env.SIGNAGE_KV.get(`now:${screen}`)); } catch {}
  // Formato nuevo: { item, __w, __sig }. Compat: valor antiguo = el item directo.
  const item = stored ? (stored.__w !== undefined ? (stored.item || null) : stored) : null;
  return json({ ok: true, screen, item: item || null });
}

async function signageNowPostHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const screen = String(body.screen || '').slice(0, 60);
  if (!/^[a-z0-9_-]+$/i.test(screen)) return json({ error: 'bad-screen' }, { status: 400 });
  const item = (body.item && typeof body.item === 'object') ? body.item : null;
  const sig = nowItemSig(item);
  if (sig.length > 8000) return json({ error: 'too-big', max: 8000 }, { status: 413 });
  const now = Date.now();
  // Detección de cambio: si el item es igual al guardado y se escribió hace
  // <90s, no reescribimos (el keepalive cada 20s no cuesta KV). Solo escribe
  // en cambio real o para refrescar el TTL antes de que caduque.
  let prev = null;
  try { prev = JSON.parse(await env.SIGNAGE_KV.get(`now:${screen}`)); } catch {}
  if (prev && prev.__w !== undefined && prev.__sig === sig && (now - prev.__w) < NOW_REFRESH_MS) {
    return json({ ok: true, screen, throttled: 'unchanged' });
  }
  if (!(await reserveKvWrite(env, now))) {
    return json({ ok: true, screen, throttled: 'budget' });
  }
  try {
    await env.SIGNAGE_KV.put(`now:${screen}`, JSON.stringify({ item, __w: now, __sig: sig }), { expirationTtl: SIGNAGE_NOW_TTL });
  } catch (e) {
    return json({ ok: true, throttled: true, reason: String(e).slice(0, 120) });
  }
  return json({ ok: true, screen });
}

// ─── /notify — endpoint para la rutina "actualización" ──────────────
// POST /notify { secret: NOTIFY_KEY, text: "<html>" }
//   → 200 { ok: true } y envía el text al chat TELEGRAM_CHAT_ID en HTML.
// Auth simple por secret en body (NOTIFY_KEY). Pensado para que mi rutina
// de release dispare un mensaje clickable con el link al deploy. NO está
// en la lista de notificación del interceptor para no duplicar.
async function notifyHandler(req, env, ctx) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return json({ error: 'telegram-not-configured' }, { status: 500 });
  }
  if (!env.NOTIFY_KEY) {
    return json({ error: 'NOTIFY_KEY-not-set' }, { status: 500 });
  }
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!body.secret || body.secret !== env.NOTIFY_KEY) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!body.text || typeof body.text !== 'string') {
    return json({ error: 'missing-text' }, { status: 400 });
  }
  if (body.text.length > 4000) {
    return json({ error: 'text-too-long', max: 4000 }, { status: 413 });
  }
  // Envío síncrono (no waitUntil) para devolver el status real de Telegram.
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: body.text,
        parse_mode: 'HTML',
        disable_web_page_preview: !!body.disable_preview,
      }),
    });
    const tgBody = await r.json();
    if (!r.ok || !tgBody.ok) {
      return json({ error: 'telegram-failed', status: r.status, telegram: tgBody.description || null }, { status: 502 });
    }
    return json({ ok: true, message_id: tgBody.result && tgBody.result.message_id });
  } catch (e) {
    return json({ error: 'fetch-failed', detail: String(e) }, { status: 500 });
  }
}

// ─── Telegram: importar a Stock enviando una URL a @AdmiraXPBot ──────
// Flujo: Telegram → /telegram/webhook → respondemos "importando" y disparamos
// la descarga en el proxy del Mac Mini (Tailscale Funnel /pixtube → 127.0.0.1:8420,
// que quita el prefijo y entrega /tube/import-to-stock al servicio). El proxy
// descarga con yt-dlp y publica en /stock/publish, que ya notifica el resultado.
// El token del bot nunca sale del worker.
// Se puede sobreescribir con el secret ADMIRA_TUBE_BASE (sin redesplegar código).
const ADMIRA_TUBE_BASE_DEFAULT = 'https://macmini.tail48b61c.ts.net/pixtube';
async function tgSend(env, chatId, html) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch {}
}
async function telegramWebhookHandler(req, env, ctx) {
  // Verificación del secret de Telegram (cabecera fijada en setWebhook)
  const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: true }); // 200 para que Telegram no reintente; ignoramos
  }
  let update;
  try { update = await req.json(); } catch { return json({ ok: true }); }
  const msg = update.message || update.edited_message;
  if (!msg) return json({ ok: true });
  const chatId = String((msg.chat && msg.chat.id) || '');
  // DIAGNÓSTICO TEMPORAL (2026-06-10): registrar todos los chats entrantes a R2
  // para descubrir el chat_id del grupo AgoraMatrix (legible por r2.dev).
  if (env.STOCK_BUCKET) {
    ctx.waitUntil((async () => {
      try {
        const prev = await env.STOCK_BUCKET.get('diag/tg-chats.json');
        const arr = prev ? await prev.json() : [];
        const entry = { chatId, title: (msg.chat && (msg.chat.title || msg.chat.username || msg.chat.first_name)) || '', type: msg.chat && msg.chat.type, text: (msg.text || '').slice(0, 40), at: new Date().toISOString() };
        if (!arr.some(e => e.chatId === chatId)) arr.push(entry);
        await env.STOCK_BUCKET.put('diag/tg-chats.json', JSON.stringify(arr.slice(-20)), { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
      } catch {}
    })());
  }
  if (env.TELEGRAM_CHAT_ID && chatId !== String(env.TELEGRAM_CHAT_ID)) return json({ ok: true }); // solo el chat autorizado
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return json({ ok: true });
  const who = (msg.from && (msg.from.first_name || msg.from.username)) || 'humano';
  const cliCommand = agoraCliCommandFromText(text);
  if (cliCommand) {
    ctx.waitUntil((async () => {
      await tgSend(env, chatId, await agoraCliCommandReply(env, cliCommand));
    })().catch(() => {}));
    return json({ ok: true });
  }
  const command = agoraCommandFromText(text);
  if (command) {
    ctx.waitUntil((async () => {
      const routed = await agoraEnqueueCommand(env, command, who, chatId);
      await tgSend(env, chatId, `📨 <b>${escHtml(routed.persona)}</b> invocado.\n<code>${escHtml(routed.text.slice(0, 900))}</code>`);
    })().catch(() => {}));
    return json({ ok: true });
  }
  const m = text.match(/https?:\/\/[^\s]+/i);
  if (!m) {
    // Sin URL → es un mensaje del grupo para los agentes: lo encolamos en los
    // buzones de Agora (lo recogen el cmd-poller —p.ej. "apaga monitores"— y
    // `agora inbox`). No auto-respondemos para no ensuciar el chat.
    ctx.waitUntil(agoraEnqueueInbox(env, text, who, chatId).catch(() => {}));
    return json({ ok: true });
  }
  const link = m[0].replace(/[).,]+$/, '');
  const fmt = /\b(audio|mp3)\b/i.test(text) ? 'audio' : 'video';
  const comment = text.replace(m[0], '').replace(/\b(audio|mp3)\b/ig, '').trim() || null;
  let host = '';
  try { host = new URL(link).hostname; } catch {}
  const base = env.ADMIRA_TUBE_BASE || ADMIRA_TUBE_BASE_DEFAULT;
  ctx.waitUntil((async () => {
    await tgSend(env, chatId, `📥 Importando ${fmt === 'audio' ? 'audio 🎵' : 'vídeo 🎬'} de <b>${escHtml(host)}</b>…\n<code>${escHtml(link)}</code>\n<i>te aviso al publicar en Stock.</i>`);
    try {
      const r = await fetch(base + '/tube/import-to-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: link, format: fmt, comment }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        await tgSend(env, chatId, `⚠️ El proxy rechazó la importación (${r.status}): <code>${escHtml(t.slice(0, 180))}</code>`);
      }
      // El éxito lo notifica /stock/publish cuando el proxy termina de descargar.
    } catch (e) {
      await tgSend(env, chatId, `🚨 No pude contactar el proxy del Mac Mini (¿admira-tube caído?): <code>${escHtml(String(e).slice(0, 180))}</code>`);
    }
  })());
  return json({ ok: true });
}
// Registra el webhook en Telegram. GET /telegram/setup?key=NOTIFY_KEY (one-time).
async function telegramSetupHandler(req, env, url) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: 'no-token' }, { status: 500 });
  if (!env.NOTIFY_KEY || (url.searchParams.get('key') || '') !== env.NOTIFY_KEY) return json({ error: 'unauthorized' }, { status: 401 });
  if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ error: 'no-webhook-secret (wrangler secret put TELEGRAM_WEBHOOK_SECRET)' }, { status: 500 });
  const hookUrl = `${url.origin}/telegram/webhook`;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: hookUrl, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'edited_message'], drop_pending_updates: true }),
  });
  const b = await r.json().catch(() => ({}));
  return json({ ok: b.ok === true, webhook: hookUrl, telegram: b });
}

// ─── Autoclasificación: pide a Gemini 3 tags cortas según metadata ──
const TAG_SUGGESTIONS = [
  'música', 'videoclip', 'cine', 'serie', 'documental', 'tráiler',
  'tutorial', 'cómo se hace', 'humor', 'meme', 'noticias', 'reportaje',
  'entrevista', 'charla', 'conferencia', 'podcast',
  'deporte', 'naturaleza', 'animales', 'tecnología', 'ia',
  'marketing', 'publicidad', 'negocio', 'emprendimiento', 'finanzas',
  'motivacional', 'crecimiento personal', 'autoayuda',
  'cocina', 'receta', 'gastronomía',
  'arte', 'diseño', 'animación', 'videojuego', 'gaming',
  'ciencia', 'educación', 'historia', 'política',
  'viaje', 'lugares', 'reseña', 'opinión',
  'familia', 'lifestyle', 'salud', 'fitness', 'moda', 'belleza',
  'evento', 'demo de producto', 'making-of', 'idea', 'inspiración'
];

// Taxonomía de segmentación para publicidad dirigida (la consume /targetPublicity
// en el gemelo): audience = público objetivo · category = función publicitaria.
const STOCK_AUDIENCES = ['f', 'm', 'all'];
const STOCK_CATEGORIES = ['atraer', 'producto', 'promo', 'marca'];

// Clasificación automática con Gemini: 3 tags + audiencia + categoría de retail.
// Devuelve siempre un objeto {tags, audience, category} con defaults seguros.
async function generateAutoMeta(env, info) {
  const empty = { tags: [], audience: 'all', category: 'producto' };
  if (!env.GEMINI_API_KEY) return empty;
  const { title = '', prompt = '', comment = '', type = '', motor = '' } = info || {};
  if (!title && !prompt && !comment) return empty;

  const ask =
    'Eres un clasificador de creatividades para cartelería digital (DOOH) de retail. ' +
    'Devuelve SOLO JSON válido con este formato EXACTO:\n' +
    '{"tags":["t1","t2","t3"],"audience":"f|m|all","category":"atraer|producto|promo|marca"}\n\n' +
    'Reglas:\n' +
    '- tags: EXACTAMENTE 3 etiquetas cortas (1-2 palabras, minúsculas, sin emojis) para buscar el asset.\n' +
    '- audience: público objetivo principal. "f"=mujeres, "m"=hombres, "all"=neutro/mixto. Ante la duda, "all".\n' +
    '- category: función publicitaria. "atraer"=gancho/oferta para captar a quien pasa o entra a una tienda vacía; ' +
    '"producto"=muestra un producto concreto; "promo"=promoción/descuento/2x1; "marca"=branding/imagen premium.\n\n' +
    'Etiquetas sugeridas para tags (usa otras si encajan mejor): ' +
    TAG_SUGGESTIONS.join(', ') + '.\n\n' +
    'Datos del asset:\n' +
    `- Tipo: ${type}\n` +
    `- Motor: ${motor}\n` +
    `- Título: ${title}\n` +
    `- URL o prompt original: ${String(prompt).slice(0, 400)}\n` +
    `- Nota del usuario: ${String(comment).slice(0, 400)}\n`;

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: ask }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      }),
    });
    if (!r.ok) return empty;
    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed) return empty;
    const tags = (Array.isArray(parsed.tags) ? parsed.tags : [])
      .map(t => String(t).toLowerCase().trim().replace(/^[#·.\s]+|[#·.\s]+$/g, '').slice(0, 30))
      .filter(t => t && t.length <= 30)
      .slice(0, 3);
    const audience = STOCK_AUDIENCES.includes(parsed.audience) ? parsed.audience : 'all';
    const category = STOCK_CATEGORIES.includes(parsed.category) ? parsed.category : 'producto';
    return { tags, audience, category };
  } catch {
    return empty;
  }
}

// ─── Stock stats (consumo y reproducciones) ────────────────────────
// Plays se guardan en R2: stats/plays.json = { total, byDay: { 'YYYY-MM-DD': N } }
// Imports se calculan sobre la marcha listando R2 (no contador).
function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function readPlays(env) {
  try {
    const obj = await env.STOCK_BUCKET.get('stats/plays.json');
    if (!obj) return { total: 0, byDay: {} };
    const d = await obj.json();
    return { total: d.total || 0, byDay: d.byDay || {} };
  } catch {
    return { total: 0, byDay: {} };
  }
}

async function bumpPlay(env) {
  const cur = await readPlays(env);
  const day = todayISO();
  cur.total = (cur.total || 0) + 1;
  cur.byDay[day] = (cur.byDay[day] || 0) + 1;
  await env.STOCK_BUCKET.put('stats/plays.json', JSON.stringify(cur), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  return { total: cur.total, today: cur.byDay[day] };
}

async function getImportsStats(env) {
  // Suma sobre todos los meta.json
  let total = 0, today = 0, bytesTotal = 0, bytesToday = 0;
  const todayPrefix = todayISO();
  try {
    let cursor;
    do {
      const r = await env.STOCK_BUCKET.list({ prefix: 'stock/', limit: 1000, cursor });
      const metaKeys = r.objects.filter(o => o.key.endsWith('/meta.json'));
      const metas = await Promise.all(metaKeys.map(async k => {
        try { const o = await env.STOCK_BUCKET.get(k.key); return o ? await o.json() : null; }
        catch { return null; }
      }));
      for (const m of metas) {
        if (!m) continue;
        total += 1;
        bytesTotal += m.size || 0;
        if (m.createdAt && m.createdAt.startsWith(todayPrefix)) {
          today += 1;
          bytesToday += m.size || 0;
        }
      }
      cursor = r.truncated ? r.cursor : null;
    } while (cursor);
  } catch {}
  return { total, today, bytesTotal, bytesToday };
}

function mb(n) { return (n / 1024 / 1024).toFixed(2) + ' MB'; }

async function buildStatsFooter(env) {
  const [imp, plays] = await Promise.all([getImportsStats(env), readPlays(env)]);
  const day = todayISO();
  const playsToday = plays.byDay[day] || 0;
  return (
    `\n────────\n` +
    `📦 Imports hoy: <b>${imp.today}</b> · ${mb(imp.bytesToday)}` +
    `   |   total: <b>${imp.total}</b> · ${mb(imp.bytesTotal)}\n` +
    `▶ Plays hoy: <b>${playsToday}</b>   |   total: <b>${plays.total}</b>`
  );
}

// POST /stock/track/:id?event=play  → cuenta una reproducción y notifica
async function stockTrackHandler(req, env, ctx, id) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  if (!/^[A-Za-z0-9-]+$/.test(id)) return json({ error: 'bad-id' }, { status: 400 });
  const url = new URL(req.url);
  const event = url.searchParams.get('event') || 'play';
  if (event !== 'play') return json({ error: 'unknown-event' }, { status: 400 });

  // Lee la meta para enriquecer la notificación
  let meta = null;
  try {
    const obj = await env.STOCK_BUCKET.get(`stock/${id}/meta.json`);
    if (obj) meta = await obj.json();
  } catch {}
  if (!meta) return json({ error: 'asset-not-found' }, { status: 404 });

  const after = await bumpPlay(env);
  const footer = await buildStatsFooter(env);
  const promptSnip = meta.prompt ? `\n💬 <i>${escHtml(String(meta.prompt).slice(0, 100))}${meta.prompt.length > 100 ? '…' : ''}</i>` : '';
  const text =
    `▶ <b>STOCK PLAY</b> · ${escHtml(meta.type)} · <code>${escHtml(meta.motor || '')}</code>\n` +
    `· id <code>${escHtml(id)}</code> · ${mb(meta.size || 0)}${promptSnip}` +
    footer;
  notify(ctx, env, text);
  return json({ ok: true, today: after.today, total: after.total });
}

// ─── Stock público (R2-only, sin KV) ───────────────────────────────
// Cada asset se guarda como 2 objetos en R2:
//   stock/{id}/asset.{ext} — el blob
//   stock/{id}/meta.json   — metadata (type, motor, prompt, costEst, mime,
//                            size, thumbnail, url, createdAt)
// Listado: R2.list({prefix: 'stock/'}) + filtro por sufijo /meta.json.
// Sin KV → sin límite de 1000 writes/día en Workers Free.
const STOCK_TYPES = ['audio', 'music', 'image', 'video', 'animation', 'furni'];
const WORKER_PUBLIC_BASE = 'https://pixer-eleven.csilvasantin.workers.dev';

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function extForMime(mime) {
  const map = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  };
  return map[mime] || 'bin';
}

async function stockPublishHandler(req, env, ctx) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const { type, motor, prompt, costEst, mime, base64, sourceUrl, thumbnail, comment, title } = body;
  // Metadatos de mobiliario (type 'furni'): huella en tiles [w,d] y alto en px.
  const fp = (Array.isArray(body.fp) && body.fp.length === 2)
    ? [Math.max(1, Math.min(6, +body.fp[0] || 1)), Math.max(1, Math.min(6, +body.fp[1] || 1))]
    : null;
  const ph = (body.ph != null && isFinite(+body.ph)) ? Math.max(8, Math.min(400, +body.ph)) : null;
  // Precio del mueble (créditos del Xpacio), para el Marketplace.
  const price = (body.price != null && isFinite(+body.price)) ? Math.max(0, Math.min(100000, Math.round(+body.price))) : null;
  let tags = Array.isArray(body.tags) ? body.tags.map(t => String(t).toLowerCase().slice(0,30)).filter(Boolean).slice(0,3) : null;
  // Segmento de campaña (fase 3): "crear campaña" manda el segmento de cada
  // versión para casarla con su público al venderse (audience/edad/franja/emplazamiento).
  const SEG_AUD = ['f','m','all'], SEG_AGE = ['nino','joven','adulto','senior','vejez'], SEG_TS = ['manana','mediodia','tarde','noche'], SEG_TYP = ['exterior','interior'];
  const _cleanArr = (a, allow) => Array.isArray(a) ? [...new Set(a.map(x => String(x)).filter(x => allow.includes(x)))] : [];
  const segIn = (body.segmentation && typeof body.segmentation === 'object') ? body.segmentation : null;
  const segmentation = segIn ? {
    audiences: _cleanArr(segIn.audiences, SEG_AUD),
    ageBuckets: _cleanArr(segIn.ageBuckets, SEG_AGE),
    timeSlots: _cleanArr(segIn.timeSlots, SEG_TS),
    typologies: _cleanArr(segIn.typologies, SEG_TYP),
  } : null;
  const bodyAudience = (typeof body.audience === 'string' && SEG_AUD.includes(body.audience)) ? body.audience : null;

  if (!type || !STOCK_TYPES.includes(type)) {
    return json({ error: 'bad-type', expected: STOCK_TYPES }, { status: 400 });
  }
  if (!motor || typeof motor !== 'string') return json({ error: 'missing-motor' }, { status: 400 });
  if (!base64 && !sourceUrl) return json({ error: 'missing-base64-or-sourceUrl' }, { status: 400 });

  const ts = Date.now();
  const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;

  let bytes, finalMime;
  try {
    if (base64) {
      bytes = b64ToBytes(base64);
      finalMime = mime || 'application/octet-stream';
    } else {
      // Vídeos Veo: el frontend manda sourceUrl = {worker}/veo/download?uri=<gemini>.
      // Hacer fetch a nuestra propia URL pública (worker→self) es un anti-patrón
      // en Cloudflare y falla. Detectamos ese caso y bajamos el vídeo DIRECTO de
      // Google con la API key, igual que veoDownloadHandler.
      let fetchUrl = sourceUrl, fetchHeaders = {};
      try {
        const su = new URL(sourceUrl);
        if (su.pathname === '/veo/download') {
          const geminiUri = su.searchParams.get('uri') || '';
          if (geminiUri.startsWith('https://generativelanguage.googleapis.com/')) {
            if (!env.GEMINI_API_KEY) return json({ error: 'server-missing-key' }, { status: 500 });
            fetchUrl = geminiUri;
            fetchHeaders = { 'x-goog-api-key': env.GEMINI_API_KEY };
          }
        }
      } catch { /* sourceUrl no es URL absoluta → fetch tal cual */ }

      const r = await fetch(fetchUrl, { headers: fetchHeaders });
      if (!r.ok) {
        const detail = (await r.text().catch(() => '')).slice(0, 200);
        return json({ error: 'sourceUrl-fetch-failed', status: r.status, detail }, { status: 502 });
      }
      const buf = await r.arrayBuffer();
      bytes = new Uint8Array(buf);
      finalMime = mime || r.headers.get('Content-Type') || 'application/octet-stream';
    }
  } catch (e) {
    return json({ error: 'decode-failed', detail: String(e) }, { status: 400 });
  }

  if (bytes.length > 200 * 1024 * 1024) return json({ error: 'too-big', max: 200 * 1024 * 1024 }, { status: 413 });

  const ext = extForMime(finalMime);
  const assetKey = `stock/${id}/asset.${ext}`;
  const metaKey  = `stock/${id}/meta.json`;
  // URL pública con el origen de la petición (no el hardcodeado): el listado
  // la reescribe igualmente, pero así la notificación Telegram y la respuesta
  // del publish ya salen por un dominio no bloqueado.
  const publicUrl = `${new URL(req.url).origin}/stock/asset/${id}`;

  await env.STOCK_BUCKET.put(assetKey, bytes, {
    httpMetadata: { contentType: finalMime, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { motor, type, id },
  });

  // Clasificación automática con Gemini (sincronizada, ~1-2s): tags para la
  // biblioteca + audience/category para publicidad dirigida (/targetPublicity).
  // Se llama siempre (audience/category nunca llegan del frontend); las tags
  // solo se sobrescriben si el frontend no mandó ninguna.
  let audience = 'all', category = 'producto';
  try {
    const auto = await generateAutoMeta(env, { title, prompt, comment, type, motor });
    if (!tags || tags.length === 0) tags = auto.tags;
    audience = auto.audience;
    category = auto.category;
  } catch { if (!tags) tags = []; }
  // En campañas segmentadas el frontend manda el público explícito → prevalece
  // sobre la clasificación de Gemini (es el segmento exacto de esta versión).
  if (bodyAudience) audience = bodyAudience;
  else if (segmentation && segmentation.audiences.length === 1) audience = segmentation.audiences[0];

  const meta = {
    id,
    type,
    motor: String(motor).slice(0, 80),
    prompt: String(prompt || '').slice(0, 1000),
    title: title ? String(title).slice(0, 300) : null,
    comment: comment ? String(comment).slice(0, 2000) : null,
    tags: tags || [],
    audience,
    category,
    segmentation: segmentation || null,
    ageBucket: (segmentation && segmentation.ageBuckets[0]) || null,   // edad principal (para pickCreative del gemelo)
    timeSlot: (segmentation && segmentation.timeSlots[0]) || null,     // franja principal (matching por daypart)
    costEst: costEst ? String(costEst).slice(0, 80) : null,
    mime: finalMime,
    ext,
    size: bytes.length,
    thumbnail: thumbnail ? String(thumbnail).slice(0, 500) : null,
    url: publicUrl,
    assetKey,
    fp,
    ph,
    price,
    createdAt: new Date(ts).toISOString(),
  };
  await env.STOCK_BUCKET.put(metaKey, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });

  // Regenera el índice estático sin retrasar la respuesta del publish
  ctx.waitUntil(rebuildStockIndex(env));

  // Notificación rica: motor / tipo / tamaño / URL / snippet del prompt + stats acumulados
  const mbStr = (bytes.length / 1024 / 1024).toFixed(2);
  const promptSnip = meta.prompt ? `\n💬 <i>${escHtml(meta.prompt.slice(0, 140))}${meta.prompt.length > 140 ? '…' : ''}</i>` : '';
  const commentSnip = meta.comment ? `\n📝 <i>${escHtml(String(meta.comment).slice(0, 140))}${meta.comment.length > 140 ? '…' : ''}</i>` : '';
  const footer = await buildStatsFooter(env);
  const tagsSnip = (meta.tags && meta.tags.length)
    ? `\n🏷 ${meta.tags.map(t => '<code>#' + escHtml(t) + '</code>').join(' ')}`
    : '';
  const text = `📦 <b>STOCK PUBLISH</b> · ${escHtml(meta.type)} · <code>${escHtml(meta.motor)}</code>\n` +
               `· ${mbStr} MB · ${escHtml(meta.mime)}\n` +
               `· <a href="${escHtml(publicUrl)}">ver asset</a>${promptSnip}${commentSnip}${tagsSnip}` +
               footer;
  notify(ctx, env, text);

  return json({ ok: true, id, url: publicUrl, createdAt: meta.createdAt });
}

async function stockListHandler(req, env, url) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  const typeFilter = url.searchParams.get('type') || '';
  const motorFilter = url.searchParams.get('motor') || '';
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));

  // List todos los meta.json bajo stock/. R2 devuelve hasta 1000/request.
  let allMetaKeys = [];
  let cursor;
  do {
    const result = await env.STOCK_BUCKET.list({ prefix: 'stock/', limit: 1000, cursor });
    for (const o of result.objects) {
      if (o.key.endsWith('/meta.json')) allMetaKeys.push(o.key);
    }
    cursor = result.truncated ? result.cursor : null;
  } while (cursor);

  // Fetch en paralelo (R2 GETs son Class B, baratísimas)
  const metas = (await Promise.all(allMetaKeys.map(async k => {
    try {
      const obj = await env.STOCK_BUCKET.get(k);
      if (!obj) return null;
      return await obj.json();
    } catch { return null; }
  }))).filter(Boolean);

  let filtered = metas;
  if (typeFilter)  filtered = filtered.filter(m => m.type === typeFilter);
  if (motorFilter) filtered = filtered.filter(m => m.motor === motorFilter);
  filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  // URLs host-agnósticas: las metas guardan la URL del host con el que se
  // publicaron (workers.dev, bloqueado por ISPs ES desde jun 2026). Se
  // reescriben al origen de ESTA petición para que el asset salga por el
  // mismo dominio por el que entró el listado (p.ej. pixer-api.pages.dev).
  const origin = new URL(req.url).origin;
  const items = filtered.slice(0, limit).map(m => ({
    ...m,
    // ?v=size: el asset es immutable; si se reprocesa (p.ej. recorte a
    // transparente) cambia el tamaño → nueva URL → el navegador no sirve el viejo.
    url: m.assetKey ? `${origin}/stock/asset/${m.id}?v=${m.size || 0}` : m.url,
    thumbnail: m.thumbnail ? m.thumbnail.replace(WORKER_PUBLIC_BASE, origin) : m.thumbnail,
  }));
  return json({ items, total: filtered.length });
}

// POST /stock/reasset {id, base64, mime}
// Sobrescribe el BLOB de un asset ya publicado conservando su id/meta (título,
// precio, fp, ph…). Lo usa la "pasada de transparencia": recortar el fondo de
// los muebles viejos (JPEG con fondo) y dejarlos PNG transparentes sin perder
// referencias ni duplicar. (Carlos 2026-06-11)
async function stockReassetHandler(req, env, ctx) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const id = b.id;
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return json({ error: 'bad-id' }, { status: 400 });
  if (!b.base64) return json({ error: 'missing-base64' }, { status: 400 });
  const metaObj = await env.STOCK_BUCKET.get(`stock/${id}/meta.json`);
  if (!metaObj) return json({ error: 'not-found' }, { status: 404 });
  let meta; try { meta = await metaObj.json(); } catch { return json({ error: 'bad-meta' }, { status: 500 }); }
  const mime = b.mime || 'image/png';
  const ext = extForMime(mime);
  let bytes; try { bytes = b64ToBytes(b.base64); } catch { return json({ error: 'bad-base64' }, { status: 400 }); }
  if (bytes.length > 50 * 1024 * 1024) return json({ error: 'too-big' }, { status: 413 });
  const newAssetKey = `stock/${id}/asset.${ext}`;
  await env.STOCK_BUCKET.put(newAssetKey, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { motor: meta.motor || '', type: meta.type || 'furni', id },
  });
  if (meta.assetKey && meta.assetKey !== newAssetKey) { try { await env.STOCK_BUCKET.delete(meta.assetKey); } catch {} }
  meta.assetKey = newAssetKey; meta.mime = mime; meta.ext = ext; meta.size = bytes.length;
  await env.STOCK_BUCKET.put(`stock/${id}/meta.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });
  ctx.waitUntil(rebuildStockIndex(env));
  return json({ ok: true, id, mime, size: bytes.length });
}

// ─── Índice estático de Stock en R2 (anti-bloqueo workers.dev) ─────
// Los ISP españoles bloquean el rango de IPs de *.workers.dev y *.pages.dev
// (188.114.96.0/22, bloqueos LaLiga), pero NO el de r2.dev. La galería
// pública (pixeria.com/stock.html) lee el listado y los blobs DIRECTAMENTE
// del bucket público para no depender del worker:
//   listado → {R2_PUB}/stock/index.json   (este archivo, max-age=60)
//   blobs   → {R2_PUB}/stock/{id}/asset.{ext}  (immutable, Range nativo)
// El índice se regenera tras cada mutación (publish/delete/tags/recategorize)
// y con un cron de respaldo cada 10 min por si alguna escritura se pierde.
const STOCK_PUBLIC_R2 = 'https://pub-bf043a4daa3b43b7a0b769617729d074.r2.dev';

async function rebuildStockIndex(env) {
  if (!env.STOCK_BUCKET) return;
  let keys = [];
  let cursor;
  do {
    const result = await env.STOCK_BUCKET.list({ prefix: 'stock/', limit: 1000, cursor });
    for (const o of result.objects) if (o.key.endsWith('/meta.json')) keys.push(o.key);
    cursor = result.truncated ? result.cursor : null;
  } while (cursor);

  const metas = (await Promise.all(keys.map(async k => {
    try {
      const obj = await env.STOCK_BUCKET.get(k);
      if (!obj) return null;
      return await obj.json();
    } catch { return null; }
  }))).filter(Boolean);

  metas.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const items = metas.map(m => ({
    ...m,
    url: m.assetKey ? `${STOCK_PUBLIC_R2}/${m.assetKey}?v=${m.size || 0}` : m.url,
    // thumbnail se deja tal cual: son data-URIs o URLs externas; si alguno
    // apuntase a workers.dev el <video> cae a preload de metadata sin póster.
  }));

  await env.STOCK_BUCKET.put('stock/index.json', JSON.stringify({ items, total: items.length, builtAt: new Date().toISOString() }), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' },
  });
}

// POST /stock/recategorize { secret, limit?, force? }
// Backfill de audience/category (vía Gemini) en items de Stock que aún no los
// tienen. Procesa en lotes pequeños para no agotar los subrequests del Worker
// (cada item actualizado = 1 read + 1 Gemini + 1 write). Llamar repetidamente
// hasta que updated=0. Con force=true reclasifica también los ya hechos.
async function stockRecategorizeHandler(req, env) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  let body = {};
  try { body = await req.json(); } catch {}
  if (!env.NOTIFY_KEY || body.secret !== env.NOTIFY_KEY) return json({ error: 'unauthorized' }, { status: 401 });
  const limit = Math.max(1, Math.min(12, parseInt(body.limit, 10) || 6));
  const force = !!body.force;
  const maxRead = limit * 6; // techo de lecturas por llamada (seguridad subrequests)

  let keys = [];
  let cursor;
  do {
    const result = await env.STOCK_BUCKET.list({ prefix: 'stock/', limit: 1000, cursor });
    for (const o of result.objects) if (o.key.endsWith('/meta.json')) keys.push(o.key);
    cursor = result.truncated ? result.cursor : null;
  } while (cursor);

  let read = 0, updated = 0;
  const done = [];
  for (const k of keys) {
    if (updated >= limit || read >= maxRead) break;
    let meta;
    try { const o = await env.STOCK_BUCKET.get(k); if (!o) continue; meta = await o.json(); } catch { continue; }
    read++;
    const has = meta && STOCK_AUDIENCES.includes(meta.audience) && STOCK_CATEGORIES.includes(meta.category);
    if (has && !force) continue;
    const auto = await generateAutoMeta(env, {
      title: meta.title || '', prompt: meta.prompt || '', comment: meta.comment || '',
      type: meta.type || '', motor: meta.motor || '',
    });
    meta.audience = auto.audience;
    meta.category = auto.category;
    if ((!Array.isArray(meta.tags) || !meta.tags.length) && auto.tags.length) meta.tags = auto.tags;
    try {
      await env.STOCK_BUCKET.put(k, JSON.stringify(meta), {
        httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
      });
      updated++;
      done.push({ id: meta.id, audience: meta.audience, category: meta.category });
    } catch {}
  }
  return json({
    ok: true, total: keys.length, read, updated, batchLimit: limit, done,
    hint: updated >= limit ? 'Vuelve a llamar para el siguiente lote' : 'Backfill probablemente completo',
  });
}

// POST /stock/:id/tags — sobrescribe meta.tags con la lista del body { tags: [...] }
async function stockEditTagsHandler(req, env, ctx, id) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  if (!/^[A-Za-z0-9-]+$/.test(id)) return json({ error: 'bad-id' }, { status: 400 });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!Array.isArray(body.tags)) return json({ error: 'missing-tags-array' }, { status: 400 });

  const cleaned = body.tags
    .map(t => String(t).toLowerCase().trim().replace(/^[#·.\s]+|[#·.\s]+$/g, ''))
    .filter(t => t && t.length <= 30)
    .slice(0, 8); // máximo 8 etiquetas

  const metaKey = `stock/${id}/meta.json`;
  const obj = await env.STOCK_BUCKET.get(metaKey);
  if (!obj) return json({ error: 'not-found' }, { status: 404 });
  let meta;
  try { meta = await obj.json(); } catch { return json({ error: 'bad-meta' }, { status: 500 }); }

  const before = Array.isArray(meta.tags) ? meta.tags.slice() : [];
  meta.tags = cleaned;
  // Override manual opcional de la segmentación (si el body los trae y son válidos).
  if (STOCK_AUDIENCES.includes(body.audience)) meta.audience = body.audience;
  if (STOCK_CATEGORIES.includes(body.category)) meta.category = body.category;
  await env.STOCK_BUCKET.put(metaKey, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });
  ctx.waitUntil(rebuildStockIndex(env));

  // Notify (silencioso si los tags no han cambiado)
  const changed = JSON.stringify(before) !== JSON.stringify(cleaned);
  if (changed) {
    const tagsHtml = cleaned.length
      ? cleaned.map(t => '<code>#' + escHtml(t) + '</code>').join(' ')
      : '<i>(sin etiquetas)</i>';
    notify(ctx, env, `✏️ <b>STOCK EDIT TAGS</b> · ${escHtml(meta.type || '')} · <code>${escHtml(id)}</code>\n🏷 ${tagsHtml}`);
  }

  return json({ ok: true, id, tags: cleaned });
}

// DELETE /stock/:id — borra los 2 objetos R2 (asset + meta) de un item.
// Sin auth (admira.studio es admin-only por convención del dominio).
async function stockDeleteHandler(req, env, ctx, id) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  if (!/^[A-Za-z0-9-]+$/.test(id)) return json({ error: 'bad-id' }, { status: 400 });

  const metaKey = `stock/${id}/meta.json`;
  const metaObj = await env.STOCK_BUCKET.get(metaKey);
  if (!metaObj) return json({ error: 'not-found' }, { status: 404 });

  let meta = null;
  try { meta = await metaObj.json(); } catch {}

  const keysToDelete = [metaKey];
  if (meta && meta.assetKey) keysToDelete.push(meta.assetKey);

  // Limpieza defensiva: lista el prefijo stock/{id}/ por si quedan huérfanos.
  try {
    const listed = await env.STOCK_BUCKET.list({ prefix: `stock/${id}/`, limit: 50 });
    for (const o of listed.objects) {
      if (!keysToDelete.includes(o.key)) keysToDelete.push(o.key);
    }
  } catch {}

  await Promise.all(keysToDelete.map(k => env.STOCK_BUCKET.delete(k)));
  ctx.waitUntil(rebuildStockIndex(env));

  if (meta) {
    const text = `🗑 <b>STOCK DELETE</b> · ${escHtml(meta.type || 'unknown')} · <code>${escHtml(meta.motor || '')}</code>\n· id <code>${escHtml(id)}</code>`;
    notify(ctx, env, text);
  }

  return json({ ok: true, id, deleted: keysToDelete.length });
}

async function stockAssetHandler(req, env, id) {
  if (!env.STOCK_BUCKET) return new Response('r2-not-bound', { status: 500 });
  if (!/^[A-Za-z0-9-]+$/.test(id)) return new Response('bad-id', { status: 400 });

  const metaObj = await env.STOCK_BUCKET.get(`stock/${id}/meta.json`);
  if (!metaObj) return new Response('not-found', { status: 404 });
  let meta;
  try { meta = await metaObj.json(); } catch { return new Response('bad-meta', { status: 500 }); }

  const range = req.headers.get('Range') || undefined;
  const obj = range
    ? await env.STOCK_BUCKET.get(meta.assetKey, { range: parseRange(range, meta.size) })
    : await env.STOCK_BUCKET.get(meta.assetKey);
  if (!obj) return new Response('asset-gone', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Type', meta.mime || headers.get('Content-Type') || 'application/octet-stream');
  // CORS en el asset: el gemelo dibuja sprites de mobiliario con
  // crossOrigin='anonymous' (canvas sin "tainted"), así que el blob debe
  // exponer Access-Control-Allow-Origin para el origen del juego.
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  if (obj.range) {
    const { offset, length } = obj.range;
    const end = offset + length - 1;
    headers.set('Content-Range', `bytes ${offset}-${end}/${meta.size}`);
    headers.set('Content-Length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(meta.size));
  return new Response(obj.body, { status: 200, headers });
}

function parseRange(range, size) {
  // "bytes=START-END" o "bytes=START-"
  const m = String(range).match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return undefined;
  const offset = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : size - 1;
  const length = Math.max(0, Math.min(size, end + 1) - offset);
  if (length === 0) return undefined;
  return { offset, length };
}

// ─── Router ────────────────────────────────────────────────────────
// ─── /idea — chat con Nemotron Ultra 3 (OpenRouter, OpenAI-compatible) ──
// POST /idea { messages: [{role:'user'|'assistant', content}] } → { reply, model }
// Secret:  OPENROUTER_KEY   ·   Var opcional: NEMOTRON_MODEL
const IDEA_SYSTEM =
  'Eres Nemotron, el asistente de ideas de Pixeria (pixeria.com), la referencia en ' +
  'creación de contenido con IA del grupo Admira. Ayudas a dar forma a ideas y resolver dudas sobre ' +
  'crear, dirigir y publicar contenido con IA: modelos (vídeo, imagen, voz, música), prompts, pipelines, ' +
  'costes, derechos, distribución y signage en pantallas (Pixer Feed). Responde en el idioma del usuario ' +
  '(por defecto español), claro, concreto y con criterio práctico, sin humo. Si algo cae fuera de tu ámbito, ' +
  'dilo brevemente y reconduce hacia la idea.';

async function ideaHandler(req, env) {
  if (!env.OPENROUTER_KEY) return json({ error: 'server-missing-key', service: 'openrouter' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const msgs = incoming
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
  if (!msgs.length) return json({ error: 'no-messages' }, { status: 400 });

  // Modelos a intentar en orden. El primario (Nemotron grande :free) tiene cola
  // compartida en OpenRouter y a veces NO responde nunca → antes el fetch no
  // tenía timeout y el chat se quedaba "pensando" para siempre. Ahora: timeout
  // por intento (AbortController) + fallback a un Nemotron más pequeño/rápido.
  // Primario = NANO (rápido, raramente encola). El super 120b :free se cuelga
  // en cola con frecuencia → lo dejamos solo como fallback. 2 intentos × 30s
  // = 60s < timeout del cliente (75s). NEMOTRON_MODEL (var) puede forzar otro.
  const preferred = env.NEMOTRON_MODEL || 'nvidia/nemotron-3-nano-30b-a3b:free';
  const candidates = [...new Set([preferred, 'nvidia/nemotron-3-super-120b-a12b:free'])];
  const PER_TRY_MS = 30000;

  let lastErr = null;
  for (const model of candidates) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), PER_TRY_MS);
    let r;
    try {
      r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://www.pixeria.com',
          'X-Title': 'Pixeria Idea',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: IDEA_SYSTEM }, ...msgs],
          temperature: 0.7,
          // Nemotron 3 razona antes de responder (reasoning_tokens ~200-500).
          // Margen amplio para que el reasoning NO se coma el presupuesto y
          // deje el `content` vacío en respuestas largas.
          max_tokens: 2500,
        }),
      });
    } catch (e) {
      clearTimeout(to);
      // abort (timeout) o fallo de red → probar el siguiente modelo
      lastErr = { error: ctrl.signal.aborted ? 'upstream-timeout' : 'upstream-fetch-failed', model, message: String(e) };
      continue;
    }
    clearTimeout(to);

    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 400); } catch {}
      // 429 (rate-limit del :free) o 5xx → probar siguiente; otros errores también
      lastErr = { error: 'upstream-error', status: r.status, model, detail };
      continue;
    }
    let data;
    try { data = await r.json(); } catch { lastErr = { error: 'bad-upstream-json', model }; continue; }
    const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!reply) { lastErr = { error: 'empty-reply', model }; continue; }
    return json({ reply, model });
  }
  // Todos los modelos fallaron
  return json(lastErr || { error: 'all-models-failed' }, { status: 502 });
}

// ─── Agora — coordinación multi-agente (reconstruido 2026-06-09) ──────
// Backend del CLI ~/.local/bin/agora. Storage en SIGNAGE_KV (prefijo "agora:").
// Auth: ?key= (GET) o body.key (POST) === env.AGORA_SYNC_KEY (la .synckey de 32
// chars del grid). Todas las rutas /agora/* están EXCLUIDAS del espejo a Telegram
// (ver NOTIFY_SKIP_PREFIX) — son housekeeping de alta frecuencia, no se notifican.
const AGORA_IDENTITIES = ['Claude·admira', 'Codex·admira', 'Claude·gmail', 'Codex·gmail', 'OpenCode·grok'];
const AGORA_COMMAND_TARGETS = {
  neo: { identity: 'Claude·admira', persona: 'Neo' },
  morfeo: { identity: 'Claude·gmail', persona: 'Morfeo' },
  morpheus: { identity: 'Claude·gmail', persona: 'Morfeo' },
  trinity: { identity: 'Codex·admira', persona: 'Trinity' },
  oraculo: { identity: 'Codex·gmail', persona: 'Oráculo' },
  oracle: { identity: 'Codex·gmail', persona: 'Oráculo' },
  cypher: { identity: 'OpenCode·grok', persona: 'Cypher' },
};
const AGORA_AWAKE_MS = 5 * 60 * 1000; // visto < 5 min = despierto
const AGORA_FEED_CAP = 200;           // últimos N items del feed compartido
const AGORA_QUEUE_CAP = 100;          // tope por buzón/cola
const AGORA_TASKLOG_CAP = 100;        // historial compacto para comandos del grupo
const AGORA_FALLBACK_CHAT_IDS = new Set(['-5110197528']);

function agoraAuth(env, key) {
  return !!env.AGORA_SYNC_KEY && key === env.AGORA_SYNC_KEY;
}
async function agoraKvGet(env, key, fallback) {
  try { const v = await env.SIGNAGE_KV.get(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
async function agoraKvPut(env, key, value, now) {
  if (!(await reserveKvWrite(env, now))) return false;
  try { await env.SIGNAGE_KV.put(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
function agoraChatAllowed(chatId, expectedChat) {
  if (!expectedChat) return true;
  return String(chatId) === String(expectedChat) || AGORA_FALLBACK_CHAT_IDS.has(String(chatId));
}
function agoraCommandKey(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}
function agoraCommandFromText(text) {
  const m = String(text || '').trim().match(/^\/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ_.-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const alias = agoraCommandKey(m[1]);
  const target = AGORA_COMMAND_TARGETS[alias];
  if (!target) return null;
  return { alias, target, text: String(m[2] || '').trim() };
}
function agoraPersonaNameForIdentity(identity) {
  for (const target of Object.values(AGORA_COMMAND_TARGETS)) {
    if (target.identity === identity) return target.persona;
  }
  return identity;
}
function agoraCliCommandFromText(text) {
  const m = String(text || '').trim().match(/^\/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ_.-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const alias = agoraCommandKey(m[1]);
  if (!['inbox', 'help', 'ayuda'].includes(alias)) return null;
  return { alias, text: String(m[2] || '').trim() };
}
async function agoraEnqueueForIdentity(env, identity, kind, item, now) {
  const kkey = `agora:${kind}:${identity}`;
  const items = await agoraKvGet(env, kkey, []);
  items.push(item);
  await agoraKvPut(env, kkey, items.slice(-AGORA_QUEUE_CAP), now);
}
async function agoraAppendTaskLog(env, item, now) {
  const items = await agoraKvGet(env, 'agora:tasklog', []);
  items.push(item);
  await agoraKvPut(env, 'agora:tasklog', items.slice(-AGORA_TASKLOG_CAP), now);
}
function agoraFormatTs(ts) {
  if (!ts) return '';
  try { return new Date(ts).toISOString().slice(5, 16).replace('T', ' '); }
  catch { return ''; }
}
async function agoraInboxCliText(env, limit) {
  const n = Math.max(1, Math.min(10, parseInt(limit, 10) || 10));
  const items = (await agoraKvGet(env, 'agora:tasklog', [])).slice(-n).reverse();
  if (!items.length) return '<b>Inbox AgoraMatrix</b>\nSin tareas registradas todavia.';
  const lines = [`<b>Inbox AgoraMatrix</b> · ultimas ${items.length} tareas`];
  items.forEach((it, idx) => {
    const ts = agoraFormatTs(it.ts);
    const persona = it.persona || it.identity || '?';
    const command = it.command || '';
    const who = it.who || 'humano';
    const text = String(it.text || '').replace(/\s+/g, ' ').slice(0, 220);
    lines.push(`${idx + 1}. <code>${escHtml(ts)}</code> <b>${escHtml(persona)}</b> ${escHtml(command)}`);
    lines.push(`   ${escHtml(who)}: ${escHtml(text || '(sin texto)')}`);
  });
  return lines.join('\n').slice(0, 3900);
}
async function agoraCliCommandReply(env, command) {
  if (command.alias === 'help' || command.alias === 'ayuda') {
    return '<b>CLI AgoraMatrix</b>\n/inbox — ultimas 10 tareas\n/inbox 5 — ultimas 5 tareas\n/oraculo, /cypher, /morfeo, /neo, /trinity — invocar agente';
  }
  return agoraInboxCliText(env, command.text);
}

// POST /agora/presence {key,identity,host,tokens?,reqs?}  ·  GET /agora/presence?key=
async function agoraPresenceHandler(req, env, url) {
  const now = Date.now();
  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
    if (!agoraAuth(env, b.key)) return json({ error: 'unauthorized' }, { status: 401 });
    if (!b.identity) return json({ error: 'missing-identity' }, { status: 400 });
    const map = await agoraKvGet(env, 'agora:presence', {});
    map[b.identity] = { ts: now, host: b.host || '', tokens: b.tokens || 0, reqs: b.reqs || 0 };
    await agoraKvPut(env, 'agora:presence', map, now);
    return json({ ok: true });
  }
  if (!agoraAuth(env, url.searchParams.get('key'))) return json({ error: 'unauthorized' }, { status: 401 });
  const map = await agoraKvGet(env, 'agora:presence', {});
  const agents = Object.entries(map).map(([identity, p]) => ({
    identity, ts: p.ts || 0, awake: (now - (p.ts || 0)) < AGORA_AWAKE_MS,
    host: p.host || '', tokens: p.tokens || 0, reqs: p.reqs || 0,
  }));
  return json({ agents });
}

// POST /agora/feed {key,from,text,kind?,url?,host?}  ·  GET /agora/feed?key=&limit=
async function agoraFeedHandler(req, env, url, ctx) {
  const now = Date.now();
  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
    if (!agoraAuth(env, b.key)) return json({ error: 'unauthorized' }, { status: 401 });
    const from = b.from || '?';
    const text = String(b.text || '').slice(0, 2000);
    const feed = await agoraKvGet(env, 'agora:feed', []);
    feed.push({ ts: now, from, text, kind: b.kind || 'msg', url: b.url || undefined, host: b.host || undefined });
    await agoraKvPut(env, 'agora:feed', feed.slice(-AGORA_FEED_CAP), now);
    // Espejo Agora→Telegram (bidireccional, decisión Carlos 2026-06-10): los
    // MENSAJES del feed (agora send) SÍ se reflejan al grupo, para que la
    // conversación entre agentes sea visible. El housekeeping (presence/inbox/
    // tasks/config) sigue FUERA del espejo (era el que spameaba). Anti-bucle:
    // los mensajes que vienen de Telegram entran por el webhook al INBOX, no al
    // feed, así que esto no los reenvía; marcamos con from para distinguir.
    if (text && ctx) {
      const tgMsg = `💬 <b>${escHtml(from)}</b>${b.host ? ` <i>· ${escHtml(b.host)}</i>` : ''}\n${escHtml(text)}${b.url ? `\n${escHtml(b.url)}` : ''}`;
      // Grupo AgoraMatrix + bot del agente (ambos resueltos desde la bóveda).
      ctx.waitUntil((async () => {
        const cid = await agoraTgChatId(env);
        const tok = await agoraBotTokenFor(env, from);
        await sendTelegramVia(tok, cid, tgMsg);
      })().catch(() => {}));
    }
    return json({ ok: true });
  }
  if (!agoraAuth(env, url.searchParams.get('key'))) return json({ error: 'unauthorized' }, { status: 401 });
  const limit = Math.max(1, Math.min(AGORA_FEED_CAP, parseInt(url.searchParams.get('limit'), 10) || 30));
  const feed = await agoraKvGet(env, 'agora:feed', []);
  return json({ items: feed.slice(-limit) });
}

// POST /agora/config {key,config}  ·  GET /agora/config?key=
async function agoraConfigHandler(req, env, url) {
  const now = Date.now();
  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
    if (!agoraAuth(env, b.key)) return json({ error: 'unauthorized' }, { status: 401 });
    const blob = JSON.stringify(b.config || {});
    await agoraKvPut(env, 'agora:config', { config: b.config || {}, ts: now }, now);
    return json({ ok: true, bytes: blob.length });
  }
  if (!agoraAuth(env, url.searchParams.get('key'))) return json({ error: 'unauthorized' }, { status: 401 });
  const stored = await agoraKvGet(env, 'agora:config', null);
  return json({ config: stored ? stored.config : null });
}

// GET /agora/inbox?key=&id=&consume=   ·   GET /agora/tasks?key=&id=&consume=
async function agoraQueueHandler(req, env, url, kind) {
  const now = Date.now();
  if (!agoraAuth(env, url.searchParams.get('key'))) return json({ error: 'unauthorized' }, { status: 401 });
  const id = url.searchParams.get('id') || '';
  if (!id) return json({ error: 'missing-id' }, { status: 400 });
  const kkey = `agora:${kind}:${id}`;
  const items = await agoraKvGet(env, kkey, []);
  if (url.searchParams.get('consume') === '1' && items.length) {
    await agoraKvPut(env, kkey, [], now);
  }
  return json({ items });
}

// POST /agora/analyze {key,imageUrl,prompt,provider}  → visión (Gemini Flash)
async function agoraAnalyzeHandler(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!agoraAuth(env, b.key)) return json({ error: 'unauthorized' }, { status: 401 });
  if (!b.imageUrl) return json({ ok: false, detail: 'missing-imageUrl' }, { status: 400 });
  if (!env.GEMINI_API_KEY) return json({ ok: false, detail: 'no-gemini-key' });
  const prompt = b.prompt || 'Analiza esta imagen de forma concisa.';
  try {
    const ir = await fetch(b.imageUrl);
    if (!ir.ok) return json({ ok: false, detail: `image-fetch ${ir.status}` });
    const mime = ir.headers.get('content-type') || 'image/jpeg';
    const buf = new Uint8Array(await ir.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const gr = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: btoa(bin) } }] }] }),
    });
    const gd = await gr.json().catch(() => ({}));
    if (!gr.ok) return json({ ok: false, detail: `gemini ${gr.status}: ${JSON.stringify(gd).slice(0, 200)}` });
    const parts = (((gd.candidates || [])[0] || {}).content || {}).parts || [];
    const text = parts.map(p => p.text).filter(Boolean).join('');
    return json({ ok: true, text, model: 'gemini-2.5-flash' });
  } catch (e) {
    return json({ ok: false, detail: String(e).slice(0, 200) });
  }
}

async function agoraEnqueueCommand(env, command, who, chat) {
  const now = Date.now();
  const body = command.text || `Carlos invoca /${command.alias}. Responde en AgoraMatrix y queda a la espera de instrucciones.`;
  const item = {
    ts: now,
    who: who || 'humano',
    text: body.slice(0, 1000),
    command: `/${command.alias}`,
    persona: command.target.persona,
    chat: chat != null ? chat : undefined,
  };
  await agoraEnqueueForIdentity(env, command.target.identity, 'inbox', item, now);
  await agoraEnqueueForIdentity(env, command.target.identity, 'tasks', item, now);
  await agoraAppendTaskLog(env, { ...item, identity: command.target.identity }, now);
  return { identity: command.target.identity, persona: command.target.persona, text: body };
}

async function agoraEnqueueDirect(env, identity, text, who, chat, command) {
  const now = Date.now();
  const persona = agoraPersonaNameForIdentity(identity);
  const item = {
    ts: now,
    who: who || 'humano',
    text: String(text || '').slice(0, 1000),
    command: command || undefined,
    persona,
    chat: chat != null ? chat : undefined,
  };
  await agoraEnqueueForIdentity(env, identity, 'inbox', item, now);
  await agoraEnqueueForIdentity(env, identity, 'tasks', item, now);
  await agoraAppendTaskLog(env, { ...item, identity }, now);
  return { identity, persona, text: item.text };
}

async function agoraHookHandler(req, env, url, ctx) {
  if (req.method !== 'POST') return json({ ok: true });
  const identity = url.searchParams.get('id') || '';
  if (!AGORA_IDENTITIES.includes(identity)) return json({ ok: true });
  let update;
  try { update = await req.json(); } catch { return json({ ok: true }); }
  const msg = update.message || update.edited_message;
  if (!msg) return json({ ok: true });
  const chatId = String((msg.chat && msg.chat.id) || '');
  const expectedChat = await agoraTgChatId(env);
  if (!agoraChatAllowed(chatId, expectedChat)) return json({ ok: true });
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return json({ ok: true });
  const who = (msg.from && (msg.from.first_name || msg.from.username)) || 'humano';
  const token = await agoraBotTokenFor(env, identity);
  const cliCommand = agoraCliCommandFromText(text);
  if (cliCommand) {
    ctx.waitUntil(sendTelegramVia(token, chatId, await agoraCliCommandReply(env, cliCommand)).catch(() => {}));
    return json({ ok: true });
  }
  const command = agoraCommandFromText(text);
  if (command) {
    ctx.waitUntil((async () => {
      const routed = await agoraEnqueueCommand(env, command, who, chatId);
      const tok = await agoraBotTokenFor(env, routed.identity);
      await sendTelegramVia(tok || token, chatId, `📨 <b>${escHtml(routed.persona)}</b> invocado.\n<code>${escHtml(routed.text.slice(0, 900))}</code>`);
    })().catch(() => {}));
    return json({ ok: true });
  }
  ctx.waitUntil((async () => {
    const routed = await agoraEnqueueDirect(env, identity, text, who, chatId, '/direct');
    await sendTelegramVia(token, chatId, `📨 <b>${escHtml(routed.persona)}</b> recibido.\n<code>${escHtml(routed.text.slice(0, 900))}</code>`);
  })().catch(() => {}));
  return json({ ok: true });
}

// Encola un mensaje del grupo de Telegram en el buzón de TODAS las identidades
// (lo recoge el cmd-poller y `agora inbox`). Mismo ts en todas → el poller dedup
// por high-water mark y dispara una sola vez. Best-effort.
async function agoraEnqueueInbox(env, text, who, chat) {
  const now = Date.now();
  for (const id of AGORA_IDENTITIES) {
    await agoraEnqueueForIdentity(env, id, 'inbox', {
      ts: now,
      who: who || 'humano',
      text: String(text || '').slice(0, 1000),
      chat: chat != null ? chat : undefined,
    }, now);
  }
}

// ─── DISTRIBUCIONES (layouts de mobiliario) ──────────────────────────
// Canal compartido pixeria ⇄ gemelos: una "distribución" es la sala entera
// (config + mobiliario + staff). Vive en SIGNAGE_KV con prefijo `layout:`.
//   layout:index        → [{id,name,client,source,savedAt,counts,thumb?}] (resumen, cap 120)
//   layout:item:<id>    → JSON completo {schema,id,name,client,source,savedAt,config,furniture,staff,thumb?}
// Sin auth (como el stock); CORS por whitelist. Pixeria publica/edita; los
// gemelos publican su distribución actual y aplican una. (Carlos 2026-06-11)
const LAYOUT_INDEX_CAP = 120;
function layoutSummary(item) {
  return {
    id: item.id, name: item.name || '(sin nombre)', client: item.client || null,
    source: item.source || 'pixeria', savedAt: item.savedAt || null,
    counts: { furniture: Array.isArray(item.furniture) ? item.furniture.length : 0,
              staff: Array.isArray(item.staff) ? item.staff.length : 0 },
    thumb: item.thumb || null,
  };
}
async function layoutPublishHandler(req, env, ctx) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!Array.isArray(b.furniture)) return json({ error: 'missing-furniture' }, { status: 400 });
  const now = Date.now();
  const id = (typeof b.id === 'string' && /^[A-Za-z0-9_-]{3,40}$/.test(b.id))
    ? b.id : `${now}-${Math.random().toString(36).slice(2, 8)}`;
  const item = {
    schema: 'distribucion-1', id,
    name: String(b.name || '').slice(0, 80) || 'Distribución',
    client: b.client ? String(b.client).slice(0, 40) : null,
    source: ['pixeria', 'gemelo'].includes(b.source) ? b.source : 'pixeria',
    savedAt: new Date(now).toISOString(),
    config: (b.config && typeof b.config === 'object') ? b.config : null,
    furniture: b.furniture.slice(0, 200),
    staff: Array.isArray(b.staff) ? b.staff.slice(0, 30) : [],
    thumb: (typeof b.thumb === 'string' && b.thumb.length < 200000) ? b.thumb : null,
  };
  await agoraKvPut(env, `layout:item:${id}`, item, now);
  const index = await agoraKvGet(env, 'layout:index', []);
  const filtered = index.filter(x => x.id !== id);
  filtered.unshift(layoutSummary(item));
  await agoraKvPut(env, 'layout:index', filtered.slice(0, LAYOUT_INDEX_CAP), now);
  return json({ ok: true, id, name: item.name });
}
async function layoutListHandler(req, env, url) {
  const index = await agoraKvGet(env, 'layout:index', []);
  const client = url.searchParams.get('client');
  const items = client ? index.filter(x => !x.client || x.client === client) : index;
  return json({ items });
}
async function layoutGetHandler(req, env, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'missing-id' }, { status: 400 });
  const item = await agoraKvGet(env, `layout:item:${id}`, null);
  if (!item) return json({ error: 'not-found' }, { status: 404 });
  return json(item);
}
async function layoutDeleteHandler(req, env, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'missing-id' }, { status: 400 });
  const now = Date.now();
  try { await env.SIGNAGE_KV.delete(`layout:item:${id}`); } catch {}
  const index = await agoraKvGet(env, 'layout:index', []);
  await agoraKvPut(env, 'layout:index', index.filter(x => x.id !== id), now);
  return json({ ok: true, id });
}
// MUDANZA: asigna una distribución a una o varias pantallas (gemelos) para que
// la apliquen solas. Guarda un puntero "pendiente" por pantalla; el gemelo lo
// sondea con /layout/pending?screen= y aplica cuando el ts es nuevo.
async function layoutAssignHandler(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const id = String(b.id || '');
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) return json({ error: 'bad-id' }, { status: 400 });
  const targets = Array.isArray(b.targets) ? b.targets.map(t => String(t).slice(0, 60)).filter(t => /^[a-z0-9_-]+$/i.test(t)) : [];
  if (!targets.length) return json({ error: 'no-targets' }, { status: 400 });
  const now = Date.now();
  const ptr = { id, ts: now, name: String(b.name || '').slice(0, 80) };
  await Promise.all(targets.map(scr => agoraKvPut(env, `layout:pending:${scr}`, ptr, now)));
  return json({ ok: true, id, targets });
}
async function layoutPendingHandler(req, env, url) {
  const screen = String(url.searchParams.get('screen') || '').slice(0, 60);
  if (!screen) return json({ pending: null });
  const ptr = await agoraKvGet(env, `layout:pending:${screen}`, null);
  return json({ pending: ptr || null });
}

// ─── MONEDERO DEL XPACIO (Marketplace: comprar muebles con créditos) ──
// Por Xpacio (id propio del navegador/cuenta): saldo + inventario «Mis
// muebles». KV `xpacio:<id>`. Comprar descuenta el precio del furni. Los
// muebles comprados se colocan en el editor de Distribución. (Carlos 2026-06-11)
const XPACIO_DEFAULT_BALANCE = 2000;
function xpacioKey(id) { return 'xpacio:' + String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40); }
function furniPrice(item) {
  if (item && item.price != null && isFinite(+item.price)) return Math.max(0, Math.round(+item.price));
  const fp = Array.isArray(item && item.fp) ? item.fp : [1, 1];
  const area = Math.max(1, (fp[0] || 1) * (fp[1] || 1));
  return 50 + 30 * area;   // precio por defecto si el furni no trae price
}
async function xpacioLoad(env, id) {
  const w = await agoraKvGet(env, xpacioKey(id), null);
  return w || { id: String(id || '').slice(0, 40), balance: XPACIO_DEFAULT_BALANCE, owned: [] };
}
async function xpacioGetHandler(req, env, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'missing-id' }, { status: 400 });
  return json(await xpacioLoad(env, id));
}
async function xpacioBuyHandler(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!b.id || !b.item || !b.item.url) return json({ error: 'missing-id-or-item' }, { status: 400 });
  const now = Date.now();
  const w = await xpacioLoad(env, b.id);
  if (w.owned.some(o => o.url === b.item.url)) return json({ ok: true, already: true, wallet: w });
  const price = furniPrice(b.item);
  if ((w.balance || 0) < price) return json({ ok: false, error: 'insufficient', balance: w.balance || 0, price }, { status: 402 });
  w.balance = (w.balance || 0) - price;
  w.owned.unshift({
    url: b.item.url, title: String(b.item.title || 'Mueble').slice(0, 120),
    fp: Array.isArray(b.item.fp) ? b.item.fp : [1, 1], ph: +b.item.ph || 46, price, ts: now,
  });
  w.owned = w.owned.slice(0, 300);
  await agoraKvPut(env, xpacioKey(b.id), w, now);
  return json({ ok: true, wallet: w, spent: price });
}
async function xpacioCreditHandler(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!b.id) return json({ error: 'missing-id' }, { status: 400 });
  const now = Date.now();
  const w = await xpacioLoad(env, b.id);
  const amt = Math.max(-100000, Math.min(100000, Math.round(+b.amount || 0)));
  w.balance = Math.max(0, (w.balance || 0) + amt);
  await agoraKvPut(env, xpacioKey(b.id), w, now);
  return json({ ok: true, wallet: w });
}

export default {
  // Cron de respaldo (wrangler.toml → [triggers]): reconstruye stock/index.json
  // por si alguna regeneración post-mutación se perdió. Corre EN Cloudflare,
  // así que no le afecta el bloqueo de workers.dev de los ISP españoles.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rebuildStockIndex(env));
  },

  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    const url = new URL(req.url);
    const path = url.pathname;
    const t0 = Date.now();
    const origin = req.headers.get('Origin') || req.headers.get('Referer') || 'direct';
    let res;
    try {
      if (path === '/healthz') {
        res = json({ ok: true, hasElevenKey: !!env.ELEVENLABS_KEY, hasXaiKey: !!env.XAI_KEY, hasGcpKey: !!env.GCP_SA_KEY, hasGeminiKey: !!env.GEMINI_API_KEY, hasOpenRouterKey: !!env.OPENROUTER_KEY, hasStockBucket: !!env.STOCK_BUCKET, hasSignageKv: !!env.SIGNAGE_KV });
      } else if (path === '/grok/latest.json' && req.method === 'GET') {
        res = grokLatestHandler();
      } else if (path === '/tts' && req.method === 'POST') {
        res = await ttsHandler(req, env);
      } else if (path === '/xai/image' && req.method === 'POST') {
        res = await xaiImageHandler(req, env);
      } else if (path === '/xai/video' && req.method === 'POST') {
        res = await xaiVideoStartHandler(req, env);
      } else if (path.startsWith('/xai/video/') && req.method === 'GET') {
        const id = path.slice('/xai/video/'.length);
        res = await xaiVideoPollHandler(req, env, id);
      } else if (path === '/pvideo' && req.method === 'GET') {
        res = await pollinationsVideoHandler(req, env, url);
      } else if (path === '/lyria/generate' && req.method === 'POST') {
        res = await lyriaHandler(req, env);
      } else if (path === '/llm/lyrics' && req.method === 'POST') {
        res = await geminiHandler(req, env);
      } else if (path === '/idea' && req.method === 'POST') {
        res = await ideaHandler(req, env);
      } else if (path === '/agora/presence') {
        res = await agoraPresenceHandler(req, env, url);
      } else if (path === '/agora/feed') {
        res = await agoraFeedHandler(req, env, url, ctx);
      } else if (path === '/agora/hook' && req.method === 'POST') {
        res = await agoraHookHandler(req, env, url, ctx);
      } else if (path === '/agora/tg-test' && req.method === 'GET') {
        res = await agoraTgTestHandler(req, env, url);
      } else if (path === '/agora/config') {
        res = await agoraConfigHandler(req, env, url);
      } else if (path === '/agora/inbox' && req.method === 'GET') {
        res = await agoraQueueHandler(req, env, url, 'inbox');
      } else if (path === '/agora/tasks' && req.method === 'GET') {
        res = await agoraQueueHandler(req, env, url, 'tasks');
      } else if (path === '/agora/analyze' && req.method === 'POST') {
        res = await agoraAnalyzeHandler(req, env);
      } else if (path === '/lyria3/generate' && req.method === 'POST') {
        res = await lyria3Handler(req, env);
      } else if (path === '/imagen/generate' && req.method === 'POST') {
        res = await imagenHandler(req, env);
      } else if (path === '/veo/generate' && req.method === 'POST') {
        res = await veoStartHandler(req, env);
      } else if (path.startsWith('/veo/status/') && req.method === 'GET') {
        const op = path.slice('/veo/status/'.length);
        res = await veoPollHandler(req, env, op);
      } else if (path === '/veo/download' && req.method === 'GET') {
        res = await veoDownloadHandler(req, env, url);
      } else if (path === '/signage/push' && req.method === 'POST') {
        res = await signagePushHandler(req, env, ctx);
      } else if (path === '/signage/feed' && req.method === 'GET') {
        res = await signageFeedHandler(req, env, url);
      } else if (path.startsWith('/signage/asset/') && req.method === 'GET') {
        const id = path.slice('/signage/asset/'.length);
        res = await signageAssetHandler(req, env, id);
      } else if (path.startsWith('/signage/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const key = decodeURIComponent(path.slice('/signage/media/'.length));
        res = await signageMediaHandler(req, env, key);
      } else if (path === '/signage/clear' && req.method === 'POST') {
        res = await signageClearHandler(req, env);
      } else if (path.startsWith('/signage/ack/') && req.method === 'POST') {
        const id = path.slice('/signage/ack/'.length);
        res = await signageAckHandler(req, env, id);
      } else if (path === '/signage/heartbeat' && req.method === 'POST') {
        res = await signageHeartbeatHandler(req, env);
      } else if (path === '/signage/screens' && req.method === 'GET') {
        res = await signageScreensHandler(req, env);
      } else if (path === '/signage/now' && req.method === 'GET') {
        res = await signageNowGetHandler(req, env, url);
      } else if (path === '/signage/now' && req.method === 'POST') {
        res = await signageNowPostHandler(req, env);
      } else if (path === '/notify' && req.method === 'POST') {
        res = await notifyHandler(req, env, ctx);
      } else if (path === '/telegram/webhook' && req.method === 'POST') {
        res = await telegramWebhookHandler(req, env, ctx);
      } else if (path === '/telegram/setup' && req.method === 'GET') {
        res = await telegramSetupHandler(req, env, url);
      } else if (path === '/stock/publish' && req.method === 'POST') {
        res = await stockPublishHandler(req, env, ctx);
      } else if (path === '/stock/list' && req.method === 'GET') {
        res = await stockListHandler(req, env, url);
      } else if (path === '/layout/publish' && req.method === 'POST') {
        res = await layoutPublishHandler(req, env, ctx);
      } else if (path === '/layout/list' && req.method === 'GET') {
        res = await layoutListHandler(req, env, url);
      } else if (path === '/layout/get' && req.method === 'GET') {
        res = await layoutGetHandler(req, env, url);
      } else if (path === '/layout/delete' && (req.method === 'POST' || req.method === 'DELETE')) {
        res = await layoutDeleteHandler(req, env, url);
      } else if (path === '/layout/assign' && req.method === 'POST') {
        res = await layoutAssignHandler(req, env);
      } else if (path === '/layout/pending' && req.method === 'GET') {
        res = await layoutPendingHandler(req, env, url);
      } else if (path === '/xpacio' && req.method === 'GET') {
        res = await xpacioGetHandler(req, env, url);
      } else if (path === '/xpacio/buy' && req.method === 'POST') {
        res = await xpacioBuyHandler(req, env);
      } else if (path === '/xpacio/credit' && req.method === 'POST') {
        res = await xpacioCreditHandler(req, env);
      } else if (path === '/lead' && req.method === 'POST') {
        res = await leadCreateHandler(req, env, ctx);
      } else if (path === '/leads' && req.method === 'GET') {
        res = await leadExportHandler(req, env, url);
      } else if (path === '/stock/recategorize' && req.method === 'POST') {
        res = await stockRecategorizeHandler(req, env);
      } else if (path === '/stock/reasset' && req.method === 'POST') {
        res = await stockReassetHandler(req, env, ctx);
      } else if (path.startsWith('/stock/asset/') && req.method === 'GET') {
        const id = path.slice('/stock/asset/'.length);
        res = await stockAssetHandler(req, env, id);
      } else if (path.startsWith('/stock/track/') && req.method === 'POST') {
        const id = path.slice('/stock/track/'.length);
        res = await stockTrackHandler(req, env, ctx, id);
      } else if (path.match(/^\/stock\/[^/]+\/tags$/) && req.method === 'POST') {
        const id = path.split('/')[2];
        res = await stockEditTagsHandler(req, env, ctx, id);
      } else if (path.startsWith('/stock/') && req.method === 'DELETE') {
        const id = path.slice('/stock/'.length);
        res = await stockDeleteHandler(req, env, ctx, id);
      } else {
        res = json({ error: 'not-found', path }, { status: 404 });
      }
    } catch (e) {
      res = json({ error: 'worker-exception', message: String(e) }, { status: 500 });
    }
    const ms = Date.now() - t0;
    const status = res.status;
    if (shouldNotify(path, req.method, status)) {
      const emoji = status >= 500 ? '🚨' : status >= 400 ? '⚠️' : '✅';
      let extra = '';
      if (status >= 400) {
        // Para errores intenta extraer mensaje del body sin consumir el response
        try {
          const cloned = res.clone();
          const text = await cloned.text();
          extra = `\n<code>${escHtml(text.slice(0, 300))}</code>`;
        } catch {}
      }
      const msg = `${emoji} <b>${escHtml(req.method)} ${escHtml(path)}</b>\n` +
                  `· ${status} · ${ms}ms\n` +
                  `· from <code>${escHtml(origin)}</code>${extra}`;
      notify(ctx, env, msg);
    }
    const cors = corsHeaders(req);
    Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  },
};
