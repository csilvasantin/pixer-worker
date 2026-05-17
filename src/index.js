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
  'https://ainimation.studio',
  'https://admira.studio',
  'https://www.admira.studio',
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
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
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
  '/stock/list',
  '/stock/publish', // notificado dentro del handler con detalle (motor/tipo/tamaño)
  '/veo/download',
]);
const NOTIFY_SKIP_PREFIX = [
  '/signage/asset/',
  '/signage/ack/',
  '/stock/asset/',
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

// ─── Signage (KV) — bridge Pixer.ai → AdmiraXP ─────────────────────
// Items se guardan como JSON en KV con key item:<ts>. Index en key 'index' (lista de ts).
const SIGNAGE_INDEX = 'signage_index';
const SIGNAGE_MAX_ITEMS = 50;
const SIGNAGE_TTL = 7 * 24 * 3600; // 7 días

async function signagePushHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const { kind, src, title, mime, base64 } = body;
  if (!kind || !['image', 'video', 'audio', 'text'].includes(kind)) return json({ error: 'bad-kind' }, { status: 400 });
  if (!src && !base64) return json({ error: 'missing-src-or-base64' }, { status: 400 });
  // Tamaño máximo 24 MB de payload
  if (base64 && base64.length > 25 * 1024 * 1024) return json({ error: 'too-big', max_b64: 25 * 1024 * 1024 }, { status: 413 });

  const ts = Date.now();
  const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const item = {
    id,
    ts,
    kind,
    title: (title || '').slice(0, 200),
    src: src || null,           // URL externa cuando exista
    mime: mime || null,
    hasBase64: !!base64,
  };
  if (base64) {
    await env.SIGNAGE_KV.put(`asset:${id}`, base64, { expirationTtl: SIGNAGE_TTL });
  }
  await env.SIGNAGE_KV.put(`item:${id}`, JSON.stringify(item), { expirationTtl: SIGNAGE_TTL });

  // Actualiza índice (LIFO, max 50)
  let index = [];
  try { index = JSON.parse(await env.SIGNAGE_KV.get(SIGNAGE_INDEX)) || []; } catch {}
  index.unshift(id);
  if (index.length > SIGNAGE_MAX_ITEMS) index = index.slice(0, SIGNAGE_MAX_ITEMS);
  await env.SIGNAGE_KV.put(SIGNAGE_INDEX, JSON.stringify(index));

  return json({ ok: true, id, url: `https://pixer-eleven.csilvasantin.workers.dev/signage/asset/${id}` });
}

async function signageFeedHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10)));
  let index = [];
  try { index = JSON.parse(await env.SIGNAGE_KV.get(SIGNAGE_INDEX)) || []; } catch {}
  const ids = index.slice(0, limit);
  const items = await Promise.all(ids.map(async id => {
    try {
      const raw = await env.SIGNAGE_KV.get(`item:${id}`);
      if (!raw) return null;
      const item = JSON.parse(raw);
      // Si tiene base64 expone URL del worker, si no, src directa
      if (item.hasBase64) item.url = `https://pixer-eleven.csilvasantin.workers.dev/signage/asset/${id}`;
      else item.url = item.src;
      return item;
    } catch { return null; }
  }));
  return json({ items: items.filter(Boolean) });
}

async function signageAssetHandler(req, env, id) {
  if (!env.SIGNAGE_KV) return new Response('kv-not-bound', { status: 500 });
  if (!/^[A-Za-z0-9-]+$/.test(id)) return new Response('bad-id', { status: 400 });
  const itemRaw = await env.SIGNAGE_KV.get(`item:${id}`);
  if (!itemRaw) return new Response('not-found', { status: 404 });
  const item = JSON.parse(itemRaw);
  const b64 = await env.SIGNAGE_KV.get(`asset:${id}`);
  if (!b64) return new Response('asset-gone', { status: 404 });
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Response(bin, {
    status: 200,
    headers: { 'Content-Type': item.mime || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' },
  });
}

// Heartbeat: cada signage.html abierto pinga periódicamente para que sepamos qué pantallas están vivas.
const SCREENS_INDEX = 'signage_screens_index';
const SCREEN_TTL = 5 * 60; // 5 min sin pings → considera la pantalla muerta

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
    await env.SIGNAGE_KV.put(`screen:${screen}`, JSON.stringify(data), { expirationTtl: SCREEN_TTL });
    let index = [];
    try { index = JSON.parse(await env.SIGNAGE_KV.get(SCREENS_INDEX)) || []; } catch {}
    if (!index.includes(screen)) {
      index.push(screen);
      if (index.length > 100) index = index.slice(-100);
      await env.SIGNAGE_KV.put(SCREENS_INDEX, JSON.stringify(index));
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
      data.online = (now - data.last_seen) < 30000; // 30s = online, más = stale
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
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  if (!/^[A-Za-z0-9-]+$/.test(id)) return json({ error: 'bad-id' }, { status: 400 });
  const raw = await env.SIGNAGE_KV.get(`item:${id}`);
  if (!raw) return json({ error: 'not-found' }, { status: 404 });
  const item = JSON.parse(raw);
  item.acked_at = Date.now();
  let body = {};
  try { body = await req.json(); } catch {}
  if (body.screen) item.screen = String(body.screen).slice(0, 60);
  await env.SIGNAGE_KV.put(`item:${id}`, JSON.stringify(item), { expirationTtl: SIGNAGE_TTL });
  return json({ ok: true, id, acked_at: item.acked_at, screen: item.screen || null });
}

async function signageClearHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let index = [];
  try { index = JSON.parse(await env.SIGNAGE_KV.get(SIGNAGE_INDEX)) || []; } catch {}
  await Promise.all(index.flatMap(id => [
    env.SIGNAGE_KV.delete(`item:${id}`),
    env.SIGNAGE_KV.delete(`asset:${id}`),
  ]));
  await env.SIGNAGE_KV.delete(SIGNAGE_INDEX);
  return json({ ok: true, cleared: index.length });
}

// ─── Stock público (R2-only, sin KV) ───────────────────────────────
// Cada asset se guarda como 2 objetos en R2:
//   stock/{id}/asset.{ext} — el blob
//   stock/{id}/meta.json   — metadata (type, motor, prompt, costEst, mime,
//                            size, thumbnail, url, createdAt)
// Listado: R2.list({prefix: 'stock/'}) + filtro por sufijo /meta.json.
// Sin KV → sin límite de 1000 writes/día en Workers Free.
const STOCK_TYPES = ['audio', 'music', 'image', 'video'];
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
  const { type, motor, prompt, costEst, mime, base64, sourceUrl, thumbnail } = body;

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

  const meta = {
    id,
    type,
    motor: String(motor).slice(0, 80),
    prompt: String(prompt || '').slice(0, 1000),
    costEst: costEst ? String(costEst).slice(0, 80) : null,
    mime: finalMime,
    ext,
    size: bytes.length,
    thumbnail: thumbnail ? String(thumbnail).slice(0, 500) : null,
    url: publicUrl,
    assetKey,
    createdAt: new Date(ts).toISOString(),
  };
  await env.STOCK_BUCKET.put(metaKey, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });

  // Notificación rica: motor / tipo / tamaño / URL / snippet del prompt
  const mb = (bytes.length / 1024 / 1024).toFixed(2);
  const promptSnip = meta.prompt ? `\n💬 <i>${escHtml(meta.prompt.slice(0, 140))}${meta.prompt.length > 140 ? '…' : ''}</i>` : '';
  const text = `📦 <b>STOCK PUBLISH</b> · ${escHtml(meta.type)} · <code>${escHtml(meta.motor)}</code>\n` +
               `· ${mb} MB · ${escHtml(meta.mime)}\n` +
               `· <a href="${escHtml(publicUrl)}">ver asset</a>${promptSnip}`;
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
      } else if (path === '/signage/clear' && req.method === 'POST') {
        res = await signageClearHandler(req, env);
      } else if (path.startsWith('/signage/ack/') && req.method === 'POST') {
        const id = path.slice('/signage/ack/'.length);
        res = await signageAckHandler(req, env, id);
      } else if (path === '/signage/heartbeat' && req.method === 'POST') {
        res = await signageHeartbeatHandler(req, env);
      } else if (path === '/signage/screens' && req.method === 'GET') {
        res = await signageScreensHandler(req, env);
      } else if (path === '/stock/publish' && req.method === 'POST') {
        res = await stockPublishHandler(req, env, ctx);
      } else if (path === '/stock/list' && req.method === 'GET') {
        res = await stockListHandler(req, env, url);
      } else if (path.startsWith('/stock/asset/') && req.method === 'GET') {
        const id = path.slice('/stock/asset/'.length);
        res = await stockAssetHandler(req, env, id);
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
