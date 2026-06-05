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
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch {}
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
  '/signage/heartbeat',
  '/signage/feed',
  '/signage/screens',
  '/signage/now', // puntero "ahora reproduciendo" por pantalla — POST muy frecuente
  '/stock/list',
  '/stock/publish', // notificado dentro del handler con detalle (motor/tipo/tamaño)
  '/notify',        // este endpoint YA envía un mensaje al chat — no duplicar
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
];

function shouldNotify(path, method, status) {
  if (status >= 500) return true; // errores siempre
  if (NOTIFY_SKIP_EXACT.has(path)) return false;
  if (NOTIFY_SKIP_PREFIX.some(p => path.startsWith(p))) return false;
  if (method === 'GET') return false; // resto de GETs son lecturas baratas
  return true;
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

  const r = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.XAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: safeModel, prompt, n: Math.min(4, Math.max(1, n)), response_format: 'url' }),
  });
  const data = await r.json().catch(() => ({}));
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
    maxOutputTokens = 800,
  } = body;

  let sa;
  try { sa = JSON.parse(env.GCP_SA_KEY); } catch { return json({ error: 'bad-sa-key' }, { status: 500 }); }
  const projectId = sa.project_id;
  const safeModel = ['gemini-2.5-flash', 'gemini-2.5-pro'].includes(model) ? model : 'gemini-2.5-flash';

  // Construye prompt para letras
  const moods = Array.isArray(brief.emocion) ? brief.emocion.join(', ') : '';
  const layers = Array.isArray(brief.capas) ? brief.capas.join(', ') : '';
  const langName = { es: 'español', en: 'inglés', ca: 'catalán', fr: 'francés', pt: 'portugués', de: 'alemán', it: 'italiano' }[idioma] || idioma;

  const userPrompt = `Genera la letra de una canción en ${langName} con este brief:

- Cliente / proyecto: ${brief.cliente || 'sin especificar'}
- Uso: ${brief.uso || 'libre'}
- Emoción: ${moods || 'libre'}
- Tonalidad: ${brief.tonalidad || 'libre'}
- BPM: ${brief.bpm || 'libre'}
- Capas musicales: ${layers || 'libre'}
- Versiones a entregar: ${brief.versiones || 'una versión completa'}

Devuelve SOLO la letra estructurada con secciones marcadas: [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], [Outro]. Sin comentarios, sin explicaciones, sin markdown. Máximo 24 líneas.`;

  let token;
  try { token = await getGcpAccessToken(env); }
  catch (e) { return json({ error: 'gcp-auth-failed', message: String(e) }, { status: 500 }); }

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${safeModel}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature, maxOutputTokens, topP: 0.95 },
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

async function signagePushHandler(req, env) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const { kind, src, title, mime, base64, target } = body;
  if (!kind || !['image', 'video', 'audio', 'text'].includes(kind)) return json({ error: 'bad-kind' }, { status: 400 });
  if (!src && !base64) return json({ error: 'missing-src-or-base64' }, { status: 400 });
  if (base64 && base64.length > 25 * 1024 * 1024) return json({ error: 'too-big', max_b64: 25 * 1024 * 1024 }, { status: 413 });

  // Targeting por pantalla (opcional): si viene `target`, el item solo lo verá
  // esa pantalla (vía /signage/feed?screen=). Sin target = broadcast a todas.
  const tgt = target ? String(target).slice(0, 60) : null;
  if (tgt && !/^[a-z0-9_-]+$/i.test(tgt)) return json({ error: 'bad-target' }, { status: 400 });

  const ts = Date.now();
  const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const item = {
    id, ts, kind,
    title: (title || '').slice(0, 200),
    src: src || null,
    mime: mime || null,
    hasBase64: !!base64,
    acked_at: null,
    screen: null,
    target: tgt,
  };
  if (base64) {
    await env.STOCK_BUCKET.put(`${SIGNAGE_ASSET_PREFIX}${id}`, b64ToBytes(base64), {
      httpMetadata: { contentType: mime || 'application/octet-stream', cacheControl: 'public, max-age=86400' },
    });
  }
  const idx = await signageReadIndex(env);
  idx.unshift(item);
  await signageWriteIndex(env, idx.slice(0, SIGNAGE_MAX_ITEMS));

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
                    prev.role !== data.role || prev.version !== data.version;
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
// la descarga en el proxy del Mac Mini (/admira/tube/import-to-stock). El proxy
// descarga con yt-dlp y publica en /stock/publish, que ya notifica el resultado.
// El token del bot nunca sale del worker.
const ADMIRA_TUBE_BASE_DEFAULT = 'https://macmini.tail48b61c.ts.net/admira';
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
  if (env.TELEGRAM_CHAT_ID && chatId !== String(env.TELEGRAM_CHAT_ID)) return json({ ok: true }); // solo el chat autorizado
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return json({ ok: true });
  const m = text.match(/https?:\/\/[^\s]+/i);
  if (!m) {
    ctx.waitUntil(tgSend(env, chatId, '📥 Envíame una <b>URL</b> (YouTube, Vimeo, X, TikTok, Instagram, LinkedIn) y la importo a Stock.\nAñade la palabra <b>audio</b> para bajar solo el mp3.'));
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
  let tags = Array.isArray(body.tags) ? body.tags.map(t => String(t).toLowerCase().slice(0,30)).filter(Boolean).slice(0,3) : null;

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
      const r = await fetch(sourceUrl);
      if (!r.ok) return json({ error: 'sourceUrl-fetch-failed', status: r.status }, { status: 502 });
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
  const publicUrl = `${WORKER_PUBLIC_BASE}/stock/asset/${id}`;

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
    costEst: costEst ? String(costEst).slice(0, 80) : null,
    mime: finalMime,
    ext,
    size: bytes.length,
    thumbnail: thumbnail ? String(thumbnail).slice(0, 500) : null,
    url: publicUrl,
    assetKey,
    fp,
    ph,
    createdAt: new Date(ts).toISOString(),
  };
  await env.STOCK_BUCKET.put(metaKey, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });

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
  const items = filtered.slice(0, limit);
  return json({ items, total: filtered.length });
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
export default {
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
        res = json({ ok: true, hasElevenKey: !!env.ELEVENLABS_KEY, hasXaiKey: !!env.XAI_KEY, hasGcpKey: !!env.GCP_SA_KEY, hasGeminiKey: !!env.GEMINI_API_KEY, hasStockBucket: !!env.STOCK_BUCKET, hasSignageKv: !!env.SIGNAGE_KV });
      } else if (path === '/tts' && req.method === 'POST') {
        res = await ttsHandler(req, env);
      } else if (path === '/xai/image' && req.method === 'POST') {
        res = await xaiImageHandler(req, env);
      } else if (path === '/xai/video' && req.method === 'POST') {
        res = await xaiVideoStartHandler(req, env);
      } else if (path.startsWith('/xai/video/') && req.method === 'GET') {
        const id = path.slice('/xai/video/'.length);
        res = await xaiVideoPollHandler(req, env, id);
      } else if (path === '/lyria/generate' && req.method === 'POST') {
        res = await lyriaHandler(req, env);
      } else if (path === '/llm/lyrics' && req.method === 'POST') {
        res = await geminiHandler(req, env);
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
        res = await signagePushHandler(req, env);
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
      } else if (path === '/stock/recategorize' && req.method === 'POST') {
        res = await stockRecategorizeHandler(req, env);
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
