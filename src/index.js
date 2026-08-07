import {
  classifyHttpNotification,
  flushNotificationAggregates,
  notificationSourceClass,
  recordNotificationAggregate,
  safeSourceFingerprint,
} from './notify-policy.mjs';

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
  'http://clearchannel.tv',
  'https://clearchannel.tv',
  'http://www.clearchannel.tv',
  'https://www.clearchannel.tv',
  'https://admira.app',
  'https://www.admira.app',
  'https://admira.live',
  'https://www.admira.live',
  'https://admira.tv',
  'https://www.admira.tv',
  'https://admiranext.com',
  'https://www.admiranext.com',
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
  // TELEGRAM_CHAT_ID pertenece al bot operativo AdmiraXP. No usarlo como
  // fallback de AgoraMatrix o los agentes acaban escribiendo en el chat errado.
  return env.AGORA_TG_CHAT_ID || Array.from(AGORA_FALLBACK_CHAT_IDS)[0] || null;
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
  if (p) {
    const identity = AGORA_TOKEN_IDENTITIES[p];
    const stored = await agoraKvGet(env, 'agora:config', null);
    const token = stored && stored.config && stored.config.bots &&
      stored.config.bots[identity] && stored.config.bots[identity].token;
    if (token) return token;
  }
  // TELEGRAM_BOT_TOKEN es @AdmiraXPBot. No usarlo para AgoraMatrix: si falta
  // el token propio del agente, preferimos no responder antes que hablar como
  // el bot operativo equivocado.
  return env.AGORA_TELEGRAM_BOT_TOKEN || null;
}

// Diagnóstico: GET /agora/tg-test?key=<GRID_KEY>&persona=MORFEO → intenta enviar
// al grupo AgoraMatrix con el bot de esa persona y devuelve la respuesta CRUDA
// de Telegram (ok / error_code / description) SIN exponer el token. Sirve para
// saber por qué un bot no escribe (no está en el grupo, token mal, chat mal).
async function agoraTgTestHandler(req, env, url) {
  if (!agoraAuth(env, url.searchParams.get('key'))) return json({ error: 'unauthorized' }, { status: 401 });
  const persona = (url.searchParams.get('persona') || 'MORFEO').toUpperCase().replace(/[^A-Z]/g, '');
  const chatId = await agoraTgChatId(env);
  const token = await agoraBotTokenFor(env, persona);
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
  '/grok/latest',      // variante legacy sin extension: JSON estable, sin spam
  '/grok/agent-ack',   // ACK legacy de agentes Grok/Cypher: housekeeping frecuente
  '/signage/heartbeat',
  '/signage/feed',
  '/signage/push', // notificado dentro del handler con asset/origen/target
  '/signage/screens',
  '/signage/now', // puntero "ahora reproduciendo" por pantalla — POST muy frecuente
  '/signage/shot', // captura real de pantalla: POST ~1/8s por player + GET polling del panel — no spamear
  '/emit', // proof-of-play de admira.tv: POST cada ~12s por pantalla — no spamear Telegram
  '/emit/range', // lectura del informe (GET) — no notificar
  '/screen/cache', // estado de pre-descarga del player (pseudo-streaming): POST cada ~30s por pantalla — no spamear Telegram
  '/grid/playlist', // lista del player que acompaña a /screen/cache — polling frecuente
  '/grid/tag-sync', // sincronización automática Pixeria→slots municipales/publicitarios
  '/audience', // cámara del gemelo → audiencia: POST cada ~20s — no spamear Telegram
  '/audience/range', // lectura del informe (GET) — no notificar
  '/stock/list',
  '/rtb/decide', // subasta programática: POST muy frecuente (una por impresión) — no spamear Telegram
  '/rtb/feed',   // lectura del feed de decisiones (GET) — polling del reproductor
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
  '/megafonia/', // push (aviso) + next (polling del gemelo) + audio — no spamear Telegram
  '/hilomusical/', // next (polling del gemelo) — no spamear (el push notifica vía /stock/publish)
  '/segmentado/', // generación de variante segmentada — /stock/publish notifica el asset creado
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

function notificationRouteIsSkipped(path) {
  return NOTIFY_SKIP_EXACT.has(path) || NOTIFY_SKIP_PREFIX.some(p => path.startsWith(p));
}

function notificationSafePath(path) {
  const segments = String(path || '/').split('/').map(segment => {
    if (!segment) return segment;
    if (/(?:token|secret|password|authorization|api[_-]?key)[=_:-]/i.test(segment)) return ':redacted';
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(segment)) return ':redacted';
    if (/^[a-f0-9]{32,}$/i.test(segment) || /^[A-Za-z0-9_-]{49,}$/.test(segment)) return ':id';
    return segment;
  });
  return segments.join('/').slice(0, 220) || '/';
}

async function responseErrorCode(res) {
  if (!res || res.status < 400 || res.status >= 500) return '';
  try {
    const data = await res.clone().json();
    const code = data && typeof data.error === 'string' ? data.error : '';
    return /^[a-z0-9_-]{1,80}$/i.test(code) ? code : '';
  } catch { return ''; }
}

function automaticHttpMessage(req, path, status, ms) {
  const emoji = status >= 500 ? '🚨' : status >= 400 ? '⚠️' : '✅';
  return `${emoji} <b>${escHtml(req.method)} ${escHtml(notificationSafePath(path))}</b>\n` +
    `· ${status} · ${ms}ms\n` +
    `· origen seguro <code>${escHtml(notificationSourceClass(req))}</code>`;
}

async function handleAutomaticHttpNotification(ctx, env, req, path, res, ms) {
  const status = res.status;
  const errorCode = await responseErrorCode(res);
  const policy = classifyHttpNotification({
    path,
    method: req.method,
    status,
    errorCode,
    skip: notificationRouteIsSkipped(path),
  });
  if (policy.action === 'skip') return;
  if (policy.action === 'immediate') {
    notify(ctx, env, automaticHttpMessage(req, path, status, ms));
    return;
  }

  const aggregate = async () => {
    try {
      const identity = await safeSourceFingerprint(req, path);
      const safePath = notificationSafePath(path);
      const result = await recordNotificationAggregate(env.SIGNAGE_KV, {
        kind: policy.kind,
        path: safePath,
        source: identity.source,
        fingerprint: identity.fingerprint,
      });
      if (result.summary) await sendTelegram(env, result.summary);
      // Fail-closed para no reabrir el spam si KV falta. El healthz expone la
      // degradacion y el log no contiene body, key, IP, Origin ni User-Agent.
      if (!result.available) console.warn(`notification-aggregator-unavailable kind=${policy.kind} path=${safePath}`);
    } catch {
      console.warn(`notification-aggregator-failed kind=${policy.kind} path=${notificationSafePath(path)}`);
    }
  };
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(aggregate());
  else await aggregate();
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

async function grokAgentAckHandler(req) {
  let body = {};
  try { body = await req.json(); } catch {}
  return json({
    ok: true,
    source: 'pixer-worker',
    route: '/grok/agent-ack',
    message: 'ACK legacy recibido. No hay accion pendiente en este worker.',
    agent: cleanMetaText(body.agent || body.from || body.persona || '', 80) || null,
    task_id: cleanMetaText(body.task_id || body.taskId || body.id || '', 120) || null,
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

// ─── ElevenLabs Dubbing API ────────────────────────────────
// Proxy privado para trabajos de doblaje profesional. Mantiene ELEVENLABS_KEY
// exclusivamente en el Worker y exige la GRID_KEY en X-Grid-Key para evitar
// que un endpoint de coste variable quede expuesto públicamente.
function dubbingAuthOk(req, env) {
  return !!env.GRID_KEY && req.headers.get('X-Grid-Key') === String(env.GRID_KEY);
}

async function dubbingProxy(req, env, upstreamPath, accept = 'application/json') {
  if (!dubbingAuthOk(req, env)) {
    return json({ error: env.GRID_KEY ? 'unauthorized' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 401 : 503 });
  }
  if (!env.ELEVENLABS_KEY) return json({ error: 'server-missing-key', service: 'elevenlabs' }, { status: 500 });

  const headers = new Headers({
    'xi-api-key': env.ELEVENLABS_KEY,
    'Accept': accept,
  });
  const contentType = req.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);

  const upstream = await fetch(`https://api.elevenlabs.io/v1${upstreamPath}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
  });
  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  const upstreamType = upstream.headers.get('Content-Type');
  const disposition = upstream.headers.get('Content-Disposition');
  if (upstreamType) responseHeaders.set('Content-Type', upstreamType);
  if (disposition) responseHeaders.set('Content-Disposition', disposition);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

// ─── Megafonía: enlace pixeria → gemelo (aviso de audio TTS multilingüe) ─────
// pixeria genera el aviso (POST /megafonia/push con texto + voz + idioma), el
// worker lo sintetiza con ElevenLabs (eleven_multilingual_v2 → cualquier idioma),
// lo guarda en R2 y lo encola por tienda; el gemelo (admira-xp) sondea
// /megafonia/next?store= y lo reproduce bajando la música (ducking).
const MEGAFONIA_PREFIX = 'megafonia/';
const MEGAFONIA_Q = (store) => 'megafonia:q:' + String(store || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
async function megafoniaPushHandler(req, env) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  if (!env.ELEVENLABS_KEY) return json({ error: 'server-missing-key', service: 'elevenlabs' }, { status: 500 });
  let body; try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const store = String(body.store || body.circuit || body.loc || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 60) || 'default';
  const text = String(body.text || '').trim();
  if (!text) return json({ error: 'missing-text' }, { status: 400 });
  if (text.length > 800) return json({ error: 'text-too-long', max: 800 }, { status: 400 });
  const voice_id = String(body.voice_id || 'EXAVITQu4vr4xnSDxMaL').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  const model_id = String(body.model_id || 'eleven_multilingual_v2').slice(0, 40);
  const lang = String(body.lang || '').slice(0, 8);
  // 1) sintetiza con ElevenLabs (multilingüe: el idioma lo infiere del texto)
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id, voice_settings: body.voice_settings || { stability: 0.5, similarity_boost: 0.75 } }),
  });
  if (!r.ok) { const e = await r.text(); return json({ error: 'elevenlabs-failed', status: r.status, detail: e.slice(0, 300) }, { status: r.status }); }
  const buf = await r.arrayBuffer();
  // 2) guarda el mp3 en R2
  const id = 'm' + Date.now().toString(36) + '-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.floor(Math.random() * 1e9).toString(36));
  try { await env.STOCK_BUCKET.put(MEGAFONIA_PREFIX + id + '.mp3', buf, { httpMetadata: { contentType: 'audio/mpeg' } }); }
  catch (e) { return json({ error: 'r2-put-failed', detail: String(e).slice(0, 120) }, { status: 502 }); }
  const url = `${new URL(req.url).origin}/megafonia/audio/${id}`;
  // 3) encola por tienda (últimos 20, TTL 6h)
  const qkey = MEGAFONIA_Q(store);
  let q = []; try { q = JSON.parse(await env.SIGNAGE_KV.get(qkey)) || []; } catch {}
  const entry = { id, url, text: text.slice(0, 200), ts: Date.now(), lang, voice: voice_id };
  q.push(entry); if (q.length > 20) q = q.slice(-20);
  try { await env.SIGNAGE_KV.put(qkey, JSON.stringify(q), { expirationTtl: 60 * 60 * 6 }); } catch {}
  return json({ ok: true, ...entry, store });
}
async function megafoniaNextHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const store = String(url.searchParams.get('store') || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  let q = []; try { q = JSON.parse(await env.SIGNAGE_KV.get(MEGAFONIA_Q(store))) || []; } catch {}
  const pending = q.filter(e => e && e.ts > since);
  return json({ ok: true, store, now: Date.now(), pending });
}
async function megafoniaAudioHandler(req, env, id) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  if (!/^[a-z0-9-]+$/i.test(id)) return json({ error: 'bad-id' }, { status: 400 });
  const o = await env.STOCK_BUCKET.get(MEGAFONIA_PREFIX + id + '.mp3');
  if (!o) return json({ error: 'not-found' }, { status: 404 });
  return new Response(o.body, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
}

// ─── Hilo musical: enlace pixeria → gemelo (canción → Stock + hilo del Xpacio) ─
// pixeria genera/aporta una canción; el worker la PUBLICA EN EL STOCK (type=music,
// etiquetada 'hilo-<store>' → también enrutable por metatag y vendible como
// inventario) y la encola para que el gemelo la ponga en su hilo musical al vuelo.
const HILO_Q = (store) => 'hilomusical:q:' + String(store || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
async function hiloMusicalPushHandler(req, env, ctx) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let body; try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const store = String(body.store || body.circuit || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 60) || 'default';
  const title = String(body.title || 'Canción').slice(0, 80);
  const motor = String(body.motor || 'suno').slice(0, 40);
  if (!body.sourceUrl && !body.base64) return json({ error: 'missing-source', hint: 'sourceUrl o base64' }, { status: 400 });
  // 1) PUBLICA AL STOCK como música, etiquetada con el hilo del punto.
  const storeTag = ('hilo-' + store).toLowerCase().slice(0, 30);
  const tags = (Array.isArray(body.tags) ? body.tags.map(t => String(t).toLowerCase()).slice(0, 2) : []).concat(storeTag).slice(0, 3);
  const pubReq = new Request(new URL('/stock/publish', req.url).toString(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'music', motor, title, tags,
      base64: body.base64 || undefined, sourceUrl: body.sourceUrl || undefined,
      mime: body.mime || 'audio/mpeg', prompt: body.prompt || undefined,
    }),
  });
  const pr = await stockPublishHandler(pubReq, env, ctx);
  const pd = await pr.json().catch(() => ({}));
  if (!(pr.status < 300) || !pd.id) return json({ error: 'stock-publish-failed', detail: pd.error || ('HTTP ' + pr.status) }, { status: 502 });
  // 2) ENCOLA para el hilo del gemelo (reproducción al vuelo).
  const entry = { id: pd.id, url: pd.url, title, ts: Date.now(), tag: storeTag, motor };
  const qkey = HILO_Q(store);
  let q = []; try { q = JSON.parse(await env.SIGNAGE_KV.get(qkey)) || []; } catch {}
  q.push(entry); if (q.length > 30) q = q.slice(-30);
  try { await env.SIGNAGE_KV.put(qkey, JSON.stringify(q), { expirationTtl: 60 * 60 * 24 }); } catch {}
  return json({ ok: true, ...entry, store });
}
async function hiloMusicalNextHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const store = String(url.searchParams.get('store') || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  let q = []; try { q = JSON.parse(await env.SIGNAGE_KV.get(HILO_Q(store))) || []; } catch {}
  return json({ ok: true, store, now: Date.now(), pending: q.filter(e => e && e.ts > since), playlist: q.slice(-12) });
}

// ─── Contenido segmentado: creación AUTOMÁTICA de una variante por segmento ───
// pixeria pide una variante para un segmento (audiencia f/m + edad); el worker la
// GENERA con Imagen 4.0 con un prompt adaptado al segmento y la PUBLICA en el Stock
// con audience + segmentation + tag `seg-<aud>-<edad>`. El routing por cámara que ya
// vive en canal.html (matchesSeg) y en el gemelo (XPLStock.pick) la emite sola cuando
// la cámara detecta ese público. Cierra el bucle "la pantalla te ve → contenido a medida".
const SEG_AUD_DESC = { f: 'una mujer', m: 'un hombre', all: 'público general' };
const SEG_AGE_DESC = { nino: 'de público infantil', joven: 'joven (13-30 años)', adulto: 'adulto (30-55)', senior: 'sénior (55-70)', vejez: 'de tercera edad (70+)' };
async function segmentadoGenerateHandler(req, env, ctx) {
  if (!env.GEMINI_API_KEY) return json({ error: 'server-missing-key', service: 'gemini' }, { status: 500 });
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  let body; try { body = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const store = String(body.store || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 60) || 'default';
  const brief = String(body.prompt || body.brief || '').trim();
  if (!brief) return json({ error: 'missing-prompt' }, { status: 400 });
  const audience = ['f', 'm', 'all'].includes(body.audience) ? body.audience : 'all';
  const age = ['nino', 'joven', 'adulto', 'senior', 'vejez'].includes(body.age) ? body.age : '';
  const category = ['atraer', 'producto', 'promo', 'marca'].includes(body.category) ? body.category : 'promo';
  const aspectRatio = ['1:1', '9:16', '16:9', '3:4', '4:3'].includes(body.aspectRatio) ? body.aspectRatio : '9:16';
  // 1) prompt adaptado al segmento
  const audD = SEG_AUD_DESC[audience], ageD = age ? (' ' + SEG_AGE_DESC[age]) : '';
  const segPrompt = `${brief}. Cartel publicitario vertical de digital signage para tienda, pensado para atraer a ${audD}${ageD}. Estética premium y actual, un único mensaje claro, mucho espacio negativo, composición limpia, sin texto ilegible.`;
  // 2) genera con Imagen 4.0
  const gr = await fetch('https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict', {
    method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt: segPrompt }], parameters: { sampleCount: 1, aspectRatio, personGeneration: 'allow_adult' } }),
  });
  const gd = await gr.json().catch(() => ({}));
  const pred = gd && gd.predictions && gd.predictions[0];
  const b64 = pred && (pred.bytesBase64Encoded || pred.image);
  if (!gr.ok || !b64) return json({ error: 'imagen-failed', status: gr.status, detail: String((gd && gd.error && gd.error.message) || 'sin imagen').slice(0, 200) }, { status: 502 });
  // 3) publica al Stock con segmentación + tag de segmento
  const segTag = ('seg-' + audience + (age ? '-' + age : '')).toLowerCase().slice(0, 30);
  const pubReq = new Request(new URL('/stock/publish', req.url).toString(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'image', motor: 'Imagen 4.0 · segmentado', base64: b64, mime: 'image/png',
      title: brief.slice(0, 46) + ' · ' + audience + (age ? '-' + age : ''),
      audience, category, tags: [segTag, 'seg-' + store].slice(0, 3),
      segmentation: { audiences: [audience], ageBuckets: age ? [age] : [], timeSlots: [], typologies: ['interior'] },
      prompt: segPrompt,
    }),
  });
  const pr = await stockPublishHandler(pubReq, env, ctx);
  const pd = await pr.json().catch(() => ({}));
  if (!(pr.status < 300) || !pd.id) return json({ error: 'stock-publish-failed', detail: pd.error || ('HTTP ' + pr.status) }, { status: 502 });
  return json({ ok: true, id: pd.id, url: pd.url, audience, age, category, segTag, store });
}

// TTS GRATIS (sin key) vía Google Translate TTS → MP3. Da soporte al motor
// /da/* → proxy server-side a omnipublicity-api (el cerebro del DigitalAvatar.ai
// y el Metahuman del gemelo). Los ISP españoles bloquean intermitentemente
// 188.114.96.0/22 (workers.dev) → llamar a omnipublicity directo desde el
// navegador de Carlos falla ("bloqueo ES"). pixer-eleven SÍ es alcanzable (lo usa
// pixeria a diario), y la llamada worker→worker viaja por la red de Cloudflare,
// no por el ISP. Reenvía método+cuerpo y devuelve la respuesta con ACAO:* para que
// digitalavatar.ai / carlossilva.info / xpaceos.com puedan leerla.
const DA_UPSTREAM = 'https://omnipublicity-api.csilvasantin.workers.dev';
async function daProxyHandler(req, env) {
  const u = new URL(req.url);
  const sub = u.pathname.slice('/da'.length) || '/';   // '/da/metahuman/ask' → '/metahuman/ask'
  const target = DA_UPSTREAM + sub + u.search;
  const init = { method: req.method, headers: { 'Content-Type': req.headers.get('Content-Type') || 'application/json' } };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
  let up;
  // Service binding (env.OMNI) → la subpetición viaja por la malla interna de
  // Cloudflare y evita el error 1042 de fetch worker→worker en el mismo workers.dev.
  // Si por lo que sea no está el binding, cae al fetch directo (puede dar 1042).
  try { up = env && env.OMNI ? await env.OMNI.fetch(new Request(target, init)) : await fetch(target, init); }
  catch (e) { return json({ ok: false, error: 'da-upstream-failed', detail: String(e).slice(0, 160) }, { status: 502 }); }
  const headers = new Headers();
  const ct = up.headers.get('Content-Type'); if (ct) headers.set('Content-Type', ct);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'no-store');
  return new Response(await up.arrayBuffer(), { status: up.status, headers });
}

// ── Passthrough /locations* → omnipublicity-api (tarea #4) ─────────
// El registro de sitios (alta.html) y la vista de flota (cms.html) hablan con
// omnipublicity-api.csilvasantin.workers.dev/locations*, que Cloudflare/el ISP
// BLOQUEA a las máquinas españolas. Este proxy lo re-sirve por api.admira.store
// (mismo dominio que el resto del backbone /grid, no bloqueado). Reenvía método,
// query, headers relevantes y body tal cual, y devuelve la respuesta sin tocar.
// Usa el service binding env.OMNI (misma malla interna que /da/*) para esquivar
// el error 1042 worker→worker; si no está, cae a fetch directo. La CORS la pone
// el wrapper de fetch() (corsHeaders, por whitelist) igual que el resto.
async function locationsProxyHandler(req, env) {
  const u = new URL(req.url);
  const target = DA_UPSTREAM + u.pathname + u.search;   // p.ej. /locations/register?selfreg=1
  const init = { method: req.method, headers: {} };
  const ct = req.headers.get('Content-Type'); if (ct) init.headers['Content-Type'] = ct;
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
  let up;
  try { up = (env && env.OMNI) ? await env.OMNI.fetch(new Request(target, init)) : await fetch(target, init); }
  catch (e) { return json({ ok: false, error: 'locations-upstream-failed', detail: String(e).slice(0, 160) }, { status: 502 }); }
  const headers = new Headers();
  const upct = up.headers.get('Content-Type'); if (upct) headers.set('Content-Type', upct);
  headers.set('Cache-Control', 'no-store');
  return new Response(await up.arrayBuffer(), { status: up.status, headers });
}

// ── Resumen diario del Xpacio (calendario histórico del gemelo) ────
// El gemelo guarda al cerrar cada día sus KPIs reales en KV (day:<loc>:<YYYYMMDD>);
// ─── Newsletter Pixeria (captura de emails del radar) ──────────────────────
// Guarda en SIGNAGE_KV: `newsletter:sub:<email>` = registro; `newsletter:count`
// = entero (prueba social). Lo consume pixeria.com/assets/newsletter.js.
function newsletterValidEmail(e) {
  return typeof e === 'string' && e.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
async function newsletterSubscribeHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const email = String(b.email || '').trim().toLowerCase();
  if (!newsletterValidEmail(email)) return json({ error: 'bad-email' }, { status: 400 });
  const key = `newsletter:sub:${email}`;
  const existing = await env.SIGNAGE_KV.get(key);
  if (existing) return json({ ok: true, status: 'already' });
  const rec = {
    email,
    source: String(b.source || 'pixeria').slice(0, 40),
    ref: String(b.ref || '').slice(0, 120),
    ts: Date.now(),
  };
  try { await env.SIGNAGE_KV.put(key, JSON.stringify(rec)); }
  catch (e) { return json({ error: 'kv-put-failed', detail: String(e).slice(0, 120) }, { status: 502 }); }
  // Contador best-effort (KV no es atómico; suficiente para la prueba social).
  try {
    const n = parseInt(await env.SIGNAGE_KV.get('newsletter:count'), 10) || 0;
    await env.SIGNAGE_KV.put('newsletter:count', String(n + 1));
  } catch { /* no bloquea el alta */ }
  return json({ ok: true, status: 'subscribed' });
}
async function newsletterCountHandler(req, env) {
  let n = 0;
  try { n = parseInt(await env.SIGNAGE_KV.get('newsletter:count'), 10) || 0; } catch { /* 0 */ }
  return json({ count: n });
}

// el calendario los lee por rango para mostrar datos reales en vez de estimación.
async function daySaveHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const loc = String(b.loc || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  const date = String(b.date || '').replace(/[^0-9]/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(date)) return json({ error: 'bad-date', expected: 'YYYYMMDD' }, { status: 400 });
  const s = (b.summary && typeof b.summary === 'object') ? b.summary : null;
  if (!s) return json({ error: 'missing-summary' }, { status: 400 });
  const rec = Object.assign({}, s, { date, loc, real: true, savedAt: Date.now() });
  try { await env.SIGNAGE_KV.put(`day:${loc}:${date}`, JSON.stringify(rec).slice(0, 24000)); }
  catch (e) { return json({ error: 'kv-put-failed', detail: String(e).slice(0, 120) }, { status: 502 }); }
  return json({ ok: true, date, loc });
}
async function dayDeleteHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const loc = String(b.loc || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const date = String(b.date || '').replace(/[^0-9]/g, '').slice(0, 8);
  if (!loc || !/^\d{8}$/.test(date)) return json({ error: 'missing-loc-or-date' }, { status: 400 });
  try { await env.SIGNAGE_KV.delete(`day:${loc}:${date}`); } catch (e) { return json({ error: 'kv-delete-failed' }, { status: 502 }); }
  return json({ ok: true, deleted: `day:${loc}:${date}` });
}
async function dayRangeHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const loc = String(url.searchParams.get('loc') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  const from = String(url.searchParams.get('from') || '').replace(/[^0-9]/g, '').slice(0, 8);
  const to = String(url.searchParams.get('to') || '').replace(/[^0-9]/g, '').slice(0, 8);
  const prefix = `day:${loc}:`;
  const days = {}; let cursor, n = 0;
  try {
    do {
      const list = await env.SIGNAGE_KV.list({ prefix, cursor, limit: 1000 });
      for (const k of list.keys) {
        const d = k.name.slice(prefix.length);
        if (from && d < from) continue;
        if (to && d > to) continue;
        const v = await env.SIGNAGE_KV.get(k.name);
        if (v) { try { days[d] = JSON.parse(v); } catch {} }
        if (++n > 400) break;
      }
      cursor = list.list_complete ? null : list.cursor;
    } while (cursor && n <= 400);
  } catch (e) { return json({ error: 'kv-list-failed', detail: String(e).slice(0, 120) }, { status: 502 }); }
  return json({ ok: true, loc, days });
}

// ── EMISIÓN (proof-of-play) — admira.tv registra qué emite cada pantalla ──────
// El canal (admira.tv/canal.html) manda el ACUMULADO del día POR PANTALLA. Es
// cumulativo (last-write-wins por pantalla) → no hay carreras de incremento.
// clearchannel.tv lo lee por circuito (/emit/range) para el "Informe de emisión".
async function emitSaveHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const loc = String(b.loc || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  const screen = (String(b.screen || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48)) || (loc + '-led');
  const date = String(b.date || '').replace(/[^0-9]/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(date)) return json({ error: 'bad-date', expected: 'YYYYMMDD' }, { status: 400 });
  const num = v => { const n = +v; return isFinite(n) && n >= 0 ? Math.round(n) : 0; };
  const cleanMap = m => { const o = {}; if (m && typeof m === 'object') for (const k of Object.keys(m).slice(0, 40)) o[String(k).slice(0, 24)] = num(m[k]); return o; };
  const assets = {};
  if (b.assets && typeof b.assets === 'object') {
    for (const id of Object.keys(b.assets).slice(0, 300)) {
      const a = b.assets[id] || {};
      assets[String(id).slice(0, 80)] = {
        n: num(a.n), type: String(a.type || '').slice(0, 24),
        seg: a.seg ? String(a.seg).slice(0, 24) : null,
        title: String(a.title || '').slice(0, 80),
        num: a.num != null ? num(a.num) : null,
        secs: num(a.secs), last: num(a.last) || Date.now(),
      };
    }
  }
  const rec = {
    date, loc, screen, totalPlays: num(b.totalPlays), totalSecs: num(b.totalSecs),
    byType: cleanMap(b.byType), bySeg: cleanMap(b.bySeg), assets, real: true, savedAt: Date.now(),
  };
  try { await env.SIGNAGE_KV.put(`emit:${loc}:${screen}:${date}`, JSON.stringify(rec).slice(0, 24000)); }
  catch (e) { return json({ error: 'kv-put-failed', detail: String(e).slice(0, 120) }, { status: 502 }); }
  return json({ ok: true, loc, screen, date });
}
async function emitRangeHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const loc = String(url.searchParams.get('loc') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  const from = String(url.searchParams.get('from') || '').replace(/[^0-9]/g, '').slice(0, 8);
  const to = String(url.searchParams.get('to') || '').replace(/[^0-9]/g, '').slice(0, 8);
  const prefix = `emit:${loc}:`;
  const screens = {}; let cursor, n = 0;
  try {
    do {
      const list = await env.SIGNAGE_KV.list({ prefix, cursor, limit: 1000 });
      for (const k of list.keys) {
        const rest = k.name.slice(prefix.length);          // <screen>:<date>
        const li = rest.lastIndexOf(':'); if (li < 0) continue;
        const screen = rest.slice(0, li), d = rest.slice(li + 1);
        if (from && d < from) continue;
        if (to && d > to) continue;
        const v = await env.SIGNAGE_KV.get(k.name);
        if (v) { try { (screens[screen] = screens[screen] || {})[d] = JSON.parse(v); } catch {} }
        if (++n > 600) break;
      }
      cursor = list.list_complete ? null : list.cursor;
    } while (cursor && n <= 600);
  } catch (e) { return json({ error: 'kv-list-failed', detail: String(e).slice(0, 120) }, { status: 502 }); }
  return json({ ok: true, loc, screens });
}

// ══════ CALENDARIO DE EMISIÓN · backbone /grid ══════════════════════════════
// Fuente de verdad única de la parrilla por pantalla. La consumen el módulo
// emission-calendar.js (pixeria=public, admira.app/parrilla=sell, xpaceos/control=
// owner) y admira.tv. Contrato: admira-design/EMISSION-CALENDAR.md. KV:
//   grid:cfg:<screen>          config de pantalla (bandas, slots, pixerScreens, política)
//   grid:book:<screen>:<date>  reservas del día [{id,bandId,slots,status,...}]
//   grid:ctrl:<circuit>        política + lista negra del circuito
const GRID_R2_PUBLIC = 'https://pub-bf043a4daa3b43b7a0b769617729d074.r2.dev';
const GRID_DEFAULT_BANDS = [
  { id: 'manana',   label: 'Mañana',   from: '08:00', to: '12:00', capacity: 6 },
  { id: 'mediodia', label: 'Mediodía', from: '12:00', to: '16:00', capacity: 6 },
  { id: 'tarde',    label: 'Tarde',    from: '16:00', to: '20:00', capacity: 6 },
  { id: 'noche',    label: 'Noche',    from: '20:00', to: '23:59', capacity: 6 },
];
function gridScreen(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60); }
function gridCircuit(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40); }
function gridDate(s) { const d = String(s || '').replace(/[^0-9]/g, '').slice(0, 8); return /^\d{8}$/.test(d) ? d : ''; }
function gridFmtDate(ymd) { return ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8); }
function gridShiftDate(ymd, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function gridRid() { try { return crypto.randomUUID().slice(0, 8); } catch (e) { return 'x' + (Date.now() % 1e8).toString(36); } }
function gridKeyOk(env, body) { if (!env.GRID_KEY) return false; return body && String(body.key || '') === String(env.GRID_KEY); }
function gridHhmm(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : 0; }
function gridNow() {
  const d = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '');
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return { ymd, hhmm };
}
function gridCleanCreative(c) {
  if (!c || typeof c !== 'object') return null;
  const type = ['video', 'image', 'audio', 'animation', 'music', 'locucion'].includes(c.type) ? c.type : 'image';
  const url = (typeof c.url === 'string' && /^https?:\/\//.test(c.url)) ? c.url.slice(0, 500) : '';
  if (!url) return null;
  return { type, url, name: String(c.name || '').slice(0, 120) };
}
async function gridGetConfig(env, screen) {
  let c = null; try { c = JSON.parse(await env.SIGNAGE_KV.get('grid:cfg:' + screen) || 'null'); } catch (e) {}
  if (!c) c = { name: screen, circuit: screen.split('-')[0] || screen, policy: 'manual', slotSeconds: 10, pixerScreens: [], bands: GRID_DEFAULT_BANDS };
  c.bands = (Array.isArray(c.bands) && c.bands.length ? c.bands : GRID_DEFAULT_BANDS).map(b => ({ id: String(b.id), label: String(b.label || b.id), from: String(b.from || '00:00'), to: String(b.to || '00:00'), capacity: Math.max(1, +b.capacity || 6) }));
  c.policy = ['inherit', 'manual', 'auto'].includes(c.policy) ? c.policy : 'manual';
  c.slotSeconds = Math.max(1, Math.min(120, +c.slotSeconds || 10));
  c.pixerScreens = Array.isArray(c.pixerScreens) ? c.pixerScreens : [];
  c.circuit = gridCircuit(c.circuit) || (screen.split('-')[0] || screen);
  c.name = c.name || screen;
  return c;
}
async function gridGetBookings(env, screen, date) { let b = null; try { b = JSON.parse(await env.SIGNAGE_KV.get('grid:book:' + screen + ':' + date) || '[]'); } catch (e) {} return Array.isArray(b) ? b : []; }
async function gridPutBookings(env, screen, date, arr) { await env.SIGNAGE_KV.put('grid:book:' + screen + ':' + date, JSON.stringify(arr).slice(0, 120000)); }
async function gridGetControl(env, circuit) {
  let c = null; try { c = JSON.parse(await env.SIGNAGE_KV.get('grid:ctrl:' + circuit) || 'null'); } catch (e) {}
  if (!c) c = { policy: 'manual', blacklist: {} };
  c.policy = ['manual', 'auto'].includes(c.policy) ? c.policy : 'manual';
  c.blacklist = c.blacklist || {};
  for (const k of ['advertisers', 'categories', 'terms']) c.blacklist[k] = Array.isArray(c.blacklist[k]) ? c.blacklist[k] : [];
  return c;
}
function gridBandIsNow(b, nowMin) { let f = gridHhmm(b.from), t = gridHhmm(b.to); if (t <= f) t += 1440; let n = nowMin; if (n < f) n += 1440; return n >= f && n < t; }
function gridSlots(bk) { return Math.max(1, parseInt(bk.slots, 10) || 1); }
function gridComputeDay(config, bookings, date, now) {
  const isToday = date === now.ymd, nowMin = gridHhmm(now.hhmm);
  const bands = config.bands.map(b => {
    const bb = bookings.filter(x => x.bandId === b.id);
    const own = bb.filter(x => x.status === 'own'), paid = bb.filter(x => x.status === 'accepted' || x.status === 'sold'), pending = bb.filter(x => x.status === 'pending');
    const slots = [];
    const push = (x, kind) => { for (let i = 0; i < gridSlots(x); i++) slots.push({ kind, status: kind === 'own' ? 'own' : kind === 'pending' ? 'pending' : 'sold', bookingId: x.id, advertiser: x.advertiser || null, title: x.title || '', category: x.category || null, creative: x.creative || null, playlistId: x.playlistId || null, position: Number.isFinite(x.position) ? x.position : null, lane: x.lane || null, stockId: x.stockId || null, sourceTag: x.sourceTag || null }); };
    // Las parrillas editoriales pueden declarar `position` para conservar un rundown
    // exacto (p.ej. municipal/publicidad alternado). Las reservas antiguas mantienen
    // el comportamiento histórico: primero propio, después vendido y pendiente.
    const sequenced = bb.some(x => x.playlistId && Number.isFinite(x.position));
    if (sequenced) {
      bb.filter(x => x.status === 'own' || x.status === 'accepted' || x.status === 'sold' || x.status === 'pending')
        .slice().sort((a, z) => (Number.isFinite(a.position) ? a.position : 9999) - (Number.isFinite(z.position) ? z.position : 9999) || (+a.createdAt || 0) - (+z.createdAt || 0))
        .forEach(x => push(x, x.status === 'own' ? 'own' : x.status === 'pending' ? 'pending' : 'paid'));
    } else {
      own.forEach(x => push(x, 'own')); paid.forEach(x => push(x, 'paid')); pending.forEach(x => push(x, 'pending'));
    }
    const ownN = own.reduce((s, x) => s + gridSlots(x), 0), paidN = paid.reduce((s, x) => s + gridSlots(x), 0), pendN = pending.reduce((s, x) => s + gridSlots(x), 0);
    const free = Math.max(0, b.capacity - ownN - paidN);
    for (let i = 0; i < free; i++) slots.push({ kind: 'free', status: 'free' });
    return { id: b.id, label: b.label, from: b.from, to: b.to, capacity: b.capacity, own: ownN, paid: paidN, sold: paidN, pending: pendN, free, slots, isNow: isToday && gridBandIsNow(b, nowMin) };
  });
  let totalSlots = 0, ownSlots = 0, paidSlots = 0, pendingSlots = 0, freeSlots = 0, revenue = 0;
  for (const b of bands) { totalSlots += b.capacity; ownSlots += b.own; paidSlots += b.paid; pendingSlots += b.pending; freeSlots += b.free; }
  for (const x of bookings) if (x.status === 'accepted' || x.status === 'sold') revenue += (+x.price || 0) || (+x.cpm || 0) * gridSlots(x);
  const occupancy = totalSlots ? Math.round((ownSlots + paidSlots) / totalSlots * 100) : 0;
  let nowPlaying = null;
  if (isToday) { const cur = bands.find(b => b.isNow); if (cur) { const e = cur.slots.find(s => s.kind === 'own') || cur.slots.find(s => s.kind === 'paid'); nowPlaying = e ? { bandId: cur.id, kind: e.kind, advertiser: e.advertiser, title: e.title, creative: e.creative, bookingId: e.bookingId } : { bandId: cur.id, free: true }; } }
  return {
    config: { name: config.name, circuit: config.circuit, policy: config.policy, slotSeconds: config.slotSeconds, pixerScreens: config.pixerScreens, bands: config.bands },
    bands, pendingOffers: bookings.filter(x => x.status === 'pending'),
    totals: { totalSlots, soldSlots: paidSlots, ownSlots, paidSlots, pendingSlots, freeSlots, occupancy, revenue: Math.round(revenue * 100) / 100, bookings: bookings.filter(x => x.status !== 'rejected').length },
    now: { date: gridFmtDate(now.ymd), hhmm: now.hhmm, isToday }, nowPlaying,
  };
}
async function gridDayHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const screen = gridScreen(url.searchParams.get('screen')); if (!screen) return json({ error: 'missing-screen' }, { status: 400 });
  const now = gridNow(); const date = gridDate(url.searchParams.get('date')) || now.ymd;
  const cfg = await gridGetConfig(env, screen); const bookings = await gridGetBookings(env, screen, date);
  return json(Object.assign({ ok: true, screen, date: gridFmtDate(date) }, gridComputeDay(cfg, bookings, date, now)));
}
// Resumen ligero de ocupación por día para un rango (lo usa el calendario anual del CMS).
// Una sola petición devuelve N días × M pantallas sin el detalle de slots → carga un año
// de un tirado. Solo lectura; CORS abierto como el resto de /grid.
async function gridRangeHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 400 });
  const raw = url.searchParams.get('screens') || url.searchParams.get('screen') || '';
  const screens = raw.split(',').map(s => gridScreen(s.trim())).filter(Boolean);
  if (!screens.length) return json({ error: 'missing-screen' }, { status: 400 });
  const from = gridDate(url.searchParams.get('from')), to = gridDate(url.searchParams.get('to')); // 8 dígitos YYYYMMDD
  if (!from || !to) return json({ error: 'missing-from-to' }, { status: 400 });
  const toISO = s => s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  const d0 = new Date(toISO(from) + 'T00:00:00Z'), d1 = new Date(toISO(to) + 'T00:00:00Z');
  if (isNaN(d0) || isNaN(d1) || d1 < d0) return json({ error: 'bad-range' }, { status: 400 });
  const MAX = 400; // tope ~13 meses
  const ymds = []; // claves de KV en 8 dígitos
  for (let d = new Date(d0); d <= d1 && ymds.length < MAX; d.setUTCDate(d.getUTCDate() + 1)) {
    ymds.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  const now = gridNow();
  const out = {};
  for (const screen of screens) {
    const cfg = await gridGetConfig(env, screen);
    const cap = cfg.bands.reduce((s, b) => s + b.capacity, 0);
    const rows = await Promise.all(ymds.map(async ymd => {
      const bookings = await gridGetBookings(env, screen, ymd);
      const t = gridComputeDay(cfg, bookings, ymd, now).totals;
      return { date: gridFmtDate(ymd), own: t.ownSlots, paid: t.paidSlots, pending: t.pendingSlots, total: t.totalSlots, occ: t.occupancy, revenue: t.revenue };
    }));
    out[screen] = { name: cfg.name, capacity: cap, bandsPerDay: cfg.bands.length, days: rows };
  }
  return json({ ok: true, from: gridFmtDate(from), to: gridFmtDate(to), count: ymds.length, screens: out });
}
// Detalle de VENTAS (slots accepted/sold) por rango — para el informe del CMS.
async function gridSalesHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 400 });
  const raw = url.searchParams.get('screens') || url.searchParams.get('screen') || '';
  const screens = raw.split(',').map(s => gridScreen(s.trim())).filter(Boolean);
  if (!screens.length) return json({ error: 'missing-screen' }, { status: 400 });
  const from = gridDate(url.searchParams.get('from')), to = gridDate(url.searchParams.get('to'));
  if (!from || !to) return json({ error: 'missing-from-to' }, { status: 400 });
  const toISO = s => s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  const d0 = new Date(toISO(from) + 'T00:00:00Z'), d1 = new Date(toISO(to) + 'T00:00:00Z');
  if (isNaN(d0) || isNaN(d1) || d1 < d0) return json({ error: 'bad-range' }, { status: 400 });
  const MAX = 400, ymds = [];
  for (let d = new Date(d0); d <= d1 && ymds.length < MAX; d.setUTCDate(d.getUTCDate() + 1)) ymds.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  const sales = [];
  for (const screen of screens) {
    const cfg = await gridGetConfig(env, screen);
    await Promise.all(ymds.map(async ymd => {
      const bks = await gridGetBookings(env, screen, ymd);
      for (const b of bks) {
        if (b.status === 'accepted' || b.status === 'sold') {
          const rev = (+b.price || 0) || ((+b.cpm || 0) * gridSlots(b));
          sales.push({ date: gridFmtDate(ymd), screen, screenName: cfg.name, bandId: b.bandId, advertiser: b.advertiser || '—', title: b.title || '', category: b.category || null, cpm: +b.cpm || 0, slots: gridSlots(b), revenue: Math.round(rev * 100) / 100, offer: !!b.offer });
        }
      }
    }));
  }
  let revenue = 0; sales.forEach(s => revenue += s.revenue);
  return json({ ok: true, from: gridFmtDate(from), to: gridFmtDate(to), count: sales.length, revenue: Math.round(revenue * 100) / 100, sales });
}
// ─── Pago con tarjeta (compra de campañas por anunciantes) ───────────────────
// Procesador propio verificable: aprueba tarjetas válidas (Luhn lo valida el front),
// rechaza la tarjeta de prueba ••0002, registra el pago en KV y avisa por Telegram.
// NUNCA recibe el PAN completo (solo brand+last4). Si algún día hay STRIPE_SECRET_KEY,
// aquí se haría el PaymentIntent real (mismo contrato de salida).
async function payHandler(req, env, ctx) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const amount = Math.round((+b.amount || 0) * 100) / 100;
  const last4 = String(b.last4 || '').replace(/\D/g, '').slice(-4);
  const brand = String(b.brand || 'card').slice(0, 20);
  if (amount <= 0 || last4.length !== 4) return json({ error: 'bad-amount-or-card' }, { status: 400 });
  const id = 'pay_' + gridRid(), ts = Date.now();
  const declined = last4 === '0002'; // tarjeta de prueba de rechazo (Stripe 4000 0000 0000 0002)
  const status = declined ? 'declined' : 'paid';
  const rec = { id, amount, currency: 'EUR', brand, last4, status, advertiser: String(b.advertiser || '').slice(0, 80), order: b.order || null, createdAt: new Date(ts).toISOString() };
  if (declined) {
    if (env.SIGNAGE_KV) await env.SIGNAGE_KV.put('pay:' + ts + ':' + id, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 365 });
    notify(ctx, env, `💳 <b>PAGO</b> ❌ rechazado · €${amount} · ${escHtml(brand)} ••${last4}`);
    return json({ ok: false, status, id, error: 'card-declined' }, { status: 402 });
  }
  // aprobado → reservar los slots pagados en el servidor (sin exponer GRID_KEY al comprador)
  let booked = 0; const o = b.order || {};
  try {
    const screens = (o.screens || []).map(gridScreen).filter(Boolean);
    const dates = (o.dates || []).map(gridDate).filter(Boolean);
    const bands = (o.bands || []).map(x => String(x));
    if (env.SIGNAGE_KV && screens.length && dates.length && bands.length && o.creative) {
      for (const screen of screens) for (const date of dates) {
        const bookings = await gridGetBookings(env, screen, date);
        for (const bandId of bands) { bookings.push({ id: 'bk_' + gridRid(), bandId, slots: 1, status: 'sold', advertiser: rec.advertiser || 'Anunciante', title: o.creative.name || 'Campaña', category: o.creative.category || null, creative: gridCleanCreative(o.creative), cpm: +o.cpm || 0, price: +o.price || 0, paymentId: id, createdAt: Date.now() }); booked++; }
        await gridPutBookings(env, screen, date, bookings);
      }
    }
  } catch (_) {}
  rec.booked = booked;
  if (env.SIGNAGE_KV) await env.SIGNAGE_KV.put('pay:' + ts + ':' + id, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 365 });
  notify(ctx, env, `💳 <b>PAGO</b> ✅ cobrado · €${amount} · ${escHtml(brand)} ••${last4}${rec.advertiser ? (' · ' + escHtml(rec.advertiser)) : ''} · ${booked} pase(s)`);
  return json({ ok: true, status, id, amount, last4, brand, booked, receipt: rec });
}
async function payListHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ ok: true, payments: [] });
  const list = await env.SIGNAGE_KV.list({ prefix: 'pay:', limit: 200 });
  const keys = list.keys.map(k => k.name).sort().reverse().slice(0, 100);
  const payments = [];
  for (const k of keys) { try { payments.push(JSON.parse(await env.SIGNAGE_KV.get(k))); } catch (_) {} }
  let total = 0; payments.forEach(p => { if (p.status === 'paid') total += p.amount || 0; });
  return json({ ok: true, count: payments.length, total: Math.round(total * 100) / 100, payments });
}
// ─── Segmentación (cámara→contenido): matriz de reglas por target en KV ───────
const segKey = t => 'seg:rules:' + String(t || 'all').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
async function segmentationHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const target = url.searchParams.get('target') || 'all';
  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
    const rules = Array.isArray(b.rules) ? b.rules.slice(0, 200) : [];
    await env.SIGNAGE_KV.put(segKey(target), JSON.stringify({ target, rules, updatedAt: Date.now() }).slice(0, 100000));
    return json({ ok: true, target, count: rules.length });
  }
  let rec = null; try { rec = JSON.parse(await env.SIGNAGE_KV.get(segKey(target)) || 'null'); } catch (_) {}
  return json(rec || { target, rules: [] });
}
async function segAssignedHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ assigned: [] });
  const l = await env.SIGNAGE_KV.list({ prefix: 'seg:rules:', limit: 500 });
  return json({ assigned: l.keys.map(k => k.name.slice('seg:rules:'.length)) });
}
async function segHitsHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ hits: [] });
  if (req.method === 'POST') { let b; try { b = await req.json(); } catch { b = {}; } const ts = Date.now(); await env.SIGNAGE_KV.put('seg:hit:' + ts, JSON.stringify(Object.assign({}, b, { ts })).slice(0, 4000), { expirationTtl: 172800 }); return json({ ok: true }); }
  const l = await env.SIGNAGE_KV.list({ prefix: 'seg:hit:', limit: 50 });
  const keys = l.keys.map(k => k.name).sort().reverse().slice(0, 40); const hits = [];
  for (const k of keys) { try { hits.push(JSON.parse(await env.SIGNAGE_KV.get(k))); } catch (_) {} }
  return json({ hits });
}
// Exporta la parrilla como iCalendar (.ics) — para suscribir/importar en Google Calendar.
async function gridIcsHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return new Response('kv-not-bound', { status: 500 });
  const raw = url.searchParams.get('screens') || url.searchParams.get('screen') || '';
  const screens = raw.split(',').map(s => gridScreen(s.trim())).filter(Boolean);
  if (!screens.length) return new Response('missing-screen', { status: 400 });
  const now = gridNow();
  let from = gridDate(url.searchParams.get('from')) || now.ymd;
  const toISO = s => s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  let to = gridDate(url.searchParams.get('to'));
  if (!to) { const d = new Date(toISO(from) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 60); to = d.toISOString().slice(0, 10).replace(/-/g, ''); }
  const d0 = new Date(toISO(from) + 'T00:00:00Z'), d1 = new Date(toISO(to) + 'T00:00:00Z');
  const MAX = 120, ymds = [];
  for (let d = new Date(d0); d <= d1 && ymds.length < MAX; d.setUTCDate(d.getUTCDate() + 1)) ymds.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const hm = t => String(t || '00:00').replace(':', '') + '00';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Admira//CMS Emision//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Admira · Emisión', 'X-WR-TIMEZONE:Europe/Madrid'];
  const stamp = now.ymd + 'T' + hm(now.hhmm).slice(0, 4) + '00Z';
  for (const screen of screens) {
    const cfg = await gridGetConfig(env, screen); const bandMap = {}; cfg.bands.forEach(b => bandMap[b.id] = b);
    for (const ymd of ymds) {
      const bks = await gridGetBookings(env, screen, ymd);
      for (const b of bks) {
        if (!(b.status === 'own' || b.status === 'accepted' || b.status === 'sold')) continue;
        const band = bandMap[b.bandId]; if (!band) continue;
        const cr = b.creative || {}; const kind = b.status === 'own' ? 'propio' : 'vendido';
        lines.push('BEGIN:VEVENT',
          'UID:' + esc((b.id || (screen + '-' + ymd + '-' + b.bandId))) + '@admira.tv',
          'DTSTAMP:' + stamp,
          'DTSTART;TZID=Europe/Madrid:' + ymd + 'T' + hm(band.from),
          'DTEND;TZID=Europe/Madrid:' + ymd + 'T' + hm(band.to),
          'SUMMARY:' + esc((cfg.name || screen) + ' · ' + (b.title || kind)),
          'DESCRIPTION:' + esc(kind + (b.advertiser ? (' · ' + b.advertiser) : '') + (cr.url ? ('\n' + cr.url) : '')),
          'CATEGORIES:' + esc(cfg.circuit || 'admira'),
          'X-ADMIRA-SCREEN:' + esc(screen),
          'X-ADMIRA-BAND:' + esc(b.bandId),
          'X-ADMIRA-KIND:' + esc(b.status),
          'X-ADMIRA-CREATIVE-URL:' + esc(cr.url || ''),
          'X-ADMIRA-CREATIVE-TYPE:' + esc(cr.type || ''),
          'END:VEVENT');
      }
    }
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.join('\r\n'), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
// Alertas: dispositivo programado hoy pero SIN emitir (player caído). Corre en el cron
// */10; avisa a Telegram una vez por dispositivo/día (dedup en KV). Watchlist fija v1.
const ALERT_WATCH = [{ loc: 'xtanco-valencia', screens: ['xtanco-valencia-a', 'xtanco-valencia-b', 'xtanco-valencia-c', 'xtanco-valencia-d', 'xtanco-valencia-musica'] }];
async function gridAlertsCheck(env, ctx) {
  if (!env.SIGNAGE_KV) return;
  const now = gridNow(); const hh = parseInt(now.hhmm, 10) || 0;
  if (hh < 13 || hh > 23) return; // solo de tarde/noche, cuando ya debería haber emitido
  for (const w of ALERT_WATCH) {
    for (const screen of w.screens) {
      try {
        const flagKey = `alert:noemit:${screen}:${now.ymd}`;
        if (await env.SIGNAGE_KV.get(flagKey)) continue;
        const bookings = await gridGetBookings(env, screen, now.ymd);
        const programmed = bookings.some(b => b.status === 'own' || b.status === 'accepted' || b.status === 'sold');
        if (!programmed) continue;
        let plays = 0; try { const e = JSON.parse(await env.SIGNAGE_KV.get(`emit:${w.loc}:${screen}:${now.ymd}`) || 'null'); plays = (e && e.totalPlays) || 0; } catch (_) {}
        if (plays === 0) {
          notify(ctx, env, `🚨 <b>Alerta de emisión</b>\n<code>${screen}</code> está <b>programado</b> pero <b>no ha emitido nada</b> a las ${now.hhmm} (¿player caído?).\nXpacio: ${w.loc}`);
          await env.SIGNAGE_KV.put(flagKey, '1', { expirationTtl: 129600 });
        }
      } catch (_) {}
    }
  }
}
function gridBandSpace(cfg, bookings, bandId, exceptId) {
  const band = cfg.bands.find(x => x.id === bandId); if (!band) return null;
  const used = bookings.filter(x => x.id !== exceptId && x.bandId === bandId && (x.status === 'own' || x.status === 'accepted' || x.status === 'sold')).reduce((s, x) => s + gridSlots(x), 0);
  return { band, used, freeN: band.capacity - used };
}
async function gridBookHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const screen = gridScreen(b.screen), date = gridDate(b.date); if (!screen || !date) return json({ error: 'missing-screen-or-date' }, { status: 400 });
  const cfg = await gridGetConfig(env, screen); const bookings = await gridGetBookings(env, screen, date);
  const status = b.status === 'own' ? 'own' : 'sold';
  const want = Math.max(1, parseInt(b.slots, 10) || 1);
  const sp = gridBandSpace(cfg, bookings, b.bandId); if (!sp) return json({ error: 'bad-band' }, { status: 400 });
  if (sp.freeN < want) return json({ error: 'no-space' }, { status: 409 });
  const position = Number.isFinite(+b.position) ? Math.max(0, Math.min(999, Math.trunc(+b.position))) : null;
  const lane = ['municipal', 'publicidad', 'atemporal'].includes(String(b.lane || '')) ? String(b.lane) : null;
  const bk = { id: 'bk_' + gridRid(), bandId: sp.band.id, slots: want, status, advertiser: String(b.advertiser || '').slice(0, 80) || '—', title: String(b.title || '').slice(0, 120), category: b.category ? String(b.category).slice(0, 40) : null, creative: gridCleanCreative(b.creative), cpm: +b.cpm || 0, price: +b.price || 0, createdAt: Date.now(), playlistId: gridScreen(b.playlistId), position, lane };
  bookings.push(bk); await gridPutBookings(env, screen, date, bookings);
  return json({ ok: true, id: bk.id });
}
// Sustituye una parrilla editorial completa con una sola escritura KV. Evita que
// una ráfaga de /grid/book deje el rundown a medias por límites de escritura.
async function gridRundownHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const screen = gridScreen(b.screen), date = gridDate(b.date), playlistId = gridScreen(b.playlistId);
  const source = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
  if (!screen || !date || !playlistId || !source.length) return json({ error: 'missing-screen-date-playlist-or-items' }, { status: 400 });
  const cfg = await gridGetConfig(env, screen);
  if (b.name != null) cfg.name = String(b.name).slice(0, 80);
  if (b.circuit != null) cfg.circuit = gridCircuit(b.circuit);
  if (Array.isArray(b.pixerScreens)) cfg.pixerScreens = b.pixerScreens.map(s => String(s).slice(0, 60)).slice(0, 20);
  cfg.policy = 'manual';
  const prior = await gridGetBookings(env, screen, date);
  const kept = prior.filter(x => x.playlistId !== playlistId);
  const made = [];
  for (const band of cfg.bands) {
    const occupied = kept.filter(x => x.bandId === band.id && ['own', 'accepted', 'sold'].includes(x.status)).reduce((n, x) => n + gridSlots(x), 0);
    band.capacity = Math.min(60, Math.max(+band.capacity || 6, occupied + source.length));
    for (let i = 0; i < source.length; i++) {
      const x = source[i] || {}, lane = ['municipal', 'publicidad', 'atemporal'].includes(String(x.lane || '')) ? String(x.lane) : 'municipal';
      const creative = gridCleanCreative(x.creative); if (!creative) return json({ error: 'bad-creative', position: i }, { status: 400 });
      const titleOverride = String(x.titleOverride || '').trim().slice(0, 120) || null;
      const titleOverrideFor = titleOverride ? String(x.titleOverrideFor || '').trim().slice(0, 160) || null : null;
      made.push({ id: 'bk_' + gridRid(), bandId: band.id, slots: 1, status: lane === 'publicidad' ? 'sold' : 'own', advertiser: String(x.advertiser || (lane === 'publicidad' ? 'Publicidad local' : 'Ajuntament')).slice(0, 80), title: String(titleOverride || x.title || creative.name || '').slice(0, 120), titleOverride, titleOverrideFor, category: lane, creative, cpm: 0, price: 0, createdAt: Date.now() + i, playlistId, position: i, lane });
    }
  }
  await env.SIGNAGE_KV.put('grid:cfg:' + screen, JSON.stringify(cfg).slice(0, 16000));
  await gridPutBookings(env, screen, date, kept.concat(made));
  return json({ ok: true, screen, date: gridFmtDate(date), playlistId, bands: cfg.bands.length, passes: made.length, replaced: prior.length - kept.length });
}
const GRID_TAG_PLAYLIST = 'municipal-50-50';
const GRID_TAG_TARGETS = [
  { screen: 'sim-gracia-kiosko', tag: 'canalkioskpubli', lane: 'publicidad' },
  { screen: 'sim-gracia-kiosko', tag: 'ayuntamientogracia', lane: 'municipal' },
  { screen: 'xtore-escaparate-pn1w', tag: 'xtancovalenciapubli', lane: 'publicidad' },
];
function gridStockTags(item) {
  return new Set((Array.isArray(item && item.tags) ? item.tags : []).map(t => String(t).toLowerCase().trim().replace(/^#/, '')));
}
async function gridEnsureDailyTaggedRundown(env, screen, date) {
  const current = await gridGetBookings(env, screen, date);
  const cfg = await gridGetConfig(env, screen);
  const missingBands = cfg.bands.filter(b => !current.some(x => x.bandId === b.id && x.playlistId === GRID_TAG_PLAYLIST));
  if (!missingBands.length) return { bookings: current, carried: 0 };
  let previous = [];
  for (let days = 1; days <= 7 && !previous.length; days++) {
    previous = (await gridGetBookings(env, screen, gridShiftDate(date, -days))).filter(x => x.playlistId === GRID_TAG_PLAYLIST);
  }
  if (!previous.length) return { bookings: current, carried: 0 };
  const missingIds = new Set(missingBands.map(b => b.id));
  const carried = previous.filter(x => missingIds.has(x.bandId)).map((x, i) => Object.assign({}, x, {
    id: 'bk_' + gridRid(),
    createdAt: Date.now() + i,
  }));
  if (carried.length) await gridPutBookings(env, screen, date, current.concat(carried));
  return { bookings: current.concat(carried), carried: carried.length };
}
async function gridSyncTaggedStock(env, stockItems) {
  if (!env.SIGNAGE_KV) return { ok: false, error: 'kv-not-bound', targets: [] };
  const items = (Array.isArray(stockItems) ? stockItems : [])
    .filter(x => x && x.id && x.url && (x.type === 'image' || x.type === 'video'))
    .sort((a, z) => String(z.createdAt || '').localeCompare(String(a.createdAt || '')));
  const date = gridNow().ymd, results = [];
  for (const target of GRID_TAG_TARGETS) {
    const tagged = items.filter(x => gridStockTags(x).has(target.tag)).slice(0, 5);
    const ensured = await gridEnsureDailyTaggedRundown(env, target.screen, date), bookings = ensured.bookings, before = JSON.stringify(bookings);
    let laneSlots = 0;
    for (const band of (await gridGetConfig(env, target.screen)).bands) {
      const slots = bookings.filter(x => x.bandId === band.id && x.playlistId === GRID_TAG_PLAYLIST && x.lane === target.lane)
        .sort((a, z) => (+a.position || 0) - (+z.position || 0));
      const overridesByContent = new Map(slots.filter(x => x.titleOverride && x.titleOverrideFor).map(x => [String(x.titleOverrideFor), String(x.titleOverride).slice(0, 120)]));
      laneSlots += slots.length;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i], stock = tagged[i];
        if (stock) {
          if (!slot.tagFallback && slot.sourceTag !== target.tag) {
            slot.tagFallback = { title: slot.title, advertiser: slot.advertiser, category: slot.category, creative: slot.creative };
          }
          const stockTitle = stock.title || stock.prompt || ('Pixeria #' + (stock.num || stock.id));
          const contentKey = 'stock:' + stock.id, carriedTitle = overridesByContent.get(contentKey) || null;
          if (carriedTitle) { slot.titleOverride = carriedTitle; slot.titleOverrideFor = contentKey; }
          else { delete slot.titleOverride; delete slot.titleOverrideFor; }
          slot.title = String(carriedTitle || stockTitle).slice(0, 120);
          slot.advertiser = target.lane === 'municipal' ? 'Ajuntament de Gràcia' : 'Pixeria'; slot.category = target.lane;
          slot.creative = { type: stock.type, url: String(stock.url).slice(0, 500), name: slot.title };
          slot.stockId = String(stock.id); slot.sourceTag = target.tag;
        } else if (slot.sourceTag === target.tag) {
          const fallback = slot.tagFallback || (target.lane === 'municipal'
            ? { title: 'Contenido del Ayuntamiento', advertiser: 'Ajuntament de Gràcia', category: 'municipal', creative: { type: 'image', url: 'https://admira.tv/parrilla/assets/sabias.svg', name: 'Contenido del Ayuntamiento' } }
            : { title: 'Publicidad local ' + String.fromCharCode(65 + i), advertiser: 'Publicidad local', category: 'publicidad', creative: { type: 'image', url: 'https://admira.tv/parrilla/assets/publicidad.svg', name: 'Publicidad local' } });
          slot.title = fallback.title; slot.advertiser = fallback.advertiser; slot.category = fallback.category; slot.creative = fallback.creative;
          delete slot.stockId; delete slot.sourceTag; delete slot.tagFallback;
        }
      }
    }
    const changed = JSON.stringify(bookings) !== before;
    if (changed) await gridPutBookings(env, target.screen, date, bookings);
    results.push({ screen: target.screen, tag: '#' + target.tag, lane: target.lane, matched: tagged.length, laneSlots, adSlots: target.lane === 'publicidad' ? laneSlots : 0, carried: ensured.carried, changed, items: tagged.map(x => ({ id: x.id, num: x.num || null, title: x.title || x.prompt || x.id, type: x.type })) });
  }
  const status = { ok: true, date: gridFmtDate(date), syncedAt: Date.now(), targets: results };
  await env.SIGNAGE_KV.put('grid:tag-sync:status', JSON.stringify(status).slice(0, 16000));
  return status;
}
async function gridReadStockIndex(env) {
  if (!env.STOCK_BUCKET) return [];
  try { const obj = await env.STOCK_BUCKET.get('stock/index.json'); const data = obj ? await obj.json() : null; return Array.isArray(data) ? data : ((data && data.items) || []); } catch { return []; }
}
async function gridTagSyncHandler(req, env) {
  if (req.method === 'GET') {
    let status = null; try { status = JSON.parse(await env.SIGNAGE_KV.get('grid:tag-sync:status') || 'null'); } catch (e) {}
    return json(status || { ok: true, syncedAt: null, targets: GRID_TAG_TARGETS.map(x => ({ screen: x.screen, tag: '#' + x.tag, lane: x.lane, matched: 0, laneSlots: 0, adSlots: 0, items: [] })) });
  }
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  return json(await gridSyncTaggedStock(env, await gridReadStockIndex(env)));
}
async function gridOfferHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  const screen = gridScreen(b.screen), date = gridDate(b.date); if (!screen || !date) return json({ error: 'missing-screen-or-date' }, { status: 400 });
  const cfg = await gridGetConfig(env, screen); const band = cfg.bands.find(x => x.id === b.bandId); if (!band) return json({ error: 'bad-band' }, { status: 400 });
  const ctrl = await gridGetControl(env, cfg.circuit);
  const advertiser = String(b.advertiser || '').slice(0, 80) || '—', title = String(b.title || '').slice(0, 120), category = b.category ? String(b.category).slice(0, 40) : null;
  const lc = s => String(s || '').toLowerCase();
  const blocked = ctrl.blacklist.advertisers.some(a => a && lc(advertiser).includes(lc(a))) || (category && ctrl.blacklist.categories.some(c => lc(c) === lc(category))) || ctrl.blacklist.terms.some(t => t && lc(title).includes(lc(t)));
  const policy = (cfg.policy && cfg.policy !== 'inherit') ? cfg.policy : ctrl.policy;
  const bookings = await gridGetBookings(env, screen, date);
  let status = blocked ? 'rejected' : (policy === 'auto' ? 'accepted' : 'pending');
  if (status === 'accepted') { const sp = gridBandSpace(cfg, bookings, band.id); if (!sp || sp.freeN < Math.max(1, parseInt(b.slots, 10) || 1)) status = 'pending'; }
  const bk = { id: 'bk_' + gridRid(), bandId: band.id, slots: Math.max(1, parseInt(b.slots, 10) || 1), status, advertiser, title, category, creative: gridCleanCreative(b.creative), cpm: +b.cpm || 0, price: +b.price || 0, createdAt: Date.now(), offer: true };
  bookings.push(bk); await gridPutBookings(env, screen, date, bookings);
  return json({ ok: true, id: bk.id, status });
}
async function gridDecideHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const screen = gridScreen(b.screen), date = gridDate(b.date), id = String(b.id || ''); if (!screen || !date || !id) return json({ error: 'missing' }, { status: 400 });
  const bookings = await gridGetBookings(env, screen, date); const bk = bookings.find(x => x.id === id); if (!bk) return json({ error: 'not-found' }, { status: 404 });
  if (String(b.decision) === 'accept') { const cfg = await gridGetConfig(env, screen); const sp = gridBandSpace(cfg, bookings, bk.bandId, id); if (sp && sp.freeN < gridSlots(bk)) return json({ error: 'no-space' }, { status: 409 }); bk.status = 'accepted'; }
  else bk.status = 'rejected';
  await gridPutBookings(env, screen, date, bookings);
  return json({ ok: true, id, status: bk.status });
}
async function gridUnbookHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const screen = gridScreen(b.screen), date = gridDate(b.date), id = String(b.id || ''); if (!screen || !date || !id) return json({ error: 'missing' }, { status: 400 });
  let bookings = await gridGetBookings(env, screen, date); const before = bookings.length; bookings = bookings.filter(x => x.id !== id);
  if (bookings.length === before) return json({ error: 'not-found' }, { status: 404 });
  await gridPutBookings(env, screen, date, bookings); return json({ ok: true });
}
async function gridConfigHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  if (req.method === 'GET') { const screen = gridScreen(url.searchParams.get('screen')); if (!screen) return json({ error: 'missing-screen' }, { status: 400 }); return json({ ok: true, screen, config: await gridGetConfig(env, screen) }); }
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const screen = gridScreen(b.screen || url.searchParams.get('screen')); if (!screen) return json({ error: 'missing-screen' }, { status: 400 });
  const next = await gridGetConfig(env, screen);
  if (b.name != null) next.name = String(b.name).slice(0, 80);
  if (b.circuit != null) next.circuit = gridCircuit(b.circuit);
  if (b.policy != null && ['inherit', 'manual', 'auto'].includes(b.policy)) next.policy = b.policy;
  if (b.slotSeconds != null) next.slotSeconds = Math.max(1, Math.min(120, +b.slotSeconds || 10));
  if (Array.isArray(b.pixerScreens)) next.pixerScreens = b.pixerScreens.map(s => String(s).slice(0, 60)).slice(0, 20);
  if (Array.isArray(b.bands)) next.bands = b.bands.map(x => ({ id: String(x.id || '').slice(0, 24), label: String(x.label || x.id || '').slice(0, 40), from: String(x.from || '00:00').slice(0, 5), to: String(x.to || '00:00').slice(0, 5), capacity: Math.max(1, Math.min(60, +x.capacity || 6)) })).filter(x => x.id).slice(0, 12);
  await env.SIGNAGE_KV.put('grid:cfg:' + screen, JSON.stringify(next).slice(0, 16000));
  return json({ ok: true, screen, config: next });
}
async function gridControlHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  if (req.method === 'GET') { const circuit = gridCircuit(url.searchParams.get('circuit')); if (!circuit) return json({ error: 'missing-circuit' }, { status: 400 }); return json({ ok: true, circuit, control: await gridGetControl(env, circuit) }); }
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const circuit = gridCircuit(b.circuit || url.searchParams.get('circuit')); if (!circuit) return json({ error: 'missing-circuit' }, { status: 400 });
  const cur = await gridGetControl(env, circuit);
  if (b.policy != null && ['manual', 'auto'].includes(b.policy)) cur.policy = b.policy;
  if (b.blacklist) for (const k of ['advertisers', 'categories', 'terms']) if (Array.isArray(b.blacklist[k])) cur.blacklist[k] = b.blacklist[k].map(s => String(s).slice(0, 60)).slice(0, 100);
  await env.SIGNAGE_KV.put('grid:ctrl:' + circuit, JSON.stringify(cur).slice(0, 16000));
  return json({ ok: true, circuit, control: cur });
}
async function gridScreensHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const prefix = 'grid:cfg:', screens = []; let cursor, n = 0;
  try { do { const list = await env.SIGNAGE_KV.list({ prefix, cursor, limit: 1000 }); for (const k of list.keys) { const screen = k.name.slice(prefix.length); let c = null; try { c = JSON.parse(await env.SIGNAGE_KV.get(k.name) || 'null'); } catch (e) {} screens.push({ screen, name: (c && c.name) || screen, circuit: (c && c.circuit) || screen.split('-')[0], bands: (c && c.bands ? c.bands.length : 0), pixerScreens: (c && c.pixerScreens) || [] }); if (++n > 500) break; } cursor = list.list_complete ? null : list.cursor; } while (cursor && n <= 500); }
  catch (e) { return json({ error: 'kv-list-failed' }, { status: 502 }); }
  return json({ ok: true, screens });
}
// ── Canales/proyectos: agrupan circuitos (CanalKiosk, CanalMetro, Canal AdmiraNeXT…) ──
const GRID_PROJECTS_DEFAULT = [
  { id: 'admiranext', name: 'Canal AdmiraNeXT', circuits: ['admiranext', 'admira', 'robot'] },
  { id: 'kiosk', name: 'CanalKiosk', circuits: ['kiosko'] },
  { id: 'metro', name: 'CanalMetro', circuits: ['metro'] },
];
function gridCleanProjects(arr) {
  if (!Array.isArray(arr)) return null;
  const out = arr.map(p => ({
    id: gridCircuit(p && p.id),
    name: String((p && p.name) || '').slice(0, 60),
    circuits: Array.isArray(p && p.circuits) ? p.circuits.map(c => gridCircuit(c)).filter(Boolean).slice(0, 40) : [],
  })).filter(p => p.id && p.name);
  return out.slice(0, 60);
}
async function gridProjectsHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  if (req.method === 'GET') {
    let p = null; try { p = JSON.parse(await env.SIGNAGE_KV.get('grid:projects') || 'null'); } catch (e) {}
    return json({ ok: true, projects: (Array.isArray(p) && p.length) ? p : GRID_PROJECTS_DEFAULT });
  }
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const clean = gridCleanProjects(b.projects);
  if (!clean) return json({ error: 'bad-projects' }, { status: 400 });
  await env.SIGNAGE_KV.put('grid:projects', JSON.stringify(clean).slice(0, 16000));
  return json({ ok: true, projects: clean });
}
// ── Borrador COMPARTIDO de la parrilla · GET/POST /grid/draft ─────────────────
// Mueve el borrador del editor (admira.tv/parrilla) de localStorage a KV para
// que se comparta entre máquinas y navegadores. Lectura sin key (el site va
// tras SSO, igual que /grid/projects); escritura con GRID_KEY. Clave KV:
//   grid:draft:<screen>:<playlist>   { items, titles, rev, updatedAt, by }
// KV es eventual → aceptamos last-write-wins, PERO si el POST llega con un rev
// por detrás del guardado devolvemos 409 con el draft vigente, para que el
// front recargue en vez de pisar a ciegas (misma lección que /grid/book).
function gridPlaylistId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60); }
async function gridDraftHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  if (req.method === 'GET') {
    const screen = gridScreen(url.searchParams.get('screen')), playlist = gridPlaylistId(url.searchParams.get('playlist'));
    if (!screen || !playlist) return json({ error: 'missing-screen-or-playlist' }, { status: 400 });
    let d = null; try { d = JSON.parse(await env.SIGNAGE_KV.get('grid:draft:' + screen + ':' + playlist) || 'null'); } catch (e) {}
    return json({ ok: true, draft: (d && typeof d === 'object') ? d : null });
  }
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const screen = gridScreen(b.screen), playlist = gridPlaylistId(b.playlist);
  if (!screen || !playlist) return json({ error: 'missing-screen-or-playlist' }, { status: 400 });
  if (!Array.isArray(b.items) || b.items.length > 50) return json({ error: 'bad-items' }, { status: 400 });
  const titles = (b.titles && typeof b.titles === 'object' && !Array.isArray(b.titles)) ? b.titles : {};
  const kvKey = 'grid:draft:' + screen + ':' + playlist;
  let stored = null; try { stored = JSON.parse(await env.SIGNAGE_KV.get(kvKey) || 'null'); } catch (e) {}
  const storedRev = (stored && Number.isFinite(+stored.rev)) ? +stored.rev : 0;
  const sentRev = Number.isFinite(+b.rev) ? +b.rev : 0;
  if (sentRev < storedRev) return json({ error: 'stale-rev', draft: stored }, { status: 409 });
  const rev = storedRev + 1, updatedAt = Date.now(), by = String(b.by || '').slice(0, 60) || null;
  const payload = JSON.stringify({ items: b.items, titles, rev, updatedAt, by });
  if (payload.length > 120000) return json({ error: 'too-large' }, { status: 413 });
  await env.SIGNAGE_KV.put(kvKey, payload);
  return json({ ok: true, rev, updatedAt });
}
async function gridUploadHandler(req, env, url) {
  if (!env.STOCK_BUCKET) return json({ error: 'r2-not-bound' }, { status: 500 });
  if (!gridKeyOk(env, { key: url.searchParams.get('key') })) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const circuit = gridCircuit(url.searchParams.get('circuit')) || 'x';
  const ext = String(url.searchParams.get('ext') || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
  const body = await req.arrayBuffer(); if (!body || body.byteLength === 0) return json({ error: 'empty' }, { status: 400 });
  if (body.byteLength > 84 * 1024 * 1024) return json({ error: 'too-large' }, { status: 413 });
  const keyName = 'grid/' + circuit + '/' + gridRid() + gridRid() + '.' + ext;
  try { await env.STOCK_BUCKET.put(keyName, body, { httpMetadata: { contentType: req.headers.get('Content-Type') || 'application/octet-stream' } }); }
  catch (e) { return json({ error: 'r2-put-failed', detail: String(e).slice(0, 120) }, { status: 502 }); }
  return json({ ok: true, url: GRID_R2_PUBLIC + '/' + keyName });
}
async function gridEmitHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const screen = gridScreen(b.screen); if (!screen) return json({ error: 'missing-screen' }, { status: 400 });
  const now = gridNow(); const cfg = await gridGetConfig(env, screen);
  const day = gridComputeDay(cfg, await gridGetBookings(env, screen, now.ymd), now.ymd, now);
  const np = day.nowPlaying, pushed = [];
  const payload = JSON.stringify({ screen, advertiser: np && np.advertiser, title: np && np.title, creative: (np && np.creative) || null, free: !!(np && np.free), at: Date.now() });
  for (const ps of (cfg.pixerScreens || [])) { const id = gridScreen(ps); if (!id) continue; try { await env.SIGNAGE_KV.put('signage:now:' + id, payload); pushed.push(id); } catch (e) {} }
  return json({ ok: true, pushed, nowPlaying: np });
}

// ── CPM por SEGMENTO (RTB) — la pauta la fija admira.app, el gemelo la lee ──
const SEG_CPM_KEYS = ['joven_m','joven_f','adulto_m','adulto_f','senior_m','senior_f','nino_m','nino_f'];
async function segCpmGetHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const loc = String(url.searchParams.get('loc') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  let cpm = {}; try { cpm = JSON.parse(await env.SIGNAGE_KV.get(`segcpm:${loc}`) || '{}') || {}; } catch {}
  return json({ ok: true, loc, cpm });
}
async function segCpmPutHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const loc = String(url.searchParams.get('loc') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const inC = (b && typeof b.cpm === 'object' && b.cpm) ? b.cpm : b;
  const cpm = {};
  for (const k of SEG_CPM_KEYS) { const v = +(inC && inC[k]); if (isFinite(v) && v >= 0) cpm[k] = Math.min(200, Math.round(v * 100) / 100); }
  if (!Object.keys(cpm).length) return json({ error: 'no-valid-cpm', expected: SEG_CPM_KEYS }, { status: 400 });
  try { await env.SIGNAGE_KV.put(`segcpm:${loc}`, JSON.stringify(cpm)); } catch (e) { return json({ error: 'kv-put-failed' }, { status: 502 }); }
  return json({ ok: true, loc, cpm });
}

// ── CAMPAÑAS programáticas (compra desde admira.app) ──────────────
// Una campaña = {seg, presupuesto, cpm, creatividad}. El presupuesto se "consume"
// con los impactos reales por segmento que reporta el gemelo (cálculo read-side
// desde day:* en admira.app). Aquí solo guardamos/listamos el registro.
async function campaignCreateHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const loc = String(b.loc || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  // seg OPCIONAL (RTB): vacío = campaña sin targeting demográfico (run-of-network).
  // Si se envía uno, sigue teniendo que ser válido (retrocompatible con admira.app).
  const seg = String(b.seg || '').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 16);
  if (seg && !SEG_CPM_KEYS.includes(seg)) return json({ error: 'bad-seg', expected: SEG_CPM_KEYS }, { status: 400 });
  const budget = Math.max(1, Math.min(1e7, +b.budget || 0));
  const cpm = Math.max(0.1, Math.min(200, +b.cpm || 8));
  const d = new Date();
  const startDate = String(b.startDate || '').replace(/[^0-9]/g, '').slice(0, 8) ||
    ('' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'));
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = { id, loc, seg, name: String(b.name || 'Campaña').slice(0, 80), product: String(b.product || '').slice(0, 80),
    creativeUrl: String(b.creativeUrl || '').slice(0, 300), budget, cpm, startDate, active: true, createdAt: Date.now(),
    // Campos opcionales para el motor RTB (/rtb/decide) — todos retrocompatibles.
    advertiser: String(b.advertiser || '').slice(0, 80),
    medio: String(b.medio || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20),
    stockId: String(b.stockId || '').replace(/[^a-z0-9]/gi, '').slice(0, 40),
    category: '', slot: '',
    circuit: String(b.circuit || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) };
  // slot/category contra enums (normalizando tildes/ñ: "mañana"→"manana").
  // 400 con mensaje claro si no casan — antes era texto libre y fallaba en silencio.
  if (b.slot) {
    const slot = rtbNormEnum(b.slot);
    if (!RTB_SLOTS.includes(slot)) return json({ error: 'bad-slot', got: String(b.slot).slice(0, 40), expected: RTB_SLOTS }, { status: 400 });
    rec.slot = slot;
  }
  if (b.category) {
    const category = rtbNormEnum(b.category);
    if (!RTB_CATEGORIES.includes(category)) return json({ error: 'bad-category', got: String(b.category).slice(0, 40), expected: RTB_CATEGORIES }, { status: 400 });
    rec.category = category;
  }
  try { await env.SIGNAGE_KV.put(`camp:${loc}:${id}`, JSON.stringify(rec)); } catch (e) { return json({ error: 'kv-put-failed' }, { status: 502 }); }
  return json({ ok: true, campaign: rec });
}
async function campaignListHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const loc = String(url.searchParams.get('loc') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  const prefix = `camp:${loc}:`; const out = []; let cursor, n = 0;
  try {
    do {
      const list = await env.SIGNAGE_KV.list({ prefix, cursor, limit: 1000 });
      for (const k of list.keys) { const v = await env.SIGNAGE_KV.get(k.name); if (v) { try { out.push(JSON.parse(v)); } catch {} } if (++n > 200) break; }
      cursor = list.list_complete ? null : list.cursor;
    } while (cursor && n <= 200);
  } catch (e) { return json({ error: 'kv-list-failed' }, { status: 502 }); }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ ok: true, loc, campaigns: out });
}
async function campaignDeleteHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const loc = String(b.loc || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const id = String(b.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
  if (!loc || !id) return json({ error: 'missing-loc-or-id' }, { status: 400 });
  try { await env.SIGNAGE_KV.delete(`camp:${loc}:${id}`); } catch (e) { return json({ error: 'kv-delete-failed' }, { status: 502 }); }
  return json({ ok: true, deleted: `camp:${loc}:${id}` });
}

// ══════ RTB · MOTOR DE DECISIÓN PROGRAMÁTICA (subasta de segundo precio) ══════
// El "hueco del medio" entre inventario (/campaign) y emisión (/emit,/signage):
// dada una impresión concreta (pantalla + circuito + segmento), decide en tiempo
// real qué campaña gana y a qué precio, second-price REAL (no Math.random).
//
//   POST /rtb/decide  { screen, circuit, segment?:{audience,age,category,slot}, floor?:number }
//     → candidatas = campañas ACTIVAS con presupuesto>0 cuyo targeting case con el
//       segmento; gana la de mayor CPM; paga max(floor, 2ºCPM+0.01) (o max(floor,
//       cpm*0.6) si es la única). Descuenta price del presupuesto ganador y apunta
//       la decisión en KV rtb:day:<YYYYMMDD> (array circular, máx 500).
//     → 200 {ok:true, decision:{id,advertiser,title,creativeUrl,medio,cpm,price,currency:"EUR",ttlSec:300}}
//     → 200 {ok:false, reason:"no_demand"} si no hay candidatas.
//   GET  /rtb/feed?limit=20 → {ok:true, decisions:[últimas]} (clearchannel.tv
//       sustituye su feed simulado por esto).
// CORS: admira.tv y clearchannel.tv ya están en ALLOWED_ORIGINS (wrapper global).

// Enums de slot/category (los que emite el canal). Se comparan tras rtbNormEnum.
const RTB_SLOTS = ['manana', 'mediodia', 'tarde', 'noche'];
const RTB_CATEGORIES = ['atraer', 'producto', 'promo', 'marca'];
// Normaliza texto libre a clave de enum: minúsculas, sin tildes/ñ ("mañana"→"manana").
function rtbNormEnum(v) {
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]/g, '').slice(0, 20);
}
// Normaliza el age libre que manda el reproductor a las claves del gemelo.
// 'vejez' (bucket 75+ de la cámara del canal) → senior: decisión de Neo — NO se
// amplía SEG_CPM_KEYS hoy, senior absorbe 75+.
function rtbNormAge(a) {
  const s = String(a || '').toLowerCase();
  if (/nin|child|kid|infan/.test(s)) return 'nino';
  if (/jov|young|teen/.test(s)) return 'joven';
  if (/sen|elder|old|mayor|abuel|vejez/.test(s)) return 'senior';
  if (/adult|mid/.test(s)) return 'adulto';
  return '';
}
function rtbNormGender(g) {
  const s = String(g || '').toLowerCase();
  // Femenino PRIMERO: 'female' contiene la subcadena 'male'.
  if (/female|mujer|fem|woman|^f$|^f[ae]/.test(s)) return 'f';
  if (/male|hombre|masc|man|^m$|^m[ae]/.test(s)) return 'm';
  return '';
}
// Clave de segmento pedida (p.ej. 'adulto_m') o '' si el segmento es incompleto.
function rtbSegKey(segment) {
  if (!segment || typeof segment !== 'object') return '';
  const age = rtbNormAge(segment.age);
  const gen = rtbNormGender(segment.audience != null ? segment.audience : (segment.gender || segment.sex));
  return (age && gen) ? `${age}_${gen}` : '';
}
// ¿La campaña c es candidata para esta impresión?
function rtbMatch(c, reqSeg, segment, circuit) {
  if (!c || c.active === false) return false;
  if (!(+c.budget > 0)) return false;
  if (c.seg) {                          // campaña con targeting demográfico
    // Segmento del request incompleto o no reconocido (reqSeg vacío) → EXCLUIR:
    // una campaña targeted no puede colarse en impresiones sin segmento válido
    // (bypass detectado por infraNeo en E2E; solo las catch-all sin seg compiten).
    if (!reqSeg || c.seg !== reqSeg) return false;
  }
  // circuit OPCIONAL en la campaña: si lo declara, solo casa en ese circuito.
  if (c.circuit && rtbNormEnum(circuit) !== c.circuit) return false;
  // category/slot: misma normalización de enums a AMBOS lados (defensa en
  // profundidad para campañas guardadas antes de la validación por enum).
  const cat = segment ? rtbNormEnum(segment.category) : '';
  if (c.category && cat && rtbNormEnum(c.category) !== cat) return false;
  const slot = segment ? rtbNormEnum(segment.slot) : '';
  if (c.slot && slot && rtbNormEnum(c.slot) !== slot) return false;
  return true;
}
async function rtbLoadCampaigns(env) {
  const out = []; let cursor, n = 0;
  do {
    const list = await env.SIGNAGE_KV.list({ prefix: 'camp:', cursor, limit: 1000 });
    for (const k of list.keys) {
      if (n++ > 500) break;
      let v; try { v = await env.SIGNAGE_KV.get(k.name); } catch { continue; }
      if (!v) continue;
      try { const c = JSON.parse(v); c._key = k.name; out.push(c); } catch {}
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor && n <= 500);
  return out;
}
async function rtbDecideHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const screen = String(b.screen || '').slice(0, 60);
  const circuit = String(b.circuit || '').slice(0, 40);
  const floor = Math.max(0, Math.min(500, +b.floor || 0));
  const segment = (b.segment && typeof b.segment === 'object') ? b.segment : null;
  const reqSeg = rtbSegKey(segment);

  const cands = (await rtbLoadCampaigns(env))
    .filter(c => rtbMatch(c, reqSeg, segment, circuit))
    .sort((a, z) => (+z.cpm || 0) - (+a.cpm || 0));
  if (!cands.length) return json({ ok: false, reason: 'no_demand' });

  const winner = cands[0];
  const wCpm = +winner.cpm || 0;
  let price;
  if (cands.length >= 2) {
    const second = +cands[1].cpm || 0;
    price = Math.min(wCpm, Math.max(floor, second + 0.01)); // second-price, nunca sobre la puja
  } else {
    price = Math.max(floor, wCpm * 0.6);
  }
  price = Math.round(price * 100) / 100;

  // creativeUrl: de la campaña, o resuelto contra el Stock si referencia stockId.
  const origin = new URL(req.url).origin;
  let creativeUrl = winner.creativeUrl || '';
  if (!creativeUrl && winner.stockId) creativeUrl = `${origin}/stock/asset/${winner.stockId}`;

  const decision = {
    id: winner.id,
    advertiser: winner.advertiser || winner.product || winner.name || 'Anunciante',
    title: winner.name || 'Campaña',
    creativeUrl,
    medio: winner.medio || 'dooh',
    cpm: Math.round(wCpm * 100) / 100,
    price,
    currency: 'EUR',
    ttlSec: 300,
  };

  // Descuenta el price del presupuesto de la ganadora (persistente en su registro).
  const newBudget = Math.max(0, Math.round(((+winner.budget || 0) - price) * 100) / 100);
  const updated = { ...winner }; delete updated._key; updated.budget = newBudget;
  try { await env.SIGNAGE_KV.put(winner._key, JSON.stringify(updated)); } catch {}

  // Apunta la decisión en rtb:day:<ymd> (array circular, máx 500).
  const ymd = madridParts().ymd;
  const dayKey = `rtb:day:${ymd}`;
  let arr = [];
  try { arr = JSON.parse(await env.SIGNAGE_KV.get(dayKey) || '[]'); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
  arr.push({ ...decision, screen, circuit, seg: reqSeg || null, budgetLeft: newBudget, ts: Date.now() });
  if (arr.length > 500) arr = arr.slice(arr.length - 500);
  try { await env.SIGNAGE_KV.put(dayKey, JSON.stringify(arr)); } catch {}

  return json({ ok: true, decision });
}
async function rtbFeedHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '20', 10)));
  const { ymd } = madridParts();
  const yd = new Date(Date.now() - 24 * 3600 * 1000);
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(yd).replace(/-/g, '');
  let arr = [];
  try { arr = JSON.parse(await env.SIGNAGE_KV.get(`rtb:day:${ymd}`) || '[]'); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
  if (arr.length < limit && yesterday !== ymd) {   // al cruzar medianoche, rellena con ayer
    let prev = [];
    try { prev = JSON.parse(await env.SIGNAGE_KV.get(`rtb:day:${yesterday}`) || '[]'); if (!Array.isArray(prev)) prev = []; } catch {}
    arr = prev.concat(arr);
  }
  const decisions = arr.slice(-limit).reverse(); // más recientes primero
  return json({ ok: true, count: decisions.length, decisions });
}

// "Web Speech" de pixeria para que la locución gratis produzca un FICHERO y se
// pueda guardar en Stock (speechSynthesis del navegador no genera archivo).
// POST /tts/free { text, lang? } → audio/mpeg (ACAO:* para leerlo en el cliente).
async function ttsFreeHandler(req) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const text = String(b.text || '').trim();
  if (!text) return json({ error: 'missing-text' }, { status: 400 });
  if (text.length > 5000) return json({ error: 'text-too-long', max: 5000 }, { status: 400 });
  const lang = (String(b.lang || 'es').toLowerCase().match(/^[a-z]{2}/) || ['es'])[0];
  // Google TTS admite ~200 chars/petición → trocear respetando espacios.
  const chunks = []; let rest = text;
  while (rest.length && chunks.length < 50) {
    let cut = Math.min(200, rest.length);
    if (cut < rest.length) { const sp = rest.lastIndexOf(' ', cut); if (sp > 40) cut = sp; }
    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut);
  }
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const u = 'https://translate.google.com/translate_tts?ie=UTF-8&q=' + encodeURIComponent(c) +
      '&tl=' + lang + '&client=tw-ob&total=' + chunks.length + '&idx=' + i + '&textlen=' + c.length;
    let r;
    try { r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Referer': 'https://translate.google.com/' } }); }
    catch (e) { return json({ error: 'gtts-fetch-failed', detail: String(e).slice(0, 120) }, { status: 502 }); }
    if (!r.ok) return json({ error: 'gtts-' + r.status }, { status: 502 });
    parts.push(new Uint8Array(await r.arrayBuffer()));
  }
  if (!parts.length) return json({ error: 'no-audio' }, { status: 502 });
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return new Response(out, { headers: { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
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

// ─── Edición de imagen con IA (Gemini 2.5 Flash Image) ─────────────
// Recibe una imagen (base64) + instrucción y devuelve la imagen EDITADA.
// Lo usa el editor pixel-art de pixeria ("la moto ahora rosa" → la pinta).
async function imageEditHandler(req, env) {
  if (!env.GEMINI_API_KEY) return json({ error: 'server-missing-key', service: 'gemini' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const prompt = String(b.prompt || '').trim();
  if (!prompt) return json({ error: 'missing-prompt' }, { status: 400 });
  let img = String(b.image || ''), mime = b.mime || 'image/png';
  const m = /^data:([^;]+);base64,(.*)$/s.exec(img); if (m) { mime = m[1]; img = m[2]; }
  if (!img) return json({ error: 'missing-image' }, { status: 400 });
  const model = (typeof b.model === 'string' && b.model) ? b.model : 'gemini-2.5-flash-image';
  // System prompt por defecto = editor de sprites pixel-art (mobiliario). El cliente
  // puede sobreescribirlo con b.sys (p.ej. para "humanizar" un NPC → foto realista).
  const sys = (typeof b.sys === 'string' && b.sys.trim())
    ? b.sys.trim()
    : 'Eres un editor de sprites pixel-art de mobiliario. Edita la imagen dada siguiendo la instrucción. MANTÉN el estilo pixel-art, el mismo encuadre/pose y el fondo transparente; cambia SOLO lo que se pide. Devuelve la imagen editada.';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ inlineData: { mimeType: mime, data: img } }, { text: sys + '\n\nInstrucción: ' + prompt }] }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: 'gemini-' + r.status, detail: (d && d.error && d.error.message) || '' }, { status: r.status });
  let outImg = null, outMime = 'image/png';
  try { const parts = (((d.candidates || [])[0] || {}).content || {}).parts || []; for (const p of parts) { if (p.inlineData && p.inlineData.data) { outImg = p.inlineData.data; outMime = p.inlineData.mimeType || outMime; break; } } } catch (e) {}
  if (!outImg) {
    // Gemini no devolvió imagen: clasificar el motivo (rechazo de seguridad,
    // copyright/recitation, persona reconocible → IMAGE_OTHER, o respuesta vacía)
    // para que el frontend muestre un mensaje humano en vez del JSON crudo.
    const cand = (((d.candidates || [])[0]) || {});
    const fr = String(cand.finishReason || '');
    const block = String((d.promptFeedback && d.promptFeedback.blockReason) || '');
    const msg = cand.finishMessage || (d.promptFeedback && d.promptFeedback.blockReasonMessage) || '';
    let reason = 'empty';
    if (/SAFETY|PROHIBITED|BLOCK/i.test(fr + ' ' + block)) reason = 'safety';
    else if (/RECITATION|COPYRIGHT/i.test(fr + ' ' + block)) reason = 'copyright';
    else if (/IMAGE/i.test(fr)) reason = 'image-declined';
    return json({ ok: false, error: 'no-image-out', reason, finishReason: fr, blockReason: block, detail: String(msg).slice(0, 300) }, { status: 422 });
  }
  return json({ ok: true, image: 'data:' + outMime + ';base64,' + outImg, mime: outMime });
}

// ─── Gemelo persistente: re-identificación por embedding facial ────
// Prototipo del bucle cámara MUPI → gemelo sintético del Anonimizador.
// La cara NUNCA se guarda: solo un vector pseudónimo (128 floats face-api, no
// reversible a imagen) + la imagen del gemelo sintético ya anonimizado. En cada
// pase se busca el vecino más cercano (distancia euclídea); si cae bajo umbral,
// es la MISMA persona → se reusa su gemelo (re-identificado entre cámaras/visitas).
// AVISO RGPD: un embedding re-identificable es un dato biométrico → esto es
// PSEUDONIMIZACIÓN (no anonimato total): exige consentimiento/señalética,
// hash salado y retención corta antes de producción.
const TWIN_REG_KEY = 'twin:registry';
const TWIN_THRESHOLD = 0.5; // face-api: distancia < ~0.5 ≈ misma persona

function twinDist(a, b) {
  let s = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
async function twinLoadReg(env) {
  try { return JSON.parse((await env.SIGNAGE_KV.get(TWIN_REG_KEY)) || '[]'); } catch { return []; }
}
async function twinSaveReg(env, reg) {
  await env.SIGNAGE_KV.put(TWIN_REG_KEY, JSON.stringify(reg.slice(-500))); // cap demo
}
function twinValidVec(v) { return Array.isArray(v) && v.length >= 64 && v.every(x => Number.isFinite(+x)); }

// POST /twin/match { embedding:[128], threshold? } → {matched, id?, seen?, dist?, twinImage?}
async function twinMatchHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const vec = twinValidVec(b.embedding) ? b.embedding.map(Number) : null;
  if (!vec) return json({ error: 'bad-embedding' }, { status: 400 });
  const thr = Number(b.threshold) > 0 ? Number(b.threshold) : TWIN_THRESHOLD;
  const reg = await twinLoadReg(env);
  let best = null, bestD = Infinity;
  for (const e of reg) { if (!Array.isArray(e.vec)) continue; const d = twinDist(vec, e.vec); if (d < bestD) { bestD = d; best = e; } }
  if (best && bestD <= thr) {
    best.seen = (best.seen || 1) + 1; best.ts = Date.now();
    await twinSaveReg(env, reg);
    let img = null; try { img = await env.SIGNAGE_KV.get('twin:img:' + best.id); } catch (e) {}
    return json({ matched: true, id: best.id, seen: best.seen, dist: +bestD.toFixed(3), twinImage: img || null });
  }
  return json({ matched: false, dist: best ? +bestD.toFixed(3) : null, count: reg.length });
}

// POST /twin/save { embedding:[128], twinImage(dataURL)? } → {id} (acuña gemelo nuevo)
async function twinSaveHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const vec = twinValidVec(b.embedding) ? b.embedding.map(Number) : null;
  if (!vec) return json({ error: 'bad-embedding' }, { status: 400 });
  const id = 'tw_' + crypto.randomUUID().slice(0, 8);
  const reg = await twinLoadReg(env);
  reg.push({ id, vec, seen: 1, ts: Date.now() });
  await twinSaveReg(env, reg);
  if (b.twinImage) { try { await env.SIGNAGE_KV.put('twin:img:' + id, String(b.twinImage).slice(0, 2000000), { expirationTtl: 60 * 60 * 24 * 30 }); } catch (e) {} }
  return json({ ok: true, id, count: reg.length });
}

// GET /twin/list → metadatos sin vectores ni imágenes (debug/demo)
async function twinListHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const reg = await twinLoadReg(env);
  return json({ count: reg.length, twins: reg.map(e => ({ id: e.id, seen: e.seen, ts: e.ts, dims: (e.vec || []).length })) });
}

// POST /twin/reset → vacía el registro (solo demo)
async function twinResetHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const reg = await twinLoadReg(env);
  for (const e of reg) { try { await env.SIGNAGE_KV.delete('twin:img:' + e.id); } catch (x) {} }
  await env.SIGNAGE_KV.put(TWIN_REG_KEY, '[]');
  return json({ ok: true, cleared: reg.length });
}

// ─── Cola "Enviar a la tienda": NPCs sprite que el gemelo spawnea andando ───
// El Anonimizador encola un sprite 8-bit (dataURL pequeño) y el gemelo sondea
// /twin/spawn/pending?since=<ts> y mete ese NPC en la tienda.
const NPC_QUEUE_KEY = 'twin:spawn:queue';
async function npcSpawnHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const img = String(b.image || '');
  if (!/^data:image\//.test(img)) return json({ error: 'bad-image' }, { status: 400 });
  if (img.length > 1500000) return json({ error: 'image-too-big' }, { status: 413 });
  const id = 'npc_' + crypto.randomUUID().slice(0, 8);
  // name puede traer la AUDIENCIA empaquetada ("Anónimo||{json sex/age/desc}") → 300
  // chars para que el JSON del segmento NO se trunque (antes 40 lo partía).
  const entry = { id, img, ts: Date.now(), name: String(b.name || '').slice(0, 300), screen: String(b.screen || '').slice(0, 40) };
  let q; try { q = JSON.parse((await env.SIGNAGE_KV.get(NPC_QUEUE_KEY)) || '[]'); } catch { q = []; }
  q.push(entry); q = q.slice(-30); // cap defensivo
  await env.SIGNAGE_KV.put(NPC_QUEUE_KEY, JSON.stringify(q));
  return json({ ok: true, id, count: q.length });
}
async function npcPendingHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const since = Number(url.searchParams.get('since') || 0);
  const screen = String(url.searchParams.get('screen') || '');
  let q; try { q = JSON.parse((await env.SIGNAGE_KV.get(NPC_QUEUE_KEY)) || '[]'); } catch { q = []; }
  const pending = q.filter(e => (e.ts || 0) > since && (!e.screen || !screen || e.screen === screen));
  return json({ ok: true, pending, now: Date.now() });
}
async function npcClearHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let q; try { q = JSON.parse((await env.SIGNAGE_KV.get(NPC_QUEUE_KEY)) || '[]'); } catch { q = []; }
  await env.SIGNAGE_KV.put(NPC_QUEUE_KEY, '[]');
  return json({ ok: true, cleared: q.length });
}

// ─── Ack de recogida ──────────────────────────────────────────────
// El gemelo confirma (POST /twin/spawn/ack) cuando spawnea el NPC y lo mete
// paseando por la tienda. Guardamos un sello por id (TTL 1 h) que el Anonimizador
// sondea (GET /twin/spawn/status?id=) para saber que el NPC YA está en la tienda
// — no solo encolado. Idempotente: si varios gemelos lo recogen, basta el primero.
const NPC_ACK_PREFIX = 'twin:ack:';
async function npcAckHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const id = String(b.id || '').slice(0, 40);
  if (!/^npc_[a-z0-9-]{4,}$/i.test(id)) return json({ error: 'bad-id' }, { status: 400 });
  const screen = String(b.screen || '').slice(0, 40);
  await env.SIGNAGE_KV.put(NPC_ACK_PREFIX + id, JSON.stringify({ at: Date.now(), screen }), { expirationTtl: 3600 });
  return json({ ok: true });
}
async function npcStatusHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const id = String(url.searchParams.get('id') || '').slice(0, 40);
  if (!id) return json({ error: 'bad-id' }, { status: 400 });
  let a = null; try { a = JSON.parse((await env.SIGNAGE_KV.get(NPC_ACK_PREFIX + id)) || 'null'); } catch { a = null; }
  return json({ ok: true, consumed: !!a, at: (a && a.at) || null, screen: (a && a.screen) || null });
}

// ─── Proxy de imágenes externas para el editor de pixeria ──────────
// GET /image/proxy?url=<encoded>  → baja la imagen del lado servidor y la
// re-emite con Access-Control-Allow-Origin:* para que el editor de Assets
// pueda leer sus píxeles en canvas sin "tainting" CORS (importar de otra web
// para retocar o guardar en Stock). Guardas SSRF: solo http(s), no IPs/hosts
// internos. Tope de tamaño y obligación de content-type imagen.
function isBlockedHost(host) {
  const h = (host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true; // loopback/ULA/link-local IPv6
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;            // link-local + metadata 169.254.169.254
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true;                          // multicast/reservado
  }
  return false;
}
async function imageProxyHandler(req) {
  const u = new URL(req.url).searchParams.get('url') || '';
  let target;
  try { target = new URL(u); } catch { return json({ error: 'bad-url' }, { status: 400 }); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return json({ error: 'bad-protocol' }, { status: 400 });
  if (isBlockedHost(target.hostname)) return json({ error: 'blocked-host' }, { status: 403 });
  let r;
  try {
    r = await fetch(target.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PixeriaImportBot/1.0)', 'Accept': 'image/*,*/*;q=0.8' },
    });
  } catch (e) { return json({ error: 'fetch-failed', detail: String(e).slice(0, 200) }, { status: 502 }); }
  if (!r.ok) return json({ error: 'upstream-' + r.status }, { status: 502 });
  const ct = r.headers.get('Content-Type') || '';
  if (!/^image\//i.test(ct)) return json({ error: 'not-an-image', contentType: ct.slice(0, 80) }, { status: 415 });
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 25 * 1024 * 1024) return json({ error: 'too-big', max: 25 * 1024 * 1024 }, { status: 413 });
  return new Response(buf, {
    headers: {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
      'X-Proxy-Source': target.hostname,
    },
  });
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

// ─── /signage/shot — CAPTURA REAL de pantalla del player (fase 2) ─────────
// El canal (admira.tv/canal.html) es PÚBLICO → no puede llevar token secreto.
// Por eso SIN auth pero con validación FUERTE + rate-limit:
//   POST { screen, img:"data:image/jpeg;base64,…" }
//     · img DEBE empezar por data:image/jpeg;base64,
//     · tamaño decodificado ≤ 150 KB
//     · screen = slug corto no vacío
//     · rate-limit ~1 subida / 8 s por screen (429 si va demasiado seguido)
//     → R2 StockBucket key shots/<screen>.jpg (sobrescribe) + KV shotmeta:<screen> {ts,bytes}
//     → { ok:true, ts }
//   GET ?screen=X         → image/jpeg directa (Cache-Control:no-store, CORS). 404 {ok:false,reason:"no_shot"} si no hay.
//   GET ?screen=X&meta=1  → { ok, ts, ageSeconds, bytes } (JSON, sin descargar la imagen)
const SHOT_MAX_BYTES = 150 * 1024;          // 150 KB decodificado
const SHOT_MIN_INTERVAL_MS = 8000;          // 1 subida / 8 s por screen
const SHOT_PREFIX = 'data:image/jpeg;base64,';
const SHOT_SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Bytes reales que codifica un base64 (sin decodificarlo), para validar tamaño barato.
function b64DecodedLen(b64) {
  const len = b64.length;
  if (len < 4) return 0;
  let pad = 0;
  if (b64[len - 1] === '=') pad++;
  if (b64[len - 2] === '=') pad++;
  return Math.floor(len * 3 / 4) - pad;
}

async function signageShotPostHandler(req, env) {
  if (!env.STOCK_BUCKET || !env.SIGNAGE_KV) return json({ ok: false, reason: 'storage-not-bound' }, { status: 500 });
  let body = {};
  try { body = await req.json(); } catch { return json({ ok: false, reason: 'bad-json' }, { status: 400 }); }
  const screen = String(body.screen || '').trim();
  const img = String(body.img || '');
  if (!SHOT_SLUG_RE.test(screen)) return json({ ok: false, reason: 'bad-screen' }, { status: 400 });
  if (!img.startsWith(SHOT_PREFIX)) return json({ ok: false, reason: 'bad-mime', expected: SHOT_PREFIX }, { status: 400 });
  const b64 = img.slice(SHOT_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return json({ ok: false, reason: 'bad-base64' }, { status: 400 });
  const bytes = b64DecodedLen(b64);
  if (bytes <= 0) return json({ ok: false, reason: 'empty' }, { status: 400 });
  if (bytes > SHOT_MAX_BYTES) return json({ ok: false, reason: 'too-large', bytes, max: SHOT_MAX_BYTES }, { status: 413 });

  // Rate-limit por screen (KV shotmeta:<screen>.ts). KV es eventualmente
  // consistente, pero para 1/8s basta: bloquea ráfagas del mismo player.
  const metaKey = `shotmeta:${screen}`;
  const now = Date.now();
  let prev = null;
  try { prev = await env.SIGNAGE_KV.get(metaKey, 'json'); } catch {}
  if (prev && prev.ts && (now - prev.ts) < SHOT_MIN_INTERVAL_MS) {
    return json({ ok: false, reason: 'rate-limited', retryMs: SHOT_MIN_INTERVAL_MS - (now - prev.ts) }, { status: 429 });
  }

  // Decodifica base64 → bytes reales para R2.
  let raw;
  try {
    const bin = atob(b64);
    raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  } catch { return json({ ok: false, reason: 'decode-failed' }, { status: 400 }); }

  await env.STOCK_BUCKET.put(`shots/${screen}.jpg`, raw, {
    httpMetadata: { contentType: 'image/jpeg', cacheControl: 'no-store' },
  });
  await env.SIGNAGE_KV.put(metaKey, JSON.stringify({ ts: now, bytes }), { expirationTtl: 604800 });
  return json({ ok: true, ts: now });
}

async function signageShotGetHandler(req, env, url) {
  if (!env.STOCK_BUCKET || !env.SIGNAGE_KV) return json({ ok: false, reason: 'storage-not-bound' }, { status: 500 });
  const screen = String(url.searchParams.get('screen') || '').trim();
  if (!SHOT_SLUG_RE.test(screen)) return json({ ok: false, reason: 'bad-screen' }, { status: 400 });

  if (url.searchParams.get('meta') === '1') {
    let meta = null;
    try { meta = await env.SIGNAGE_KV.get(`shotmeta:${screen}`, 'json'); } catch {}
    if (!meta || !meta.ts) return json({ ok: false, reason: 'no_shot' }, { status: 404 });
    return json({ ok: true, ts: meta.ts, ageSeconds: Math.round((Date.now() - meta.ts) / 1000), bytes: meta.bytes || 0 });
  }

  const obj = await env.STOCK_BUCKET.get(`shots/${screen}.jpg`);
  if (!obj) return json({ ok: false, reason: 'no_shot' }, { status: 404 });
  const headers = new Headers();
  headers.set('Content-Type', 'image/jpeg');
  headers.set('Cache-Control', 'no-store');
  // ACAO:* para que el panel/canal pueda pintar la captura en <canvas> sin
  // "tintarlo". El wrapper global respeta un ACAO:* puesto a propósito.
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(obj.body, { status: 200, headers });
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
// Reparto del gasto POR PREFIJO de clave. El contador global decia CUANTO se
// gastaba pero no QUIEN: el 5-ago-2026 el tope se agoto a media tarde y hubo que
// deducir el culpable a ojo — y la primera deduccion fue equivocada. Esto lo
// mide. Una escritura mas al dia por prefijo, a cambio de no volver a adivinar.
function kvPrefijo(key) {
  const k = String(key || '');
  const i = k.indexOf(':');
  return i > 0 ? k.slice(0, i) : (k.split('/')[0] || 'otros');
}
async function contarGastoPorPrefijo(env, key, now) {
  try {
    const dia = new Date(now).toISOString().slice(0, 10);
    const ckey = 'kvgasto:' + dia;
    const m = JSON.parse((await env.SIGNAGE_KV.get(ckey)) || '{}');
    const p = kvPrefijo(key);
    m[p] = (m[p] || 0) + 1;
    await env.SIGNAGE_KV.put(ckey, JSON.stringify(m), { expirationTtl: 60 * 60 * 24 * 8 });
  } catch {}
}

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
        // IMPORTANTE: AWAIT el envío antes de marcar el flag. Antes se lanzaba
        // fire-and-forget (sendTelegram(...).catch()) SIN ctx.waitUntil — pero
        // reserveKvWrite no recibe ctx, así que al devolver la Response el
        // runtime de Workers cancelaba el fetch a Telegram a medio vuelo. El
        // flag "warned" ya quedaba persistido → nunca reintentaba → el aviso
        // del 80% no llegaba (esto pasó hoy con el runaway). sendTelegram/
        // sendTelegramVia no lanzan (try/catch interno + no-op sin token), así
        // que awaitear es seguro y el flag se marca después pase lo que pase.
        await sendTelegram(env, `⚠️ <b>KV writes al 80%</b> — ${used}/${cap} hoy (tope diario del cortacircuitos). Al llegar a ${cap} se pausan hasta el reset (00:00 UTC). Si es por escala real, sube <code>KV_DAILY_WRITE_CAP</code>; si no, revisa qué dispara escrituras.`);
        await env.SIGNAGE_KV.put(wkey, '1', { expirationTtl: 172800 });
      }
    } catch {}
  }
  try { await env.SIGNAGE_KV.put(key, String(used + 2), { expirationTtl: 172800 }); } catch {}
  return true;
}
// Causa por la que reserveKvWrite acaba de devolver false, para que la respuesta
// no mienta: durante el incidente del 2026-07-08 el kill-switch KV_WRITES_OFF
// se reportó como throttled:'budget' con el contador diario a 72, y el
// diagnóstico salió por el camino equivocado. Síncrono a propósito: kill-switch
// y binding se leen de env, y si no es ninguno de los dos la única causa
// restante en reserveKvWrite es el tope diario.
function kvWriteDenyReason(env) {
  if (String(env.KV_WRITES_OFF || '') === '1') return 'kill-switch';
  if (!env.SIGNAGE_KV) return 'kv-not-bound';
  return 'budget';
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
    // loc/locName PEGAJOSOS (sticky): un heartbeat sin loc explícito NO debe
    // blanquear la asignación de /signage/assign. Solo un body con loc/locName
    // no-vacío puede cambiarlos; si el beat no los trae, conservamos el previo.
    // Retrocompatible: players viejos (role xtore-game) que no mandan loc dejan
    // de deshacer las asignaciones en su siguiente latido.
    if (!data.loc && prev && prev.loc) data.loc = prev.loc;
    if (!data.locName && prev && prev.locName) data.locName = prev.locName;
    const changed = !prev || prev.showing_id !== data.showing_id ||
                    prev.role !== data.role || prev.version !== data.version ||
                    prev.loc !== data.loc;
    const stale = !prev || (now - (prev.last_seen || 0)) >= HB_REFRESH_MS;
    if (!changed && !stale) {
      return json({ ok: true, last_seen: prev.last_seen, throttled: 'unchanged' });
    }
    if (!(await reserveKvWrite(env, now))) {
      return json({ ok: true, last_seen: now, throttled: kvWriteDenyReason(env) });
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

// ─── Monitor de salud de pantallas ────────────────────────────────────────
// Avisa por Telegram cuando una pantalla que estaba emitiendo deja de reportar
// (>SIGNAGE_STALE_MS). Detecta el tótem del iPhone pausado por iOS en segundo
// plano y cualquier kiosko caído. Guarda el estado previo en KV para alertar solo
// en la TRANSICIÓN (online→muda y muda→recuperada), sin spam. Corre en el cron.
const SIGNAGE_HEALTH_KEY = 'signage:health:state';
const SIGNAGE_STALE_MS = 4 * 60 * 1000;   // muda si no reporta hace > 4 min
async function signageHealthMonitor(env) {
  if (!env.SIGNAGE_KV) return;
  let index = [];
  try { index = JSON.parse(await env.SIGNAGE_KV.get(SCREENS_INDEX)) || []; } catch {}
  const now = Date.now();
  const cur = {};
  for (const s of index) {
    try {
      const raw = await env.SIGNAGE_KV.get(`screen:${s}`);
      if (!raw) { cur[s] = { online: false, loc: '', machine: '', name: s }; continue; }
      const d = JSON.parse(raw);
      cur[s] = {
        online: (now - (d.last_seen || 0)) < SIGNAGE_STALE_MS,
        loc: d.loc || '', machine: d.machine || '', name: d.locName || s,
      };
    } catch { cur[s] = { online: false, loc: '', machine: '', name: s }; }
  }
  let prev = {};
  try { prev = JSON.parse(await env.SIGNAGE_KV.get(SIGNAGE_HEALTH_KEY)) || {}; } catch {}
  const down = [], up = [];
  for (const s of Object.keys(cur)) {
    const was = prev[s] && prev[s].online;
    const is = cur[s].online;
    if (was === true && !is) down.push(cur[s]);
    else if (was === false && is) up.push(cur[s]);
    // primera aparición (sin estado previo): no alerta → evita ruido de arranque
  }
  const tag = c => `• ${c.name}${c.loc ? ` (${c.loc})` : ''}${c.machine ? ` · ${c.machine}` : ''}`;
  if (down.length) {
    await sendTelegram(env, `🩺⚠️ Pantalla(s) de signage MUDAS (dejaron de emitir hace >4 min):\n${down.map(tag).join('\n')}\n\n¿Tótem iOS en segundo plano o kiosko caído? Panel: https://www.admira.live/control`);
  }
  if (up.length) {
    await sendTelegram(env, `🩺✅ Pantalla(s) de signage de vuelta emitiendo:\n${up.map(tag).join('\n')}`);
  }
  const save = {};
  for (const s of Object.keys(cur)) save[s] = { online: cur[s].online };
  try { await env.SIGNAGE_KV.put(SIGNAGE_HEALTH_KEY, JSON.stringify(save), { expirationTtl: 60 * 60 * 24 * 7 }); } catch {}
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

// Firma de IDENTIDAD del item: SOLO campos estables que definen "qué pieza es"
// (id/type/url y, si existe, dur). Se construye por allowlist para EXCLUIR
// explícitamente todo campo volátil — `ts` (keepalive), `aud` (audiencia en vivo
// de la cámara: faces/gender/age parpadean cada beat), `startedAt`, y cualquier
// otro que el emisor añada. Así un keepalive de la MISMA pieza no dispara write
// KV aunque la audiencia cambie; solo un cambio real de pieza (id/type/url/dur)
// mueve la firma. La audiencia sigue viajando en el payload guardado (item), solo
// queda fuera de la FIRMA de cambio. Este fix corta el runaway de escrituras KV.
const NOW_SIG_FIELDS = ['id', 'type', 'url', 'dur'];
function nowItemSig(item) {
  if (!item || typeof item !== 'object') return '';
  const it = {};
  for (const k of NOW_SIG_FIELDS) {
    if (item[k] !== undefined && item[k] !== null) it[k] = item[k];
  }
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
  return json({ ok: true, screen, item: item || null, ip: (stored && stored.__ip) || null, lastSeen: (stored && stored.__w) || null });
}

// EMISIÓN VISIBLE — cuando /signage/now trae loc/locName (el player de canal.html
// ya sabe su circuito), reflejamos la pantalla en el MISMO registro screen:<id>
// que escribe el heartbeat de signage.html y que sirve /signage/screens. Así el
// player de canal aparece en la vista viva unificada "qué equipo emite qué ahora"
// sin necesitar un heartbeat aparte. Reutiliza la ruta de código del heartbeat
// (change-detection + reserveKvWrite + índice). Retrocompatible: sin loc/locName
// es un no-op y el POST sigue comportándose exactamente igual que antes.
async function nowUpsertScreenLoc(env, screen, body, item, now, req) {
  const loc = (body && body.loc || '').toString().slice(0, 60);
  const locName = (body && body.locName || '').toString().slice(0, 80);
  const machine = (body && body.machine || '').toString().slice(0, 60);
  if (!loc && !locName && !machine) return;     // sin loc/machine → no tocamos el registro
  let prev = null;
  try { prev = JSON.parse(await env.SIGNAGE_KV.get(`screen:${screen}`)); } catch {}
  const data = Object.assign({}, prev || {}, {
    screen,
    last_seen: now,
    user_agent: ((req && req.headers.get('User-Agent')) || (prev && prev.user_agent) || '').slice(0, 200),
    showing_id: (item && item.id) || (prev && prev.showing_id) || null,
    role: (body.role || (prev && prev.role) || 'canal').toString().slice(0, 40),
    version: (body.version || (prev && prev.version) || '').toString().slice(0, 40),
    loc,
    locName,
    // id del equipo donde corre el player → admira.live/control mapea pantalla↔máquina.
    machine: machine || (prev && prev.machine) || '',
  });
  const changed = !prev || prev.loc !== loc || prev.locName !== locName || prev.machine !== data.machine || prev.showing_id !== data.showing_id;
  const stale = !prev || (now - (prev.last_seen || 0)) >= HB_REFRESH_MS;
  if (!changed && !stale) return;               // igual y reciente → no gastamos KV
  if (!(await reserveKvWrite(env, now))) return;
  try {
    await env.SIGNAGE_KV.put(`screen:${screen}`, JSON.stringify(data), { expirationTtl: SCREEN_TTL });
    let index = [];
    try { index = JSON.parse(await env.SIGNAGE_KV.get(SCREENS_INDEX)) || []; } catch {}
    if (!index.includes(screen)) {
      index.push(screen);
      if (index.length > 100) index = index.slice(-100);
      if (await reserveKvWrite(env, now)) await env.SIGNAGE_KV.put(SCREENS_INDEX, JSON.stringify(index));
    }
  } catch {}
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
    return json({ ok: true, screen, throttled: kvWriteDenyReason(env) });
  }
  try {
    await env.SIGNAGE_KV.put(`now:${screen}`, JSON.stringify({ item, __w: now, __sig: sig, __ip: (req.headers.get('CF-Connecting-IP') || req.headers.get('x-real-ip') || '').slice(0, 60) }), { expirationTtl: SIGNAGE_NOW_TTL });
  } catch (e) {
    return json({ ok: true, throttled: true, reason: String(e).slice(0, 120) });
  }
  // Emisión visible: si el POST trae loc/locName, refleja la pantalla en el
  // registro screen:<id> que sirve /signage/screens. No rompe el POST si falla.
  try { await nowUpsertScreenLoc(env, screen, body, item, now, req); } catch {}
  return json({ ok: true, screen, loc: (body.loc || '').toString().slice(0, 60) || null });
}

// ─── /signage/assign — cablear un player huérfano a su circuito (tarea #4) ──
// POST { key, screen, loc, locName? } → fija loc/locName en el registro
// screen:<id> SIN falsear una emisión (no toca el puntero now:). Reutiliza
// nowUpsertScreenLoc (lee-modifica-escribe sobre el registro existente), así el
// player huérfano aparece en la vista viva "EN EMISIÓN — AHORA" con su circuito.
// Mismo patrón de auth que /grid/book (GRID_KEY). Idempotente y retrocompatible:
// si el registro ya tiene ese loc y es reciente, es un no-op (sin gasto de KV).
async function signageAssignHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!gridKeyOk(env, b)) return json({ error: env.GRID_KEY ? 'bad-key' : 'grid-key-not-configured' }, { status: env.GRID_KEY ? 403 : 503 });
  const screen = String(b.screen || '').slice(0, 60);
  if (!/^[a-z0-9_-]+$/i.test(screen)) return json({ error: 'bad-screen' }, { status: 400 });
  const loc = (b.loc || '').toString().slice(0, 60);
  const locName = (b.locName || '').toString().slice(0, 80);
  if (!loc && !locName) return json({ error: 'missing-loc' }, { status: 400 });
  // Sólo tiene sentido cablear un player que ya existe en el registro (huérfano).
  // Si no existe screen:<id>, nowUpsertScreenLoc lo crea igualmente (merge sobre {}),
  // lo cual es aceptable: fija identidad para cuando ese player empiece a latir.
  const now = Date.now();
  try { await nowUpsertScreenLoc(env, screen, b, null, now, req); } catch (e) {
    return json({ ok: false, error: 'assign-failed', detail: String(e).slice(0, 120) }, { status: 502 });
  }
  let rec = null; try { rec = JSON.parse(await env.SIGNAGE_KV.get(`screen:${screen}`)); } catch {}
  return json({ ok: true, screen, loc, locName, record: rec });
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
// la descarga en el proxy del Mac Mini (Tailscale Funnel /admira → 127.0.0.1:9126).
// El path legado /pixtube quedó apuntando a otro servicio y no sirve para este flujo.
// El proxy
// descarga con yt-dlp y publica en /stock/publish, que ya notifica el resultado.
// El token del bot nunca sale del worker.
// Se puede sobreescribir con el secret ADMIRA_TUBE_BASE (sin redesplegar código).
const ADMIRA_TUBE_BASE_DEFAULT = 'https://macmini.tail48b61c.ts.net/admira';
function admiraTubeBaseCandidates(env) {
  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    const v = String(value || '').trim().replace(/\/+$/, '');
    if (!v || seen.has(v)) return;
    seen.add(v);
    candidates.push(v);
  };
  push(env.ADMIRA_TUBE_BASE);
  push(ADMIRA_TUBE_BASE_DEFAULT);
  return candidates;
}
async function tgSend(env, chatId, html) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    // Devuelve el message_id para poder EDITAR después ese mismo mensaje. Sin esto no
    // hay forma de enseñar progreso: sólo acumular mensajes nuevos.
    const d = await r.json().catch(() => null);
    if (!d || !d.ok) console.log(`[tg] sendMessage RECHAZADO chat=${chatId} -> ${d ? JSON.stringify(d).slice(0, 300) : 'sin cuerpo'}`);
    return d && d.ok && d.result ? d.result.message_id : null;
  } catch (e) { console.log(`[tg] sendMessage EXCEPCION: ${String(e).slice(0, 200)}`); return null; }
}
// Reescribe un mensaje ya enviado. Es lo que convierte «te aviso al publicar» —una
// promesa muda— en un parte que se va actualizando solo. (Carlos, 6-ago-2026: «¿por qué
// no ponemos algo que demuestre progreso?».) Un fallo al editar no puede tumbar la
// importación: se traga y se sigue.
const TG_PENDIENTE_PREFIJO = 'tg-pendiente:';
async function tgEncolarAviso(env, chatId, plano, esperaSeg) {
  if (!env.SIGNAGE_KV) return false;
  try {
    const noAntesDe = Date.now() + Math.max(30, Number(esperaSeg) || 60) * 1000;
    await env.SIGNAGE_KV.put(
      `${TG_PENDIENTE_PREFIJO}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      JSON.stringify({ chatId, text: plano, noAntesDe }),
      { expirationTtl: 60 * 60 * 24 },
    );
    console.log(`[tg] aviso ENCOLADO para chat=${chatId}, reintento en ${Math.round((noAntesDe - Date.now()) / 1000)}s`);
    return true;
  } catch (e) { console.log(`[tg] no se pudo encolar: ${String(e).slice(0, 160)}`); return false; }
}
// La recorre el cron de 2 min: en cuanto Telegram acepta, sale todo lo retenido.
async function tgEntregarPendientes(env) {
  if (!env.SIGNAGE_KV || !env.TELEGRAM_BOT_TOKEN) return;
  let listado;
  try { listado = await env.SIGNAGE_KV.list({ prefix: TG_PENDIENTE_PREFIJO, limit: 30 }); } catch { return; }
  for (const clave of (listado && listado.keys) || []) {
    let aviso;
    try { aviso = await env.SIGNAGE_KV.get(clave.name, { type: 'json' }); } catch { continue; }
    if (!aviso) { await env.SIGNAGE_KV.delete(clave.name).catch(() => {}); continue; }
    if (Date.now() < Number(aviso.noAntesDe || 0)) continue;
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: aviso.chatId, text: aviso.text, disable_web_page_preview: true }),
      });
      const d = await r.json().catch(() => null);
      if (d && d.ok) {
        await env.SIGNAGE_KV.delete(clave.name).catch(() => {});
        console.log(`[tg] pendiente ENTREGADO a chat=${aviso.chatId}`);
        continue;
      }
      if (d && d.error_code === 429) {
        // Sigue castigado: se reprograma con lo que ellos mismos piden y se para aquí,
        // para no gastar el resto de la cola contra un muro.
        const espera = Number((d.parameters && d.parameters.retry_after) || 60);
        aviso.noAntesDe = Date.now() + (espera + 5) * 1000;
        await env.SIGNAGE_KV.put(clave.name, JSON.stringify(aviso), { expirationTtl: 60 * 60 * 24 }).catch(() => {});
        console.log(`[tg] pendientes siguen bloqueados, reintento en ${espera}s`);
        return;
      }
      await env.SIGNAGE_KV.delete(clave.name).catch(() => {});   // rechazo no recuperable
    } catch { /* se reintenta en la próxima vuelta */ }
  }
}
// Destino de los avisos: el chat fijado con /avisosaqui, o el de origen si no hay ninguno.
async function tgChatDeAvisos(env, chatOrigen) {
  try {
    const guardado = env.SIGNAGE_KV ? await env.SIGNAGE_KV.get('stock-avisos-chat', { type: 'json' }) : null;
    return guardado && guardado.chatId ? guardado.chatId : chatOrigen;
  } catch { return chatOrigen; }
}
async function tgAvisoSeguro(env, chatId, messageId, html, plano) {
  const edit = messageId ? await tgEdit(env, chatId, messageId, html) : false;
  if (edit === true) return 'editado';
  // Si Telegram ya ha pedido frenar, los dos intentos siguientes solo servirían para
  // alargar el castigo del chat. Se pierde ESTE aviso, no la próxima hora.
  if (edit === 'rate') {
    await tgEncolarAviso(env, chatId, plano, 90);
    return 'rate-limited-encolado';
  }
  if (await tgSend(env, chatId, html)) return 'enviado-html';
  // Sin parse_mode no hay entidades que parsear: si esto tampoco llega, el problema
  // no es el formato.
  if (!env.TELEGRAM_BOT_TOKEN) return 'sin-token';
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: plano, disable_web_page_preview: true }),
    });
    const d = await r.json().catch(() => null);
    if (d && d.ok) return 'enviado-plano';
    console.log(`[tg] texto plano RECHAZADO chat=${chatId} -> ${d ? JSON.stringify(d).slice(0, 300) : 'sin cuerpo'}`);
    if (d && d.error_code === 429) {
      await tgEncolarAviso(env, chatId, plano, Number((d.parameters && d.parameters.retry_after) || 90));
      return 'encolado';
    }
  } catch (e) { console.log(`[tg] texto plano EXCEPCION: ${String(e).slice(0, 200)}`); }
  return 'fallido';
}
async function tgEdit(env, chatId, messageId, html) {
  if (!env.TELEGRAM_BOT_TOKEN || !messageId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const d = await r.json().catch(() => null);
    if (d && d.ok) return true;
    console.log(`[tg] editMessageText RECHAZADO chat=${chatId} msg=${messageId} -> ${d ? JSON.stringify(d).slice(0, 300) : 'sin cuerpo'}`);
    // 429 = Telegram pide parar. Devuelve 'rate' para que quien llama DEJE de escribir
    // en vez de insistir: insistir es lo que convierte un frenazo en un castigo de horas.
    if (d && d.error_code === 429) return 'rate';
    return false;
  } catch (e) { console.log(`[tg] editMessageText EXCEPCION: ${String(e).slice(0, 200)}`); return false; }
}
function thumbnailForImportLink(link, format) {
  const raw = String(link || '');
  const yt = raw.match(/(?:youtube\.com\/.*[?&]v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/i);
  if (yt) return `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg`;
  try {
    const u = new URL(raw);
    if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:$|\?)/i.test(u.pathname)) return raw;
  } catch {}
  return format === 'audio' ? '' : null;
}
async function saveTelegramImportFailure(env, data) {
  if (!env.STOCK_BUCKET) return null;
  const ts = Date.now();
  const id = `link-${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const link = String(data.link || '').slice(0, 2000);
  const detail = data.detail ? String(data.detail).slice(0, 1200) : null;
  const comment = [
    data.comment ? String(data.comment).slice(0, 800) : '',
    detail ? `Fallo importación: ${detail}` : '',
  ].filter(Boolean).join('\n');
  const rec = {
    id,
    type: 'link',
    motor: 'Telegram Import',
    prompt: link,
    title: data.host ? `Enlace pendiente · ${String(data.host).slice(0, 120)}` : 'Enlace pendiente',
    comment: comment || null,
    tags: ['enlace', 'pendiente'],
    quality: 'good',
    audience: 'all',
    category: 'enlace',
    costEst: 'no importado',
    mime: 'text/uri-list',
    ext: 'url',
    size: 0,
    thumbnail: thumbnailForImportLink(link, data.format),
    url: link,
    createdAt: new Date(ts).toISOString(),
    source: 'telegram',
    state: 'failed',
    phase: String(data.phase || 'unknown').slice(0, 80),
    format: String(data.format || '').slice(0, 20) || null,
    host: data.host ? String(data.host).slice(0, 200) : null,
    detail,
    chatId: data.chatId ? String(data.chatId).slice(0, 80) : null,
  };
  await env.STOCK_BUCKET.put(`stock/${id}/meta.json`, JSON.stringify(rec), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });
  await rebuildStockIndex(env);
  return rec;
}
// Lee las etiquetas og: de una página para saber si detrás hay un VÍDEO o una IMAGEN.
// Solo se llama con enlaces ambiguos (sin extensión y en un host que no es de vídeo), así
// que no penaliza el caso normal. Nace de esto: un post de LinkedIn con un gráfico se
// mandaba a yt-dlp por defecto y moría con "Unable to extract video" — no había vídeo.
async function sniffOpenGraph(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AdmiraBot/1.0; +https://www.pixeria.com)', 'Accept': 'text/html' },
      redirect: 'follow',
    });
    if (!r.ok) return { image: null, video: false };
    const html = (await r.text()).slice(0, 400000);
    const meta = (prop) => {
      const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)', 'i');
      const m = html.match(re);
      return m ? m[1].replace(/&amp;/g, '&') : null;
    };
    const image = meta('og:image') || meta('twitter:image');
    const video = !!(meta('og:video') || meta('og:video:url') || meta('og:video:secure_url') || meta('twitter:player'));
    return { image, video };
  } catch (e) { return { image: null, video: false }; }
}
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function monitorTubeImport(env, chatId, base, jobId, link, meta = {}, progressId = null) {
  const deadline = Date.now() + (9 * 60 * 1000);
  const arranque = Date.now();
  let notFoundCount = 0;
  let ultimoParte = 0, textoParte = '', partesEnPausa = false;
  // El parte se reescribe sobre el MISMO mensaje cada 12 s. Sirve para dos cosas: que se
  // vea que aquello avanza, y que si el seguimiento muere el mensaje quede CONGELADO en el
  // último paso alcanzado — que es exactamente donde hay que mirar. (Carlos, 6-ago-2026.)
  const parte = async (icono, texto, forzar = false) => {
    if (!progressId || partesEnPausa) return;
    // 20 s de verdad entre partes. La versión anterior comparaba con `>= 0` —siempre
    // cierto— y reescribía el mensaje CADA 3 s: Telegram lo tomó por spam y bloqueó el
    // chat 6.024 s. Un indicador de progreso que tumba el canal no informa de nada.
    if (!forzar && Date.now() - ultimoParte < 20000) return;
    const seg = Math.round((Date.now() - arranque) / 1000);
    const nuevo = `${icono} ${texto} · ${seg}s\n<code>${escHtml(link)}</code>`;
    if (nuevo === textoParte) return;   // editar con el mismo texto es otro 400 gratis
    ultimoParte = Date.now(); textoParte = nuevo;
    const r = await tgEdit(env, chatId, progressId, nuevo).catch(() => false);
    if (r === 'rate') { partesEnPausa = true; console.log('[tg] partes en pausa: Telegram pide frenar'); }
  };
  console.log(`[tube] monitor arranca job=${jobId} progressId=${progressId}`);
  while (Date.now() < deadline) {
    await sleepMs(3000);
    if (Date.now() - ultimoParte > 12000) { ultimoParte = Date.now(); }
    let r;
    try {
      r = await fetch(`${base}/tube/status?id=${encodeURIComponent(jobId)}`);
    } catch (e) {
      const saved = await saveTelegramImportFailure(env, { ...meta, chatId, link, phase: 'monitor-fetch', detail: String(e) }).catch(() => null);
      const savedLine = saved ? `\nGuardado en Enlaces: <code>${escHtml(saved.id)}</code>` : '';
      await tgSend(env, chatId, `🚨 Se perdió el seguimiento de la importación: <code>${escHtml(String(e).slice(0, 180))}</code>${savedLine}`);
      return;
    }
    if (r.status === 404) {
      notFoundCount += 1;
      if (notFoundCount >= 3) {
        const saved = await saveTelegramImportFailure(env, { ...meta, chatId, link, phase: 'monitor-not-found', detail: 'proxy status 404 repeated' }).catch(() => null);
        const savedLine = saved ? `\nGuardado en Enlaces: <code>${escHtml(saved.id)}</code>` : '';
        await tgSend(env, chatId, `⚠️ La importación quedó sin estado final en el proxy.\n<code>${escHtml(link)}</code>${savedLine}`);
        return 'failed';
      }
      continue;
    }
    notFoundCount = 0;
    let status;
    try { status = await r.json(); } catch { status = null; }
    const state = status && typeof status.state === 'string' ? status.state : '';
    console.log(`[tube] job=${jobId} state=${state}`);
    if (!state || state === 'running' || state === 'done' || state === 'publishing') {
      if (Date.now() - arranque > 6000) {
        if (state === 'publishing' || state === 'done') await parte('📤', 'Subiendo a Stock');
        else await parte('⏳', 'Descargando el vídeo');
      }
      continue;
    }
    // ANTES: `return` a secas. El bot prometía «te aviso al publicar en Stock» y NO
    // avisaba nunca — ni aquí ni en quien llama, que sólo miraba res.failed. El aviso de
    // éxito sencillamente no existía, así que toda importación correcta acababa en
    // silencio y parecía que el importador estaba roto. (Carlos, 6-ago-2026.)
    if (state === 'published') {
      console.log(`[tube] job=${jobId} PUBLICADO, avisando a chat=${chatId}`);
      await parte('✅', 'Publicado en Stock', true);
      return {
        published: true,
        title: status && status.title ? String(status.title) : '',
        size: status && Number(status.size) ? Number(status.size) : 0,
        assetUrl: status && status.assetUrl ? String(status.assetUrl) : '',
      };
    }
    const bits = [];
    if (status && status.error) bits.push(String(status.error));
    if (status && status.detail) bits.push(String(status.detail));
    if (status && status.stderr) bits.push(String(status.stderr));
    const detail = bits.join(' | ').slice(0, 260) || 'sin detalle';
    // NO se reporta aquí: yt-dlp falla cuando el enlace no tiene vídeo (un post con solo
    // imagen). Se devuelve el fallo para que el que llama intente rescatar la og:image; si
    // el rescate tampoco sale, es él quien avisa. Antes esto era un callejón sin salida.
    return { failed: true, state, detail };
  }
  const saved = await saveTelegramImportFailure(env, { ...meta, chatId, link, phase: 'monitor-timeout', detail: 'sin resultado tras 9 min' }).catch(() => null);
  const savedLine = saved ? `\nGuardado en Enlaces: <code>${escHtml(saved.id)}</code>` : '';
  await tgSend(env, chatId, `⚠️ La importación sigue sin resultado tras 9 min.\n<code>${escHtml(link)}</code>${savedLine}`);
}
// Detecta media ADJUNTA en un mensaje de Telegram (foto/vídeo/documento/animación/
// audio pegados directamente, NO por URL). Devuelve {kind, fileId, mime} o null.
// - photo: array de tamaños ordenado de menor a mayor → cogemos el ÚLTIMO (máx. resolución).
// - document: respeta su mime_type (una imagen enviada «como archivo» conserva calidad).
function pickTelegramMedia(msg) {
  if (!msg) return null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const big = msg.photo[msg.photo.length - 1];
    return { kind: 'image', fileId: big.file_id, mime: 'image/jpeg' };
  }
  if (msg.document && msg.document.file_id) {
    const mt = String(msg.document.mime_type || '').toLowerCase();
    const kind = mt.startsWith('video/') ? 'video' : mt.startsWith('audio/') ? 'audio' : 'image';
    return { kind, fileId: msg.document.file_id, mime: mt || 'application/octet-stream' };
  }
  if (msg.video && msg.video.file_id)     return { kind: 'video', fileId: msg.video.file_id, mime: msg.video.mime_type || 'video/mp4' };
  if (msg.animation && msg.animation.file_id) return { kind: 'video', fileId: msg.animation.file_id, mime: msg.animation.mime_type || 'video/mp4' };
  if (msg.audio && msg.audio.file_id)     return { kind: 'audio', fileId: msg.audio.file_id, mime: msg.audio.mime_type || 'audio/mpeg' };
  if (msg.voice && msg.voice.file_id)     return { kind: 'audio', fileId: msg.voice.file_id, mime: msg.voice.mime_type || 'audio/ogg' };
  return null;
}

// Descarga un adjunto de Telegram (getFile → file/bot<token>/<path>) y lo publica
// en el Stock reutilizando /stock/publish (auto-tags Gemini, R2, índice). Base64 en
// vez de sourceUrl para NO exponer el token del bot en la URL de origen.
// Límite de la Bot API para descargas: 20 MB (los vídeos grandes van por URL/yt-dlp).
async function handleTelegramAttachment(env, ctx, req, chatId, msg, media) {
  const emoji = media.kind === 'image' ? '🖼️' : media.kind === 'video' ? '🎬' : '🎵';
  const caption = (msg.caption || '').trim() || null;
  await tgSend(env, chatId, `📥 Importando ${media.kind === 'image' ? 'imagen' : media.kind === 'video' ? 'vídeo' : 'audio'} ${emoji} adjunto…\n<i>te aviso al publicar en Stock.</i>`);
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    const gf = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(media.fileId)}`);
    const gj = await gf.json().catch(() => null);
    if (!gf.ok || !gj || !gj.ok || !gj.result || !gj.result.file_path) {
      const detail = `getFile ${gf.status} ${gj && gj.description ? gj.description : ''}`.trim();
      await saveTelegramImportFailure(env, { chatId, link: '(adjunto)', format: media.kind, comment: caption, host: 'telegram', phase: 'attach-getfile', detail }).catch(() => null);
      await tgSend(env, chatId, `⚠️ No pude leer el archivo adjunto: <code>${escHtml(detail)}</code>`);
      return;
    }
    const filePath = gj.result.file_path;
    const dl = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!dl.ok) {
      const detail = `download ${dl.status}`;
      await saveTelegramImportFailure(env, { chatId, link: '(adjunto)', format: media.kind, comment: caption, host: 'telegram', phase: 'attach-download', detail }).catch(() => null);
      await tgSend(env, chatId, `⚠️ No pude descargar el adjunto de Telegram (${dl.status}).`);
      return;
    }
    const bytes = new Uint8Array(await dl.arrayBuffer());
    if (bytes.length > 190 * 1024 * 1024) {
      await tgSend(env, chatId, `⚠️ El adjunto pesa demasiado para el Stock (${(bytes.length/1024/1024).toFixed(1)} MB).`);
      return;
    }
    // mime: el de Telegram si es fiable, si no lo deducimos de la extensión del file_path.
    let mime = media.mime;
    if (!mime || mime === 'application/octet-stream') {
      const ext = (filePath.split('.').pop() || '').toLowerCase();
      mime = ({ jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif',
                mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm',
                mp3:'audio/mpeg', ogg:'audio/ogg', oga:'audio/ogg', wav:'audio/wav' })[ext] || mime || 'application/octet-stream';
    }
    const pubReq = new Request(new URL('/stock/publish', req.url).toString(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: media.kind, motor: 'Telegram Import', base64: bytesToB64(bytes), mime, comment: caption, title: caption ? caption.slice(0, 80) : null }),
    });
    const pr = await stockPublishHandler(pubReq, env, ctx); // notifica el éxito él mismo
    if (!pr.ok) {
      const t = await pr.text().catch(() => '');
      await saveTelegramImportFailure(env, { chatId, link: '(adjunto)', format: media.kind, comment: caption, host: 'telegram', phase: 'attach-publish', detail: `${pr.status} ${t}` }).catch(() => null);
      await tgSend(env, chatId, `⚠️ No pude publicar el adjunto (${pr.status}): <code>${escHtml(t.slice(0, 180))}</code>`);
    }
  } catch (e) {
    await saveTelegramImportFailure(env, { chatId, link: '(adjunto)', format: media.kind, comment: caption, host: 'telegram', phase: 'attach-exception', detail: String(e) }).catch(() => null);
    await tgSend(env, chatId, `🚨 Error importando el adjunto: <code>${escHtml(String(e).slice(0, 180))}</code>`);
  }
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
  const textoMando = String((msg.text || msg.caption || '')).trim();
  const deDuenno = !env.TELEGRAM_CHAT_ID || String((msg.from && msg.from.id) || '') === String(env.TELEGRAM_CHAT_ID);
  if (deDuenno && /^\/avisos(aqui|donde)\b/i.test(textoMando)) {
    const titulo = (msg.chat && (msg.chat.title || msg.chat.username || msg.chat.first_name)) || String(chatId);
    if (/^\/avisosaqui\b/i.test(textoMando)) {
      if (env.SIGNAGE_KV) await env.SIGNAGE_KV.put('stock-avisos-chat', JSON.stringify({ chatId, titulo, desde: new Date().toISOString() })).catch(() => {});
      await tgSend(env, chatId, `✅ Hecho. Los avisos de publicación en Stock llegarán a <b>${escHtml(titulo)}</b>.`);
    } else {
      const guardado = env.SIGNAGE_KV ? await env.SIGNAGE_KV.get('stock-avisos-chat', { type: 'json' }).catch(() => null) : null;
      await tgSend(env, chatId, guardado
        ? `📣 Los avisos de Stock van a <b>${escHtml(guardado.titulo || guardado.chatId)}</b>.`
        : '📣 No hay destino fijado: salen en el mismo chat desde el que se importa.');
    }
    return json({ ok: true });
  }
  // Se importa desde el chat autorizado de siempre O desde cualquier chat donde escriba
  // EL DUEÑO. Sin esto, el grupo Pixeria servía para recibir avisos pero no para pegar
  // enlaces —que es justo para lo que uno crea un grupo llamado Pixeria—: el enlace se
  // descartaba en silencio. Sigue mandando la identidad del AUTOR, no la del chat.
  if (env.TELEGRAM_CHAT_ID && chatId !== String(env.TELEGRAM_CHAT_ID) && !deDuenno) return json({ ok: true });
  // MEDIA ADJUNTA (foto/vídeo/documento pegado directo): antes solo se importaba
  // por URL, así que las imágenes —que se suelen ADJUNTAR, no enlazar— se perdían.
  // Se comprueba ANTES que el texto: un adjunto es una intención clara de importar.
  const media = pickTelegramMedia(msg);
  if (media) {
    ctx.waitUntil(handleTelegramAttachment(env, ctx, req, chatId, msg, media));
    return json({ ok: true });
  }
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return json({ ok: true });
  const m = text.match(/https?:\/\/[^\s]+/i);
  if (!m) {
    // AdmiraXPBot es solo para importaciones de Stock por URL. El CLI y los
    // buzones de Agora viven en /agora/hook con los bots/personas Matrix.
    return json({ ok: true });
  }
  const link = m[0].replace(/[).,]+$/, '');
  const comment = text.replace(m[0], '').replace(/\b(audio|mp3)\b/ig, '').trim() || null;
  // ¿Es una URL de imagen directa? Se mira la extensión del PATH (ignorando el
  // ?query, p.ej. council-leyendas.jpg?v=…). Si lo es, se publica como
  // type:image vía /stock/publish (que baja la sourceUrl del lado servidor),
  // NO por el proxy de vídeo yt-dlp — que la marcaría como vídeo y no saldría
  // en el filtro «Imágenes» del Stock.
  let host = '', imgName = '';
  let isImage = false;
  let imgSrc = link;   // la imagen REAL a bajar (puede venir de og:image, no del enlace)
  try {
    const lu = new URL(link);
    host = lu.hostname;
    // 1) extensión en el path (ignora ?query: "council.jpg?v=2" ya casa por el path)
    isImage = /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i.test(lu.pathname);
    // 2) extensión declarada en el query ("?format=jpg", "?ext=png") — CDNs sin ext en el path
    if (!isImage) isImage = /[?&](?:format|ext|type)=(?:jpe?g|png|gif|webp|avif|heic)\b/i.test(lu.search);
    // 3) sin extensión en el path pero el mensaje dice claramente que es imagen, y NO es
    //    un host de vídeo conocido → tratamos como imagen (antes caía a yt-dlp y se perdía).
    const noExt = !/\.[a-z0-9]{2,5}$/i.test(lu.pathname);
    const videoHost = /(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|dailymotion\.com)$/i.test(host);
    if (!isImage && noExt && !videoHost && /\b(imagen|image|foto|photo|png|jpe?g|webp)\b/i.test(text)) isImage = true;
    imgName = (lu.pathname.split('/').pop() || '').replace(/\.[^.]+$/, '');
  } catch {}

  if (isImage) {
    ctx.waitUntil((async () => {
      await tgSend(env, chatId, `📥 Importando imagen 🖼️ de <b>${escHtml(host)}</b>…\n<code>${escHtml(link)}</code>\n<i>te aviso al publicar en Stock.</i>`);
      try {
        const pubReq = new Request(new URL('/stock/publish', req.url).toString(), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'image', motor: 'Telegram Import', sourceUrl: imgSrc, comment, title: comment ? comment.slice(0, 80) : (imgName || null) }),
        });
        const pr = await stockPublishHandler(pubReq, env, ctx); // notifica el éxito él mismo
        if (!pr.ok) {
          const t = await pr.text().catch(() => '');
          const saved = await saveTelegramImportFailure(env, { chatId, link, format: 'image', comment, host, phase: 'image-publish', detail: `${pr.status} ${t}` }).catch(() => null);
          const savedLine = saved ? `\nGuardado en Enlaces: <code>${escHtml(saved.id)}</code>` : '';
          await tgSend(env, chatId, `⚠️ No pude publicar la imagen (${pr.status}): <code>${escHtml(t.slice(0, 180))}</code>${savedLine}`);
        }
      } catch (e) {
        const saved = await saveTelegramImportFailure(env, { chatId, link, format: 'image', comment, host, phase: 'image-exception', detail: String(e) }).catch(() => null);
        const savedLine = saved ? `\nGuardado en Enlaces: <code>${escHtml(saved.id)}</code>` : '';
        await tgSend(env, chatId, `🚨 Error importando la imagen: <code>${escHtml(String(e).slice(0, 180))}</code>${savedLine}`);
      }
    })());
    return json({ ok: true });
  }

  const fmt = /\b(audio|mp3)\b/i.test(text) ? 'audio' : 'video';
  ctx.waitUntil((async () => {
    // Se guarda el id de ESTE mensaje: es el que se irá reescribiendo con el progreso y,
    // al final, con el resultado. Así la promesa «te aviso» se cumple en el mismo sitio
    // donde se hizo, en vez de acumular mensajes sueltos.
    const progresoMsgId = await tgSend(env, chatId, `📥 Importando ${fmt === 'audio' ? 'audio 🎵' : 'vídeo 🎬'} de <b>${escHtml(host)}</b>…\n<code>${escHtml(link)}</code>\n<i>te aviso al publicar en Stock.</i>`);
    try {
      const bases = admiraTubeBaseCandidates(env);
      let lastStatus = 0;
      let lastBody = '';
      let lastBase = '';
      let acceptedJobId = '';
      let accepted = false;
      for (const base of bases) {
        lastBase = base;
        const r = await fetch(base + '/tube/import-to-stock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: link, format: fmt, comment }),
        });
        if (r.ok) {
          const payload = await r.json().catch(() => null);
          acceptedJobId = payload && typeof payload.jobId === 'string' ? payload.jobId : '';
          accepted = true;
          break;
        }
        lastStatus = r.status;
        lastBody = await r.text().catch(() => '');
      }
      if (!accepted) {
        const baseNote = lastBase ? ` · base <code>${escHtml(lastBase)}</code>` : '';
        const detail = `${lastStatus || 502} ${lastBody || 'sin detalle'}`;
        const saved = await saveTelegramImportFailure(env, { chatId, link, format: fmt, comment, host, phase: 'proxy-rejected', detail }).catch(() => null);
        const savedLine = saved ? `\nGuardado en Enlaces: <code>${escHtml(saved.id)}</code>` : '';
        await tgSend(env, chatId, `⚠️ El proxy rechazó la importación (${lastStatus || 502})${baseNote}: <code>${escHtml(lastBody.slice(0, 180) || 'sin detalle')}</code>${savedLine}`);
      } else if (acceptedJobId && lastBase) {
        const res = await monitorTubeImport(env, chatId, lastBase, acceptedJobId, link, { format: fmt, comment, host }, progresoMsgId);
        if (res && res.published) {
          const titulo = res.title ? `\n<b>${escHtml(res.title.slice(0, 120))}</b>` : '';
          const peso = res.size ? ` · ${(res.size / (1024 * 1024)).toFixed(1)} MB` : '';
          const ficha = res.assetUrl ? `\n<a href="${escHtml(res.assetUrl)}">Verlo en Stock</a>` : '';
          const final = `✅ <b>Publicado en Stock</b>${peso}.${titulo}${ficha}`;
          const plano = `✅ Publicado en Stock${peso}.` +
            (res.title ? `\n${res.title.slice(0, 120)}` : '') +
            (res.assetUrl ? `\n${res.assetUrl}` : '');
          // Si hay un chat de avisos distinto del de origen, allí no existe el mensaje
          // «Importando…», así que no se edita nada: se envía entero.
          const destino = await tgChatDeAvisos(env, chatId);
          const via = destino === chatId
            ? await tgAvisoSeguro(env, chatId, progresoMsgId, final, plano)
            : await tgAvisoSeguro(env, destino, null, final, plano);
          console.log(`[tube] aviso final via=${via} msg=${progresoMsgId}`);
          return;
        }
        if (res && res.failed) {
          // RESCATE: yt-dlp ha fallado. Si la página trae og:image, es que no había vídeo
          // (posts de LinkedIn con un gráfico, por ejemplo) → se publica como imagen en vez
          // de perderla. Se intenta DESPUÉS de fallar, nunca antes: los posts de LinkedIn CON
          // vídeo también traen og:image (la miniatura con el play), así que decidir por og:
          // de entrada rompería las importaciones de vídeo que hoy funcionan.
          const og = await sniffOpenGraph(link);
          if (og.image) {
            const pubReq = new Request(new URL('/stock/publish', req.url).toString(), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'image', motor: 'Telegram Import', sourceUrl: og.image, comment, title: comment ? comment.slice(0, 80) : null, prompt: link }),
            });
            const pr = await stockPublishHandler(pubReq, env, ctx);
            if (pr.ok) {
              await tgSend(env, chatId, `🖼️ No había vídeo en el enlace: rescatada la <b>imagen</b> del post y publicada en Stock.\n<code>${escHtml(link)}</code>`);
              return;
            }
          }
          // Ni vídeo ni imagen: ahora sí, se reporta con el motivo REAL.
          const saved = await saveTelegramImportFailure(env, { format: fmt, comment, host, chatId, link, phase: `job-${res.state}`, detail: res.detail }).catch(() => null);
          const savedLine = saved ? `\nGuardado en Enlaces: <code>${escHtml(saved.id)}</code>` : '';
          await tgSend(env, chatId, `⚠️ La importación falló (${escHtml(res.state)}).\n<code>${escHtml(res.detail)}</code>${savedLine}`);
        }
      }
      // El éxito lo notifica /stock/publish cuando el proxy termina de descargar.
    } catch (e) {
      const saved = await saveTelegramImportFailure(env, { chatId, link, format: fmt, comment, host, phase: 'proxy-contact', detail: String(e) }).catch(() => null);
      const savedLine = saved ? `\nGuardado en Enlaces: <code>${escHtml(saved.id)}</code>` : '';
      await tgSend(env, chatId, `🚨 No pude contactar el proxy del Mac Mini (¿admira-tube caído?): <code>${escHtml(String(e).slice(0, 180))}</code>${savedLine}`);
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
const STOCK_TYPES = ['audio', 'music', 'locucion', 'image', 'video', 'link', 'furni', 'twin-npc', 'digital-twin'];
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
    'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heic', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff',
  };
  // Content-Type con parámetros ("image/jpeg; charset=binary") → nos quedamos con el tipo base.
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return map[base] || 'bin';
}

async function stockExternalId(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return 'auto-' + Array.from(new Uint8Array(bytes)).slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function stockIngestAuthorized(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(provided))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(expected))),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
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
  // Calidad del asset (good/better/best, según el motor); default 'good'.
  const QUALITY_TIERS = ['good', 'better', 'best'];
  const quality = (typeof body.quality === 'string' && QUALITY_TIERS.includes(body.quality.toLowerCase())) ? body.quality.toLowerCase() : 'good';
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

  // Las integraciones servidor→servidor pueden aportar un id externo. Se
  // convierte en un id opaco y determinista para que reintentar nunca duplique
  // el asset. Este carril requiere un secreto compartido; el publish manual de
  // Pixeria conserva su contrato anterior.
  const externalId = typeof body.externalId === 'string' ? body.externalId.trim() : '';
  if (externalId && !/^[A-Za-z0-9:_-]{16,160}$/.test(externalId)) return json({ error: 'bad-external-id' }, { status: 400 });
  if (externalId && !await stockIngestAuthorized(req.headers.get('X-AdmiraNeXT-Ingest'), env.ADMIRANEXT_INGEST_TOKEN)) {
    return json({ error: 'unauthorized-ingest' }, { status: 401 });
  }
  if (externalId) {
    try {
      const source = new URL(sourceUrl);
      const xaiSource = source.hostname === 'x.ai' || source.hostname.endsWith('.x.ai');
      const admiraPackageSource = source.hostname === 'www.admiranext.com'
        && /^\/tiktok\/media\/pkg-[a-f0-9]{20}\/[a-f0-9]{64}$/.test(source.pathname);
      if (source.protocol !== 'https:' || (!xaiSource && !admiraPackageSource)) {
        return json({ error: 'bad-ingest-source' }, { status: 400 });
      }
    } catch { return json({ error: 'bad-ingest-source' }, { status: 400 }); }
  }

  const ts = Date.now();
  const id = externalId ? await stockExternalId(externalId) : `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const metaKey = `stock/${id}/meta.json`;
  const publicUrl = `${new URL(req.url).origin}/stock/asset/${id}`;
  if (externalId) {
    const existing = await env.STOCK_BUCKET.get(metaKey);
    if (existing) {
      try {
        const meta = await existing.json();
        if (meta && meta.id === id && meta.externalRef === id) {
          return json({ ok: true, reused: true, id, url: publicUrl, createdAt: meta.createdAt });
        }
      } catch {}
    }
  }

  let bytes, finalMime, sourceResponse = null, sourceDeclaredSize = 0;
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
        return json({ error: 'sourceUrl-fetch-failed', status: r.status }, { status: 502 });
      }
      if (!r.body) return json({ error: 'sourceUrl-empty-body' }, { status: 502 });
      const declared = Number(r.headers.get('Content-Length') || 0);
      if (declared > 200 * 1024 * 1024) return json({ error: 'too-big', max: 200 * 1024 * 1024 }, { status: 413 });
      sourceResponse = r;
      sourceDeclaredSize = declared;
      finalMime = mime || r.headers.get('Content-Type') || 'application/octet-stream';
    }
  } catch (e) {
    return json({ error: 'decode-failed', detail: String(e) }, { status: 400 });
  }

  if (bytes && bytes.length > 200 * 1024 * 1024) return json({ error: 'too-big', max: 200 * 1024 * 1024 }, { status: 413 });

  const ext = extForMime(finalMime);
  const assetKey = `stock/${id}/asset.${ext}`;
  // URL pública con el origen de la petición (no el hardcodeado): el listado
  // la reescribe igualmente, pero así la notificación Telegram y la respuesta
  // del publish ya salen por un dominio no bloqueado.

  let assetSize = bytes ? bytes.length : 0;
  const putOptions = {
    httpMetadata: { contentType: finalMime, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { motor, type, id },
  };
  if (sourceResponse) {
    let streamedBytes = 0;
    const bounded = new TransformStream({
      transform(chunk, controller) {
        streamedBytes += chunk.byteLength;
        if (streamedBytes > 200 * 1024 * 1024) throw new Error('stock-source-too-big');
        controller.enqueue(chunk);
      },
    });
    try {
      const boundedBody = sourceResponse.body.pipeThrough(bounded);
      if (sourceDeclaredSize > 0) {
        const fixed = new FixedLengthStream(sourceDeclaredSize);
        await Promise.all([
          boundedBody.pipeTo(fixed.writable),
          env.STOCK_BUCKET.put(assetKey, fixed.readable, putOptions),
        ]);
      } else {
        await env.STOCK_BUCKET.put(assetKey, boundedBody, putOptions);
      }
    }
    catch (error) {
      const detail = String(error && error.message || error).slice(0, 160);
      const tooBig = detail.includes('stock-source-too-big');
      console.error(JSON.stringify({ message: 'stock source stream failed', id, declared: sourceDeclaredSize, detail }));
      return json({ error: tooBig ? 'too-big' : 'sourceUrl-stream-failed', ...(tooBig ? { max: 200 * 1024 * 1024 } : { detail }) }, { status: tooBig ? 413 : 502 });
    }
    assetSize = streamedBytes;
  } else {
    await env.STOCK_BUCKET.put(assetKey, bytes, putOptions);
  }

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

  // El tag de calidad se añade SIEMPRE (además de los de contenido), sin pisar.
  tags = Array.isArray(tags) ? tags : [];
  if (!tags.includes(quality)) tags.push(quality);

  const meta = {
    id,
    type,
    motor: String(motor).slice(0, 80),
    prompt: String(prompt || '').slice(0, 1000),
    title: title ? String(title).slice(0, 300) : null,
    comment: comment ? String(comment).slice(0, 2000) : null,
    tags: tags || [],
    quality,
    audience,
    category,
    segmentation: segmentation || null,
    ageBucket: (segmentation && segmentation.ageBuckets[0]) || null,   // edad principal (para pickCreative del gemelo)
    timeSlot: (segmentation && segmentation.timeSlots[0]) || null,     // franja principal (matching por daypart)
    costEst: costEst ? String(costEst).slice(0, 80) : null,
    mime: finalMime,
    ext,
    size: assetSize,
    thumbnail: thumbnail ? String(thumbnail).slice(0, 500) : null,
    url: publicUrl,
    assetKey,
    externalRef: externalId ? id : null,
    fp,
    ph,
    price,
    createdAt: new Date(ts).toISOString(),
  };
  await env.STOCK_BUCKET.put(metaKey, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });

  // Regenera el índice estático sin retrasar la respuesta del publish
  ctx.waitUntil(rebuildAndSyncTaggedStock(env));

  // Notificación rica: motor / tipo / tamaño / URL / snippet del prompt + stats acumulados
  const mbStr = (assetSize / 1024 / 1024).toFixed(2);
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

  const readMeta = async k => {
    try {
      const obj = await env.STOCK_BUCKET.get(k);
      if (!obj) return null;
      return await obj.json();
    } catch { return null; }
  };

  // Sin filtros NO hace falta leerlo todo para devolver los N más recientes: el
  // id empieza por el timestamp en ms (1785665462504-nhgi63), así que ordenando
  // las CLAVES ya se sabe cuáles son los últimos. Antes se leían los 388
  // meta.json del Stock aunque pidieras limit=1, y eso son los 11-15 s que tarda
  // el listado. Con filtro se sigue leyendo todo, porque el criterio vive dentro
  // del meta y recortar antes cambiaría el filtrado y el total.
  const total = allMetaKeys.length;
  let filtered;
  if (!typeFilter && !motorFilter) {
    const recientes = [...allMetaKeys].sort((a, b) => b.localeCompare(a)).slice(0, limit);
    filtered = (await Promise.all(recientes.map(readMeta))).filter(Boolean);
  } else {
    const metas = (await Promise.all(allMetaKeys.map(readMeta))).filter(Boolean);
    filtered = metas;
    if (typeFilter)  filtered = filtered.filter(m => m.type === typeFilter);
    if (motorFilter) filtered = filtered.filter(m => m.motor === motorFilter);
  }
  // Se sigue ordenando por createdAt: si algún id antiguo no llevara el
  // timestamp delante, el orden final no depende de la forma de la clave.
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
  // `total` sigue siendo el tamaño del Stock, no el de la página: sin filtros ya
  // no se leen todos los metas, así que se cuenta por claves. Con filtros es el
  // número de coincidencias, igual que antes.
  return json({ items, total: (!typeFilter && !motorFilter) ? total : filtered.length });
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

  // NÚMERO ÚNICO PERSISTENTE por asset (#N, para /play<N> y referencia humana).
  // El publish no asigna num; aquí, contador monotónico = max(num existentes)+1,
  // asignado a los que aún no lo tienen en ORDEN DE CREACIÓN (más antiguo = menor)
  // y persistido en su meta.json. Autosana cualquier asset publicado sin num.
  // Determinista (mismo orden por createdAt) → rebuilds concurrentes dan el mismo
  // num al mismo asset (idempotente, sin duplicados).
  let maxNum = 0;
  for (const m of metas) { const n = +m.num; if (Number.isFinite(n) && n > maxNum) maxNum = n; }
  const numberless = metas
    .filter(m => m && (m.num == null || !Number.isFinite(+m.num) || +m.num <= 0))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const m of numberless) {
    m.num = ++maxNum;
    try {
      await env.STOCK_BUCKET.put(`stock/${m.id}/meta.json`, JSON.stringify(m), {
        httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
      });
    } catch { /* si la escritura falla, el índice igual lleva el num; se reintenta en el próximo rebuild */ }
  }

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
  return items;
}
async function rebuildAndSyncTaggedStock(env) {
  const items = await rebuildStockIndex(env);
  return gridSyncTaggedStock(env, items || []);
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
    .slice(0, 12); // hasta 12 etiquetas (auto ~4 + metatags propias para agrupar)

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
  ctx.waitUntil(rebuildAndSyncTaggedStock(env));

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
  // CORS en el asset: el gemelo dibuja sprites de mobiliario y el editor de
  // pixeria carga imágenes del Stock con crossOrigin='anonymous' (canvas sin
  // "tainted"). Es contenido público sin credenciales → ACAO:* para que sea
  // legible desde cualquier origen (pixeria.com, github.io, gemelo, localhost).
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  headers.set('Access-Control-Allow-Origin', '*');
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
const AGORA_TOKEN_IDENTITIES = {
  NEO: 'Claude·admira',
  MORFEO: 'Claude·gmail',
  ORACULO: 'Codex·gmail',
  TRINITY: 'Codex·admira',
  CYPHER: 'OpenCode·grok',
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
// Cuando el cortacircuitos diario de KV corta, agoraKvPut devuelve false y hasta
// hoy NADIE miraba el resultado: 18 escrituras, 0 comprobaciones. El worker
// respondia {ok:true} y el cliente imprimia un ✓, mientras la presencia de toda
// la flota se congelaba y los mensajes del feed se perdian en silencio. Se
// tardo 83 minutos en notarlo y solo por casualidad (5-ago-2026).
// Ahora una escritura que no entra se dice, con 503 y motivo.
function kvNoEntro() {
  return json({ ok: false, error: 'kv-write-blocked',
    detail: 'La escritura no ha entrado: tope diario de KV alcanzado o KV_WRITES_OFF activo. Se pierde hasta el reset (00:00 UTC) o hasta subir KV_DAILY_WRITE_CAP.' },
    { status: 503 });
}

async function agoraKvPut(env, key, value, now) {
  if (!(await reserveKvWrite(env, now))) return false;
  try {
    await env.SIGNAGE_KV.put(key, JSON.stringify(value));
    await contarGastoPorPrefijo(env, key, now);
    return true;
  } catch { return false; }
}
function agoraChatAllowed(chatId, expectedChat) {
  if (!expectedChat) return true;
  return String(chatId) === String(expectedChat) || AGORA_FALLBACK_CHAT_IDS.has(String(chatId));
}
function agoraCommandKey(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}
function agoraAddressedSlashFromText(text) {
  const m = String(text || '').trim().match(/^\/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ_.-]+)(?:@([A-Za-zÁÉÍÓÚÜÑáéíóúüñ_.-]+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const alias = agoraCommandKey(m[1]);
  const targetKey = agoraCommandKey(m[2] || '');
  return {
    alias,
    targetKey,
    target: targetKey ? agoraTargetFromArg(targetKey) : null,
    text: String(m[3] || '').trim(),
  };
}
function agoraCommandFromText(text) {
  const parsed = agoraAddressedSlashFromText(text);
  if (!parsed) return null;
  const alias = parsed.alias;
  const target = AGORA_COMMAND_TARGETS[alias];
  if (!target) return null;
  return { alias, target, text: parsed.text };
}
function agoraPersonaNameForIdentity(identity) {
  for (const target of Object.values(AGORA_COMMAND_TARGETS)) {
    if (target.identity === identity) return target.persona;
  }
  return identity;
}
function agoraCliCommandFromText(text) {
  const parsed = agoraAddressedSlashFromText(text);
  if (!parsed) return null;
  const alias = parsed.alias;
  if (!['cli', 'help', 'ayuda', 'who', 'ps', 'status', 'estado', 'enqueandais', 'queandais', 'feed', 'tail', 'inbox', 'tasks', 'tareas', 'cola', 'queues', 'ping', 'done', 'hecho', 'bloqueos', 'blockers', 'ultima', 'last', 'latest', 'pendientes', 'pending', 'buscar', 'search', 'resumen', 'summary', 'bot', 'agente', 'agent', 'switchbot', 'cambiarbot'].includes(alias)) return null;
  return { alias, text: parsed.text };
}
function agoraCliArgs(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}
function agoraTargetFromArg(arg) {
  return AGORA_COMMAND_TARGETS[agoraCommandKey(arg)] || null;
}
function agoraChatBotStateKey(chatId) {
  return `agora:chatbot:${chatId}`;
}
async function agoraChatBotGet(env, chatId) {
  if (!chatId) return null;
  const stored = await agoraKvGet(env, agoraChatBotStateKey(chatId), null);
  if (!stored || !stored.identity || !AGORA_IDENTITIES.includes(stored.identity)) return null;
  return stored;
}
async function agoraChatBotSet(env, chatId, target, actor, now) {
  if (!chatId) return null;
  const payload = {
    identity: target.identity,
    persona: target.persona,
    by: actor && actor.who || 'CLI AgoraMatrix',
    ts: now || Date.now(),
  };
  await agoraKvPut(env, agoraChatBotStateKey(chatId), payload, payload.ts);
  return payload;
}
async function agoraChatBotClear(env, chatId, now) {
  if (!chatId) return;
  await agoraKvPut(env, agoraChatBotStateKey(chatId), null, now || Date.now());
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
function agoraAgeText(ts) {
  const ms = Date.now() - (Number(ts) || 0);
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}
function agoraMadridDateKey(ts) {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  } catch { return ''; }
}
function agoraMadridDateTime(ts) {
  if (!ts) return 'n/a';
  try {
    return new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts));
  } catch { return 'n/a'; }
}
function agoraCleanBriefText(text, max = 150) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function agoraIdentityFromActivity(item) {
  if (item && item.identity && AGORA_IDENTITIES.includes(item.identity)) return item.identity;
  const persona = agoraPersonaFor((item && (item.from || item.persona || item.who)) || '');
  if (persona && AGORA_TOKEN_IDENTITIES[persona]) return AGORA_TOKEN_IDENTITIES[persona];
  const key = agoraCommandKey((item && (item.from || item.persona)) || '');
  for (const target of Object.values(AGORA_COMMAND_TARGETS)) {
    if (agoraCommandKey(target.persona) === key) return target.identity;
  }
  return null;
}
function agoraTaskMatches(a, b) {
  return !!a && !!b
    && Number(a.ts || 0) === Number(b.ts || 0)
    && String(a.text || '') === String(b.text || '')
    && String(a.command || '') === String(b.command || '')
    && String(a.persona || '') === String(b.persona || '');
}
function agoraTaskStateIcon(item) {
  const state = String(item && item.status || '').toLowerCase();
  if (state === 'done') return '✅';
  if (state === 'blocked') return '⛔';
  return '📨';
}
function agoraPresenceUsageText(p) {
  return (p && (p.tokens || p.reqs))
    ? ` · ${Number(p.tokens || 0).toLocaleString('es-ES')} tok · ${Number(p.reqs || 0)} pet.`
    : '';
}
function agoraCliHelpText() {
  return [
    '<b>CLI AgoraMatrix</b>',
    '<code>/bot</code> — ver bot/agente activo para este chat',
    '<code>/bot oraculo</code> o <code>/cambiarbot neo</code> — cambiar el bot activo',
    '<code>/bot auto</code> — volver al bot por defecto del webhook actual',
    '<code>/who</code> o <code>/ps</code> — agentes despiertos/dormidos',
    '<code>/status</code> — resumen operativo del grupo',
    '<code>/pendientes</code> o <code>/pending</code> — colas abiertas por agente',
    '<code>/enqueandais</code> — resumen de hoy por agente',
    '<code>/feed 10</code> o <code>/tail 10</code> — ultimos mensajes compartidos',
    '<code>/inbox</code> — ultimas tareas globales',
    '<code>/inbox cypher 5</code> — buzon de un agente',
    '<code>/tasks oraculo 5</code> — cola de tareas de un agente',
    '<code>/buscar deploy</code> o <code>/search launchd</code> — busca en feed y tasklog',
    '<code>/resumen neo</code> o <code>/summary oraculo</code> — ficha compacta de un agente',
    '<code>/ping neo revisa el deploy</code> — manda una tarea breve',
    '<code>/done oraculo 1 resuelto en commit abc123</code> — cierra una tarea',
    '<code>/bloqueos</code> — resumen de bloqueos y esperas activas',
    '<code>/ultima neo</code> o <code>/ultima pixer-worker</code> — ultimo movimiento de un agente o proyecto',
    '<code>/oraculo</code>, <code>/cypher</code>, <code>/morfeo</code>, <code>/neo</code>, <code>/trinity</code> — invocar agentes',
  ].join('\n');
}
async function agoraPresenceCliText(env) {
  const map = await agoraKvGet(env, 'agora:presence', {});
  const now = Date.now();
  const lines = ['<b>AgoraMatrix /who</b>'];
  AGORA_IDENTITIES.forEach(identity => {
    const p = map[identity] || {};
    const awake = (now - (p.ts || 0)) < AGORA_AWAKE_MS;
    const icon = awake ? '✅' : '🌙';
    const persona = agoraPersonaNameForIdentity(identity);
    const host = p.host ? ` · ${escHtml(p.host)}` : '';
    const usage = agoraPresenceUsageText(p);
    lines.push(`${icon} <b>${escHtml(persona)}</b> <code>${escHtml(identity)}</code> · ${awake ? 'despierto' : 'dormido'} hace ${escHtml(agoraAgeText(p.ts))}${host}${usage}`);
  });
  return lines.join('\n').slice(0, 3900);
}
async function agoraFeedCliText(env, limit) {
  const n = Math.max(1, Math.min(20, parseInt(limit, 10) || 10));
  const items = (await agoraKvGet(env, 'agora:feed', [])).slice(-n).reverse();
  if (!items.length) return '<b>AgoraMatrix /feed</b>\nSin mensajes en el feed.';
  const lines = [`<b>AgoraMatrix /feed</b> · ultimos ${items.length}`];
  items.forEach((it, idx) => {
    const from = it.from || '?';
    const host = it.host ? ` · ${it.host}` : '';
    const text = String(it.text || '').replace(/\s+/g, ' ').slice(0, 260);
    lines.push(`${idx + 1}. <code>${escHtml(agoraFormatTs(it.ts))}</code> <b>${escHtml(from)}</b>${escHtml(host)}`);
    lines.push(`   ${escHtml(text || '(sin texto)')}`);
  });
  return lines.join('\n').slice(0, 3900);
}
async function agoraWhatAreYouDoingCliText(env) {
  const presence = await agoraKvGet(env, 'agora:presence', {});
  const feed = await agoraKvGet(env, 'agora:feed', []);
  const tasklog = await agoraKvGet(env, 'agora:tasklog', []);
  const now = Date.now();
  const today = agoraMadridDateKey(now);
  const lines = [`<b>AgoraMatrix /enqueandais</b> · hoy ${escHtml(today)}`];
  for (const identity of AGORA_IDENTITIES) {
    const persona = agoraPersonaNameForIdentity(identity);
    const p = presence[identity] || {};
    const awake = (now - (p.ts || 0)) < AGORA_AWAKE_MS;
    const events = [];
    for (const it of feed) {
      if (agoraIdentityFromActivity(it) !== identity) continue;
      const ts = Number(it.ts) || 0;
      const text = agoraCleanBriefText(it.text, 150);
      if (!text) continue;
      events.push({ ts, host: it.host || '', text });
    }
    for (const it of tasklog) {
      if (agoraIdentityFromActivity(it) !== identity) continue;
      const ts = Number(it.ts) || 0;
      const bits = [it.command, it.text].filter(Boolean).join(' ');
      const text = agoraCleanBriefText(bits, 150);
      if (!text) continue;
      events.push({ ts, host: '', text });
    }
    events.sort((a, b) => b.ts - a.ts);
    const todayEvents = events.filter(it => agoraMadridDateKey(it.ts) === today).slice(0, 2);
    const lastEvent = events[0];
    const lastTs = Number(p.ts || 0) || (lastEvent && lastEvent.ts) || 0;
    const host = p.host || (lastEvent && lastEvent.host) || 'host desconocido';
    const status = awake ? 'despierto' : 'dormido';
    const usage = agoraPresenceUsageText(p);
    lines.push(`\n<b>${escHtml(persona)}</b> <code>${escHtml(identity)}</code> · ${status}`);
    lines.push(`Última conexión: <code>${escHtml(agoraMadridDateTime(lastTs))}</code> · ${escHtml(host)}${usage}`);
    if (todayEvents.length) {
      todayEvents.forEach(it => {
        const h = it.host ? ` · ${it.host}` : '';
        lines.push(`- ${escHtml(agoraMadridDateTime(it.ts))}${escHtml(h)}: ${escHtml(it.text)}`);
      });
    } else if (lastEvent) {
      const h = lastEvent.host ? ` · ${lastEvent.host}` : '';
      lines.push(`Sin actividad registrada hoy. Último apunte: ${escHtml(agoraMadridDateTime(lastEvent.ts))}${escHtml(h)}: ${escHtml(lastEvent.text)}`);
    } else {
      lines.push('Sin actividad registrada en feed/tasklog.');
    }
  }
  return lines.join('\n').slice(0, 3900);
}
async function agoraTasklogCliText(env, limit) {
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
    lines.push(`${idx + 1}. ${agoraTaskStateIcon(it)} <code>${escHtml(ts)}</code> <b>${escHtml(persona)}</b> ${escHtml(command)}`);
    lines.push(`   ${escHtml(who)}: ${escHtml(text || '(sin texto)')}`);
  });
  return lines.join('\n').slice(0, 3900);
}
async function agoraQueueCliText(env, kind, args) {
  const target = agoraTargetFromArg(args[0] || '');
  const limitArg = target ? args[1] : args[0];
  if (!target) return agoraTasklogCliText(env, limitArg ? parseInt(limitArg, 10) : 10);
  const n = Math.max(1, Math.min(10, parseInt(limitArg, 10) || 5));
  const items = (await agoraKvGet(env, `agora:${kind}:${target.identity}`, [])).slice(-n).reverse();
  const title = kind === 'tasks' ? 'tasks' : 'inbox';
  if (!items.length) return `<b>AgoraMatrix /${title}</b>\n${escHtml(target.persona)} no tiene elementos pendientes.`;
  const lines = [`<b>AgoraMatrix /${title}</b> · ${escHtml(target.persona)} · ${items.length}`];
  items.forEach((it, idx) => {
    const text = String(it.text || '').replace(/\s+/g, ' ').slice(0, 240);
    lines.push(`${idx + 1}. <code>${escHtml(agoraFormatTs(it.ts))}</code> ${escHtml(it.command || '')} · ${escHtml(it.who || 'humano')}`);
    lines.push(`   ${escHtml(text || '(sin texto)')}`);
  });
  return lines.join('\n').slice(0, 3900);
}
async function agoraPendingCliText(env, args) {
  const target = agoraTargetFromArg(args[0] || '');
  const presence = await agoraKvGet(env, 'agora:presence', {});
  const identities = target ? [target.identity] : AGORA_IDENTITIES;
  const lines = [`<b>AgoraMatrix /pendientes</b> · ${target ? escHtml(agoraPersonaNameForIdentity(target.identity)) : 'todas las colas'}`];
  for (const identity of identities) {
    const persona = agoraPersonaNameForIdentity(identity);
    const inbox = await agoraKvGet(env, `agora:inbox:${identity}`, []);
    const tasks = await agoraKvGet(env, `agora:tasks:${identity}`, []);
    const p = presence[identity] || {};
    const awake = (Date.now() - (p.ts || 0)) < AGORA_AWAKE_MS;
    const icon = awake ? '✅' : '🌙';
    lines.push(`${icon} <b>${escHtml(persona)}</b> · inbox <b>${inbox.length}</b> · tasks <b>${tasks.length}</b>`);
    const last = tasks[tasks.length - 1] || inbox[inbox.length - 1];
    if (last) lines.push(`   ${escHtml(agoraCleanBriefText(last.text, 180))}`);
  }
  return lines.join('\n').slice(0, 3900);
}
async function agoraDoneCliText(env, args, actor) {
  const target = agoraTargetFromArg(args[0] || '');
  if (!target) return 'Uso: <code>/done oraculo 1 resuelto en commit abc123</code>';
  const displayIndex = parseInt(args[1], 10);
  if (!Number.isFinite(displayIndex) || displayIndex < 1) return 'Uso: <code>/done oraculo 1 resuelto en commit abc123</code>';
  const note = args.slice(2).join(' ').trim();
  const now = Date.now();
  const tasksKey = `agora:tasks:${target.identity}`;
  const inboxKey = `agora:inbox:${target.identity}`;
  const tasks = await agoraKvGet(env, tasksKey, []);
  const rawIndex = tasks.length - displayIndex;
  if (rawIndex < 0 || rawIndex >= tasks.length) return `No existe la tarea ${displayIndex} en ${escHtml(target.persona)}.`;
  const removed = tasks[rawIndex];
  const nextTasks = tasks.slice();
  nextTasks.splice(rawIndex, 1);
  await agoraKvPut(env, tasksKey, nextTasks, now);
  const inbox = await agoraKvGet(env, inboxKey, []);
  const inboxIndex = inbox.findIndex(it => agoraTaskMatches(it, removed));
  if (inboxIndex >= 0) {
    const nextInbox = inbox.slice();
    nextInbox.splice(inboxIndex, 1);
    await agoraKvPut(env, inboxKey, nextInbox, now);
  }
  const doneEntry = {
    ...removed,
    identity: target.identity,
    status: 'done',
    resolvedAt: now,
    resolvedBy: actor && actor.who || 'CLI AgoraMatrix',
    note: note || '',
    text: note ? `${removed.text} | RESUELTO: ${note}` : removed.text,
    command: '/done',
  };
  await agoraAppendTaskLog(env, doneEntry, now);
  const summary = [
    `✅ <b>${escHtml(target.persona)}</b> · tarea ${displayIndex} cerrada.`,
    `<code>${escHtml(agoraCleanBriefText(removed.text, 220) || '(sin texto)')}</code>`,
  ];
  if (note) summary.push(`Cierre: ${escHtml(note.slice(0, 220))}`);
  return summary.join('\n');
}
async function agoraSearchCliText(env, args) {
  const needle = args.join(' ').trim();
  if (!needle) return 'Uso: <code>/buscar launchd</code> o <code>/search deploy</code>';
  const q = agoraCommandKey(needle);
  const feed = await agoraKvGet(env, 'agora:feed', []);
  const tasklog = await agoraKvGet(env, 'agora:tasklog', []);
  const hits = [];
  for (const it of feed) {
    const text = String(it.text || '');
    if (!agoraCommandKey(text).includes(q) && !agoraCommandKey(it.from || '').includes(q)) continue;
    hits.push({ ts: it.ts, source: 'feed', actor: it.from || '?', text: agoraCleanBriefText(text, 220) });
  }
  for (const it of tasklog) {
    const text = `${it.command || ''} ${it.text || ''} ${it.note || ''}`.trim();
    if (!agoraCommandKey(text).includes(q) && !agoraCommandKey(it.persona || it.identity || '').includes(q)) continue;
    hits.push({ ts: it.ts, source: 'tasklog', actor: it.persona || it.identity || '?', text: agoraCleanBriefText(text, 220) });
  }
  hits.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const top = hits.slice(0, 8);
  if (!top.length) return `<b>AgoraMatrix /buscar</b>\nSin coincidencias para <code>${escHtml(needle)}</code>.`;
  const lines = [`<b>AgoraMatrix /buscar</b> · ${escHtml(needle)} · ${top.length} coincidencias`];
  top.forEach((it, idx) => {
    lines.push(`${idx + 1}. <code>${escHtml(agoraFormatTs(it.ts))}</code> <b>${escHtml(it.actor)}</b> · ${escHtml(it.source)}`);
    lines.push(`   ${escHtml(it.text)}`);
  });
  return lines.join('\n').slice(0, 3900);
}
async function agoraBlockersCliText(env, limit) {
  const n = Math.max(1, Math.min(10, parseInt(limit, 10) || 6));
  const feed = await agoraKvGet(env, 'agora:feed', []);
  const tasklog = await agoraKvGet(env, 'agora:tasklog', []);
  const blockers = [];
  const blockerRe = /\b(bloque|bloquea|bloqueado|bloqueada|pendiente|espera|waiting|blocked|atascad|falta|duda para carlos|needs decision|sin verificar|404|500|error|falla)\b/i;
  for (const it of tasklog.slice().reverse()) {
    const text = `${it.command || ''} ${it.text || ''} ${it.note || ''}`.trim();
    if (String(it.status || '').toLowerCase() === 'blocked' || blockerRe.test(text)) {
      blockers.push({
        ts: it.ts,
        source: 'tasklog',
        actor: it.persona || it.identity || '?',
        text: agoraCleanBriefText(text, 180),
      });
    }
  }
  for (const it of feed.slice().reverse()) {
    const text = String(it.text || '');
    if (blockerRe.test(text)) {
      blockers.push({
        ts: it.ts,
        source: 'feed',
        actor: it.from || '?',
        text: agoraCleanBriefText(text, 180),
      });
    }
  }
  const dedup = [];
  const seen = new Set();
  for (const it of blockers.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))) {
    const key = `${it.actor}|${it.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(it);
    if (dedup.length >= n) break;
  }
  if (!dedup.length) return '<b>AgoraMatrix /bloqueos</b>\nNo detecto bloqueos claros en feed/tasklog reciente.';
  const lines = [`<b>AgoraMatrix /bloqueos</b> · ${dedup.length} señales recientes`];
  dedup.forEach((it, idx) => {
    lines.push(`${idx + 1}. <code>${escHtml(agoraFormatTs(it.ts))}</code> <b>${escHtml(it.actor)}</b> · ${escHtml(it.source)}`);
    lines.push(`   ${escHtml(it.text)}`);
  });
  return lines.join('\n').slice(0, 3900);
}
async function agoraLatestCliText(env, args) {
  const needle = args.join(' ').trim();
  const feed = await agoraKvGet(env, 'agora:feed', []);
  const tasklog = await agoraKvGet(env, 'agora:tasklog', []);
  const target = agoraTargetFromArg(args[0] || '');
  const items = [];
  for (const it of feed) {
    items.push({
      ts: it.ts,
      kind: 'feed',
      actor: it.from || '?',
      identity: agoraIdentityFromActivity(it),
      text: String(it.text || ''),
      host: it.host || '',
    });
  }
  for (const it of tasklog) {
    items.push({
      ts: it.ts,
      kind: 'tasklog',
      actor: it.persona || it.identity || '?',
      identity: agoraIdentityFromActivity(it) || it.identity || null,
      text: `${it.command || ''} ${it.text || ''} ${it.note || ''}`.trim(),
      host: '',
    });
  }
  items.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  let filtered = items;
  if (target) {
    filtered = items.filter(it => it.identity === target.identity || agoraCommandKey(it.actor) === agoraCommandKey(target.persona));
  } else if (needle) {
    const q = agoraCommandKey(needle);
    filtered = items.filter(it => agoraCommandKey(it.text).includes(q) || agoraCommandKey(it.actor).includes(q));
  }
  const hit = filtered[0];
  if (!hit) return needle
    ? `<b>AgoraMatrix /ultima</b>\nSin actividad encontrada para <code>${escHtml(needle)}</code>.`
    : '<b>AgoraMatrix /ultima</b>\nSin actividad registrada todavia.';
  const label = target ? target.persona : (needle || 'grupo');
  const lines = [
    `<b>AgoraMatrix /ultima</b> · ${escHtml(label)}`,
    `<code>${escHtml(agoraMadridDateTime(hit.ts))}</code> · <b>${escHtml(hit.actor)}</b> · ${escHtml(hit.kind)}`,
    escHtml(agoraCleanBriefText(hit.text, 320) || '(sin texto)'),
  ];
  if (hit.host) lines.push(`Host: ${escHtml(hit.host)}`);
  return lines.join('\n').slice(0, 3900);
}
async function agoraSummaryCliText(env, args) {
  const target = agoraTargetFromArg(args[0] || '');
  if (!target) return 'Uso: <code>/resumen oraculo</code> o <code>/summary neo</code>';
  const identity = target.identity;
  const persona = target.persona;
  const presence = await agoraKvGet(env, 'agora:presence', {});
  const p = presence[identity] || {};
  const awake = (Date.now() - (p.ts || 0)) < AGORA_AWAKE_MS;
  const inbox = await agoraKvGet(env, `agora:inbox:${identity}`, []);
  const tasks = await agoraKvGet(env, `agora:tasks:${identity}`, []);
  const latest = await agoraLatestCliText(env, [agoraCommandKey(persona)]);
  const lines = [
    `<b>AgoraMatrix /resumen</b> · ${escHtml(persona)}`,
    `${awake ? '✅ despierto' : '🌙 dormido'} · <code>${escHtml(identity)}</code>`,
    `Última conexión: <code>${escHtml(agoraMadridDateTime(p.ts || 0))}</code>${p.host ? ` · ${escHtml(p.host)}` : ''}${agoraPresenceUsageText(p)}`,
    `Pendiente: inbox <b>${inbox.length}</b> · tasks <b>${tasks.length}</b>`,
  ];
  const next = tasks[tasks.length - 1] || inbox[inbox.length - 1];
  if (next) lines.push(`Siguiente: ${escHtml(agoraCleanBriefText(next.text, 200))}`);
  const latestLines = String(latest || '').split('\n').slice(1);
  if (latestLines.length) lines.push(...latestLines);
  return lines.join('\n').slice(0, 3900);
}
async function agoraStatusCliText(env) {
  const map = await agoraKvGet(env, 'agora:presence', {});
  const now = Date.now();
  const awake = AGORA_IDENTITIES.filter(id => (now - ((map[id] || {}).ts || 0)) < AGORA_AWAKE_MS).length;
  const feed = await agoraKvGet(env, 'agora:feed', []);
  const tasklog = await agoraKvGet(env, 'agora:tasklog', []);
  return [
    '<b>AgoraMatrix /status</b>',
    `Agentes despiertos: <b>${awake}/${AGORA_IDENTITIES.length}</b>`,
    `Feed compartido: <b>${feed.length}</b> mensajes guardados`,
    `Tasklog: <b>${tasklog.length}</b> tareas recientes`,
    `Ultimo feed: <code>${escHtml(agoraFormatTs((feed[feed.length - 1] || {}).ts) || 'n/a')}</code>`,
    'Usa <code>/who</code>, <code>/feed 10</code>, <code>/inbox cypher</code> o <code>/ping oraculo texto</code>.',
  ].join('\n');
}
async function agoraBotCliText(env, args, actor) {
  const chatId = actor && actor.chat ? String(actor.chat) : '';
  const current = chatId ? await agoraChatBotGet(env, chatId) : null;
  const currentTarget = current && current.identity
    ? { identity: current.identity, persona: current.persona || agoraPersonaNameForIdentity(current.identity) }
    : null;
  const arg0 = agoraCommandKey(args[0] || '');
  if (!arg0) {
    const lines = ['<b>AgoraMatrix /bot</b>'];
    if (currentTarget) {
      lines.push(`Activo en este chat: <b>${escHtml(currentTarget.persona)}</b> <code>${escHtml(currentTarget.identity)}</code>`);
      lines.push(`Cambiado por ${escHtml(current && current.by || 'desconocido')} · <code>${escHtml(agoraMadridDateTime(current && current.ts || 0))}</code>`);
    } else {
      lines.push(`Sin override activo. Usa el bot actual del webhook: <b>${escHtml(actor && actor.persona || actor && actor.identity || 'actual')}</b>.`);
    }
    lines.push('Opciones: <code>neo</code>, <code>morfeo</code>, <code>trinity</code>, <code>oraculo</code>, <code>cypher</code>.');
    lines.push('Usa <code>/bot oraculo</code> para que el texto libre vaya a ese agente.');
    return lines.join('\n');
  }
  if (['auto', 'default', 'reset', 'normal'].includes(arg0)) {
    await agoraChatBotClear(env, chatId, Date.now());
    return '<b>AgoraMatrix /bot</b>\nModo por defecto restaurado para este chat.';
  }
  const target = agoraTargetFromArg(arg0);
  if (!target) return 'Uso: <code>/bot oraculo</code>, <code>/bot neo</code> o <code>/bot auto</code>';
  const stored = await agoraChatBotSet(env, chatId, target, actor, Date.now());
  return [
    '<b>AgoraMatrix /bot</b>',
    `Activo en este chat: <b>${escHtml(target.persona)}</b> <code>${escHtml(target.identity)}</code>`,
    `Desde ahora el texto libre se enruta a ese agente. Cambio hecho por ${escHtml(stored.by)}.`,
  ].join('\n');
}
async function agoraCliCommandReply(env, command, actor) {
  const alias = command.alias;
  const args = agoraCliArgs(command.text);
  if (alias === 'help' || alias === 'ayuda' || alias === 'cli') return agoraCliHelpText();
  if (alias === 'bot' || alias === 'agente' || alias === 'agent' || alias === 'switchbot' || alias === 'cambiarbot') return agoraBotCliText(env, args, actor);
  if (alias === 'who' || alias === 'ps') return agoraPresenceCliText(env);
  if (alias === 'status' || alias === 'estado') return agoraStatusCliText(env);
  if (alias === 'pendientes' || alias === 'pending') return agoraPendingCliText(env, args);
  if (alias === 'enqueandais' || alias === 'queandais') return agoraWhatAreYouDoingCliText(env);
  if (alias === 'feed' || alias === 'tail') return agoraFeedCliText(env, args[0]);
  if (alias === 'inbox') return agoraQueueCliText(env, 'inbox', args);
  if (alias === 'tasks' || alias === 'tareas' || alias === 'cola' || alias === 'queues') return agoraQueueCliText(env, 'tasks', args);
  if (alias === 'buscar' || alias === 'search') return agoraSearchCliText(env, args);
  if (alias === 'resumen' || alias === 'summary') return agoraSummaryCliText(env, args);
  if (alias === 'done' || alias === 'hecho') return agoraDoneCliText(env, args, actor);
  if (alias === 'bloqueos' || alias === 'blockers') return agoraBlockersCliText(env, args[0]);
  if (alias === 'ultima' || alias === 'last' || alias === 'latest') return agoraLatestCliText(env, args);
  if (alias === 'ping') {
    const target = agoraTargetFromArg(args[0] || '');
    if (!target) return 'Uso: <code>/ping neo mensaje</code> · agentes: neo, morfeo, trinity, oraculo, cypher';
    const body = args.slice(1).join(' ').trim() || 'ping desde CLI AgoraMatrix: confirma presencia y estado breve.';
    const routed = await agoraEnqueueCommand(env, { alias: agoraCommandKey(args[0]), target, text: body }, actor && actor.who, actor && actor.chat);
    return `📨 <b>${escHtml(routed.persona)}</b> invocado por CLI.\n<code>${escHtml(routed.text.slice(0, 900))}</code>`;
  }
  return agoraCliHelpText();
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
    if (!(await agoraKvPut(env, 'agora:presence', map, now))) return kvNoEntro();
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
    if (!(await agoraKvPut(env, 'agora:feed', feed.slice(-AGORA_FEED_CAP), now))) return kvNoEntro();
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
    if (!(await agoraKvPut(env, 'agora:config', { config: b.config || {}, ts: now }, now))) return kvNoEntro();
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

// POST /agora/enqueue {key,agent|identity,text,who?,chat?,command?}
// Entrada directa para herramientas MCP y automatizaciones no-Telegram.
async function agoraEnqueueHandler(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!agoraAuth(env, b.key)) return json({ error: 'unauthorized' }, { status: 401 });
  const target = b.identity && AGORA_IDENTITIES.includes(b.identity)
    ? { identity: b.identity, persona: agoraPersonaNameForIdentity(b.identity) }
    : agoraTargetFromArg(b.agent || b.persona || '');
  if (!target) return json({ error: 'bad-agent' }, { status: 400 });
  const text = String(b.text || '').trim();
  if (!text) return json({ error: 'missing-text' }, { status: 400 });
  const routed = await agoraEnqueueDirect(
    env,
    target.identity,
    text,
    b.who || b.origin || 'Admira Live MCP',
    b.chat,
    b.command || '/mcp',
  );
  return json({ ok: true, ...routed });
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
  const selectedBot = await agoraChatBotGet(env, chatId);
  const activeIdentity = selectedBot && selectedBot.identity ? selectedBot.identity : identity;
  const activePersona = selectedBot && selectedBot.persona ? selectedBot.persona : agoraPersonaNameForIdentity(activeIdentity);
  const activeToken = await agoraBotTokenFor(env, activeIdentity);
  const addressed = agoraAddressedSlashFromText(text);
  if (addressed && addressed.target) {
    if (addressed.target.identity !== identity) return json({ ok: true });
  }
  const cliCommand = agoraCliCommandFromText(text);
  if (cliCommand) {
    const alias = cliCommand.alias;
    if (selectedBot && selectedBot.identity && selectedBot.identity !== identity
        && !['bot', 'agente', 'agent', 'switchbot', 'cambiarbot'].includes(alias)) {
      return json({ ok: true });
    }
    ctx.waitUntil((async () => {
      await sendTelegramVia(activeToken || token, chatId, await agoraCliCommandReply(env, cliCommand, {
        who,
        chat: chatId,
        identity: activeIdentity,
        persona: activePersona,
      }));
    })().catch(() => {}));
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
  if (selectedBot && selectedBot.identity && selectedBot.identity !== identity) return json({ ok: true });
  if (addressed && addressed.target) {
    const forwarded = `/${addressed.alias}${addressed.text ? ` ${addressed.text}` : ''}`;
    ctx.waitUntil((async () => {
      const routed = await agoraEnqueueDirect(env, identity, forwarded, who, chatId, `/${addressed.alias}@${addressed.targetKey}`);
      await sendTelegramVia(token, chatId, `📨 <b>${escHtml(routed.persona)}</b> recibido.\n<code>${escHtml(routed.text.slice(0, 900))}</code>`);
    })().catch(() => {}));
    return json({ ok: true });
  }
  ctx.waitUntil((async () => {
    const routed = await agoraEnqueueDirect(env, activeIdentity, text, who, chatId, '/direct');
    await sendTelegramVia(activeToken || token, chatId, `📨 <b>${escHtml(routed.persona)}</b> recibido.\n<code>${escHtml(routed.text.slice(0, 900))}</code>`);
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
// ESTADO ACTUAL: el gemelo reporta su distribución viva (por pantalla y cliente);
// pixeria la lee para "Cargar distribución actual" → la representa en la rejilla.
async function layoutReportHandler(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const snap = b.snapshot;
  if (!snap || !Array.isArray(snap.furniture)) return json({ error: 'missing-furniture' }, { status: 400 });
  const now = Date.now();
  const screen = b.screen ? String(b.screen).slice(0, 60) : '';
  const client = b.client ? String(b.client).slice(0, 40) : '';
  // origin = quién hizo el cambio ('gemelo'|'pixeria') → para el sync EN VIVO
  // bidireccional cada lado ignora sus propios cambios (anti-bucle).
  const origin = b.origin ? String(b.origin).slice(0, 16) : 'gemelo';
  const rec = Object.assign({}, snap, { ts: now, screen: screen || null, client: client || null, origin });
  const ops = [];
  if (screen && /^[a-z0-9_-]+$/i.test(screen)) ops.push(agoraKvPut(env, `layout:current:${screen}`, rec, now));
  if (client) ops.push(agoraKvPut(env, `layout:current:client:${client}`, rec, now));
  if (!ops.length) return json({ error: 'no-key' }, { status: 400 });
  await Promise.all(ops);
  return json({ ok: true });
}
async function layoutCurrentHandler(req, env, url) {
  const screen = String(url.searchParams.get('screen') || '').slice(0, 60);
  const client = String(url.searchParams.get('client') || '').slice(0, 40);
  let rec = null;
  if (screen) rec = await agoraKvGet(env, `layout:current:${screen}`, null);
  if (!rec && client) rec = await agoraKvGet(env, `layout:current:client:${client}`, null);
  return json({ current: rec || null });
}

// ─── CLI KEYLESS del Xtanco (EN VIVO) ─────────────────────────────────────
// Canal SIN clave para el CLI de pixeria cuando está EN VIVO con un Xpacio (mismo
// modelo de confianza que /layout/*: worker keyless del ecosistema, scoping por
// pantalla). pixeria encola un comando (POST /twin/cmd), el gemelo de ese punto lo
// sondea (GET /twin/cmd?screen=&since=) y lo ejecuta vía xtAPI; devuelve el resultado
// (POST /twin/result) que pixeria recoge (GET /twin/result?screen=&id=).
async function twinCmdPostHandler(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const screen = String(b.screen || '').slice(0, 60);
  const text = String(b.text || '').trim().slice(0, 200);
  if (!screen || !/^[a-z0-9_-]+$/i.test(screen) || !text) return json({ error: 'missing-screen-or-text' }, { status: 400 });
  const now = Date.now();
  const list = await agoraKvGet(env, `twincmd:${screen}`, []);
  list.push({ id: now, text, ts: now });
  await agoraKvPut(env, `twincmd:${screen}`, list.slice(-30), now);
  return json({ ok: true, id: now });
}
async function twinCmdGetHandler(req, env, url) {
  const screen = String(url.searchParams.get('screen') || '').slice(0, 60);
  const since = Number(url.searchParams.get('since') || 0);
  if (!screen) return json({ commands: [] });
  const list = await agoraKvGet(env, `twincmd:${screen}`, []);
  return json({ commands: list.filter(c => c.id > since).slice(0, 10) });
}
async function twinResultPostHandler(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const screen = String(b.screen || '').slice(0, 60);
  const id = Number(b.id || 0);
  if (!screen || !id) return json({ error: 'missing' }, { status: 400 });
  const now = Date.now();
  const map = await agoraKvGet(env, `twinres:${screen}`, {});
  map[id] = { text: String(b.text || '').slice(0, 3900), ts: now };
  const ids = Object.keys(map).map(Number).sort((a, c) => a - c);
  while (ids.length > 20) { delete map[ids.shift()]; }
  await agoraKvPut(env, `twinres:${screen}`, map, now);
  return json({ ok: true });
}
async function twinResultGetHandler(req, env, url) {
  const screen = String(url.searchParams.get('screen') || '').slice(0, 60);
  const id = String(url.searchParams.get('id') || '');
  if (!screen || !id) return json({ result: null });
  const map = await agoraKvGet(env, `twinres:${screen}`, {});
  return json({ result: map[id] || null });
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
// EDICIÓN: aplica cambios del editor pixel-art a un mueble de Mis muebles
// (imagen base64 editada, altura ph, footprint fp, título). Match por url.
async function xpacioUpdateHandler(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!b.id || !b.url) return json({ error: 'missing-id-or-url' }, { status: 400 });
  const now = Date.now();
  const w = await xpacioLoad(env, b.id);
  const it = (w.owned || []).find(o => o.url === b.url);
  if (!it) return json({ error: 'not-owned' }, { status: 404 });
  const p = b.patch || {};
  if (typeof p.img === 'string' && p.img.startsWith('data:image') && p.img.length < 800000) it.img = p.img;
  if (p.ph != null && isFinite(+p.ph)) it.ph = Math.max(8, Math.min(400, Math.round(+p.ph)));
  if (Array.isArray(p.fp) && p.fp.length === 2) it.fp = [Math.max(1, p.fp[0] | 0), Math.max(1, p.fp[1] | 0)];
  if (typeof p.title === 'string' && p.title.trim()) it.title = p.title.slice(0, 120);
  it.editedAt = now;
  await agoraKvPut(env, xpacioKey(b.id), w, now);
  return json({ ok: true, wallet: w });
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

// ─── Informe de campañas al cierre del día (Telegram) ───────────────────────
// El cron corre cada 10 min; a la hora objetivo (REPORT_HOUR Madrid, def 21h)
// arma el informe de las campañas activas (impactos del día por segmento + gasto
// CPM) y lo empuja a Telegram. KV flag por día para no repetir.
const SEG_LABEL_RPT = { nino_m:'♂ Niño', nino_f:'♀ Niña', joven_m:'♂ Joven', joven_f:'♀ Joven',
  adulto_m:'♂ Adulto', adulto_f:'♀ Adulta', senior_m:'♂ Senior', senior_f:'♀ Senior' };
function madridParts() {
  const d = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '');
  const hour = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(d);
  return { ymd, hour };
}
async function dailyCampaignReport(env, ymd) {
  const list = await env.SIGNAGE_KV.list({ prefix: 'camp:', limit: 1000 });
  const dayCache = {};
  async function dayFor(loc) {
    if (dayCache[loc] !== undefined) return dayCache[loc];
    let d = null; try { const v = await env.SIGNAGE_KV.get(`day:${loc}:${ymd}`); d = v ? JSON.parse(v) : null; } catch {}
    dayCache[loc] = d; return d;
  }
  const lines = []; let gImp = 0, gSpend = 0, n = 0;
  for (const k of list.keys) {
    if (n >= 40) break;
    let c; try { const v = await env.SIGNAGE_KV.get(k.name); if (!v) continue; c = JSON.parse(v); } catch { continue; }
    if (!c || c.active === false) continue;
    const day = await dayFor(c.loc);
    const imp = (day && day.extAds && day.extAds[c.seg]) || 0;
    if (imp <= 0) continue;
    const spend = Math.min(c.budget || 0, imp / 1000 * (c.cpm || 0));
    const done = (c.budget > 0 && spend >= c.budget) ? ' ✅' : '';
    lines.push(`• ${SEG_LABEL_RPT[c.seg] || c.seg} · ${c.loc} — <b>${imp}</b> impactos · ${spend.toFixed(2)}€/${c.budget || 0}€${done}`);
    gImp += imp; gSpend += spend; n++;
  }
  if (!lines.length) return false;
  const dd = ymd.slice(6, 8), mm = ymd.slice(4, 6);
  const txt = `📊 <b>Informe de campañas · ${dd}/${mm}</b>\n` + lines.join('\n') +
    `\n\n<b>Total</b>: ${gImp} impactos · ${gSpend.toFixed(2)}€ consumidos`;
  await sendTelegram(env, txt);
  return true;
}
async function maybeDailyReport(env) {
  try {
    if (!env.SIGNAGE_KV) return;
    const { ymd, hour } = madridParts();
    const target = Number.isFinite(+env.REPORT_HOUR) ? +env.REPORT_HOUR : 21;
    if (hour !== target) return;
    const flag = `report:campaign:${ymd}`;
    if (await env.SIGNAGE_KV.get(flag)) return;            // ya enviado hoy
    await env.SIGNAGE_KV.put(flag, '1', { expirationTtl: 172800 });
    await dailyCampaignReport(env, ymd);
  } catch (e) { /* silencioso */ }
}

// ─── Monitor de activación del Consejo (cron */2) — avisa por Telegram cuando
//     una persona del Consejo reaparece tras >15min de silencio. (Neo, sobre la base de Codex.)
const COUNCIL_PERSONAS = {
  'Neo': { consejero: 'Elon Musk', role: 'CEO' },
  'Morfeo': { consejero: 'Jensen Huang', role: 'CTO' },
  'Trinity': { consejero: 'Gwynne Shotwell', role: 'COO' },
  'Oráculo': { consejero: 'Ruth Porat', role: 'CFO' },
  'Cypher': { consejero: 'Ryan Reynolds', role: 'CSO' },
};
const ACTIVITY_STATE_KEY = 'agora:activity-monitor';
const ACTIVATION_GAP_MS = 15 * 60 * 1000;

async function agoraActivityMonitor(env) {
  if (!env.SIGNAGE_KV) return;
  const feed = await agoraKvGet(env, 'agora:feed', []);
  if (!feed || !feed.length) return;
  const newest = {};
  for (const it of feed) {
    const from = String((it && it.from) || '');
    if (!COUNCIL_PERSONAS[from]) continue;
    const ts = Number((it && it.ts) || 0);
    if (!newest[from] || ts > newest[from].ts) newest[from] = { ts, text: String((it && it.text) || '') };
  }
  let state = {};
  try { state = JSON.parse(await env.SIGNAGE_KV.get(ACTIVITY_STATE_KEY)) || {}; } catch (e) {}
  const initialized = !!state._initialized;
  const activations = [];
  for (const persona of Object.keys(newest)) {
    const info = newest[persona];
    const prev = Number(state[persona] || 0);
    if (info.ts > prev) {
      if (initialized && (prev === 0 || (info.ts - prev) > ACTIVATION_GAP_MS)) activations.push(Object.assign({ persona }, info));
      state[persona] = info.ts;
    }
  }
  state._initialized = true;
  await env.SIGNAGE_KV.put(ACTIVITY_STATE_KEY, JSON.stringify(state));
  if (!initialized || !activations.length) return;
  for (const a of activations) {
    const m = COUNCIL_PERSONAS[a.persona];
    const txt = a.text.replace(/<[^>]+>/g, '').slice(0, 220);
    const msg = '🟢 <b>' + escHtml(a.persona) + '</b> · ' + escHtml(m.consejero) + ' (' + m.role + ') se ha activado en el Consejo\n' + escHtml(txt) + '\n\n<i>admira.live/sala.html</i>';
    try { await tgSend(env, env.TELEGRAM_CHAT_ID, msg); } catch (e) {}
  }
}


// ─── Audiencia de cámara (gemelo XpaceOS → /audience): presencia + género + edad.
//     Agrega por loc/pantalla/día; clearchannel.tv lo cruza con /emit/range.
async function audienceSaveHandler(req, env) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  let b; try { b = await req.json(); } catch { return json({ error: 'bad-json' }, { status: 400 }); }
  const loc = String(b.loc || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  const screen = (String(b.screen || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48)) || (loc + '-led');
  const d = new Date();
  const date = String(d.getUTCFullYear()) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
  const faces = Math.max(0, Math.round(+b.faces || 0));
  const gender = (b.gender === 'male' || b.gender === 'female') ? b.gender : '';
  const gscore = +b.genderScore || 0;
  const ageBucket = ['nino', 'joven', 'adulto', 'senior'].includes(b.ageBucket) ? b.ageBucket : '';
  const emotion = String(b.emotion || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 16);
  const key = 'aud:' + loc + ':' + screen + ':' + date;
  let agg = {};
  try { agg = JSON.parse(await env.SIGNAGE_KV.get(key)) || {}; } catch (e) {}
  agg.date = date; agg.loc = loc; agg.screen = screen;
  agg.samples = (agg.samples || 0) + 1;
  agg.facesPeak = Math.max(agg.facesPeak || 0, faces);
  if (faces > 0) {
    agg.present = (agg.present || 0) + 1;
    agg.facesSum = (agg.facesSum || 0) + faces;
    agg.gender = agg.gender || { male: 0, female: 0 };
    if (gender && gscore >= 0.6) agg.gender[gender] = (agg.gender[gender] || 0) + 1;
    if (ageBucket) { agg.age = agg.age || {}; agg.age[ageBucket] = (agg.age[ageBucket] || 0) + 1; }
    if (emotion) { agg.emotion = agg.emotion || {}; agg.emotion[emotion] = (agg.emotion[emotion] || 0) + 1; }
  }
  // franja horaria (UTC) para el informe por horas
  const hr = String(new Date().getUTCHours());
  agg.hours = agg.hours || {};
  const h = agg.hours[hr] = agg.hours[hr] || { samples: 0, present: 0, male: 0, female: 0 };
  h.samples++;
  if (faces > 0) { h.present++; if (gender === 'male' && gscore >= 0.6) h.male++; if (gender === 'female' && gscore >= 0.6) h.female++; }
  agg.lastTs = Date.now();
  try { await env.SIGNAGE_KV.put(key, JSON.stringify(agg).slice(0, 24000), { expirationTtl: 40 * 24 * 3600 }); } catch (e) {}
  return json({ ok: true, screen, date, samples: agg.samples, present: agg.present || 0 });
}

async function audienceRangeHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const loc = String(url.searchParams.get('loc') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'xtanco-generic';
  const prefix = 'aud:' + loc + ':';
  const screens = {}; let cursor, n = 0;
  do {
    const list = await env.SIGNAGE_KV.list({ prefix, cursor, limit: 1000 });
    for (const k of list.keys) {
      const rest = k.name.slice(prefix.length); const li = rest.lastIndexOf(':');
      if (li < 0) continue;
      const screen = rest.slice(0, li), dt = rest.slice(li + 1);
      const v = await env.SIGNAGE_KV.get(k.name);
      if (v) { try { (screens[screen] = screens[screen] || {})[dt] = JSON.parse(v); } catch (e) {} }
      if (++n > 2000) break;
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor && n <= 2000);
  return json({ ok: true, loc, screens });
}

// ─── /grid/playlist + /screen/cache — pseudo-streaming (Fase A) ──────────────
// El servidor decide qué piezas puede emitir/descargar cada pantalla (playlist
// AUTORITATIVA y FINITA): parrilla (own/sold de /grid) + assets de sus reglas de
// segmentación (omnipublicity-api) resueltos a URL vía el índice público del Stock.
// El player pre-descarga ESA lista (Cache API) y reporta su estado a /screen/cache;
// el CMS lo pinta. Reutiliza los helpers de /grid (gridGetBookings/gridScreen/…).
const GRID_OMNIP_API = 'https://omnipublicity-api.csilvasantin.workers.dev';
async function gridStockIndexMap(env) {
  try {
    const r = await fetch(GRID_R2_PUBLIC + '/stock/index.json', { cf: { cacheTtl: 60 } });
    if (!r.ok) return new Map();
    const d = await r.json(); const arr = Array.isArray(d) ? d : (d.items || []);
    const m = new Map(); for (const it of arr) if (it && it.id) m.set(String(it.id), it); return m;
  } catch (e) { return new Map(); }
}
async function gridFetchSeg(target, env) {
  try { if (env && env.SIGNAGE_KV) return JSON.parse(await env.SIGNAGE_KV.get(segKey(target)) || 'null'); } catch (e) {}
  return null;
}
async function gridPlaylistHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  const screen = gridScreen(url.searchParams.get('screen')); if (!screen) return json({ error: 'missing-screen' }, { status: 400 });
  const date = gridDate(url.searchParams.get('date')) || gridNow().ymd;
  const seg = String(url.searchParams.get('seg') || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
  const items = [], seenUrl = new Set();
  const add = (it) => { if (it && it.url && !seenUrl.has(it.url)) { seenUrl.add(it.url); items.push(it); } };
  // 1) Parrilla: contenido propio + vendido (lo programado de verdad para esa pantalla).
  const bookings = await gridGetBookings(env, screen, date);
  for (const b of bookings) {
    if (!['own', 'sold', 'accepted'].includes(b.status)) continue;
    const c = b.creative; if (!c || !c.url) continue;
    add({ id: b.id, url: c.url, type: c.type || 'image', title: b.title || c.name || b.advertiser || 'Parrilla', source: 'grid', advertiser: b.advertiser || null, bandId: b.bandId || null });
  }
  // 2) Segmentación: los assets concretos de sus reglas (propias o, si no, la global).
  if (seg) {
    let mtx = await gridFetchSeg(seg, env);
    if (!mtx || !(mtx.rules || []).length) mtx = await gridFetchSeg('all', env);
    const ids = new Set();
    if (mtx) {
      for (const r of (mtx.rules || [])) for (const a of (r.assets || [])) ids.add(String(a));
      for (const a of ((mtx.default && mtx.default.assets) || [])) ids.add(String(a));
    }
    if (ids.size) {
      const idx = await gridStockIndexMap(env);
      for (const id of ids) { const s = idx.get(id); if (s && s.url) add({ id, url: s.url, type: s.type || 'image', title: s.title || '', source: 'seg' }); }
    }
  }
  return json({ ok: true, screen, date: gridFmtDate(date), total: items.length, items, generatedAt: Date.now() });
}
async function screenCacheHandler(req, env, url) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  if (req.method === 'GET') {
    const screen = gridScreen(url.searchParams.get('screen')); if (!screen) return json({ error: 'missing-screen' }, { status: 400 });
    let s = null; try { s = JSON.parse(await env.SIGNAGE_KV.get('screen:cache:' + screen) || 'null'); } catch (e) {}
    return json({ ok: true, screen, cache: s });
  }
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad-json' }, { status: 400 }); }
  const screen = gridScreen(b.screen); if (!screen) return json({ error: 'missing-screen' }, { status: 400 });
  const ready = Array.isArray(b.ready) ? b.ready.map(x => String(x).slice(0, 80)).slice(0, 300) : [];
  const downloading = Array.isArray(b.downloading) ? b.downloading.slice(0, 50).map(x => ({ id: String((x && x.id) || '').slice(0, 80), pct: Math.max(0, Math.min(100, (x && x.pct) | 0)) })) : [];
  const rec = { ready, readyCount: ready.length, total: Math.max(0, b.total | 0), downloading, bytes: Math.max(0, b.bytes | 0), at: Date.now() };
  const now = Date.now(), sig = JSON.stringify({ r: ready, t: rec.total, d: downloading.length });
  let prev = null; try { prev = JSON.parse(await env.SIGNAGE_KV.get('screen:cache:' + screen) || 'null'); } catch (e) {}
  if (prev && prev.__sig === sig && (now - (prev.at || 0)) < 60000) return json({ ok: true, screen, throttled: 'unchanged' });
  rec.__sig = sig;
  if (!(await reserveKvWrite(env, now))) return json({ ok: true, screen, throttled: kvWriteDenyReason(env) });
  try { await env.SIGNAGE_KV.put('screen:cache:' + screen, JSON.stringify(rec), { expirationTtl: 600 }); } catch (e) {}
  return json({ ok: true, screen, readyCount: rec.readyCount, total: rec.total });
}

export default {
  // Cron de respaldo (wrangler.toml → [triggers]): reconstruye stock/index.json
  // por si alguna regeneración post-mutación se perdió. Corre EN Cloudflare,
  // así que no le afecta el bloqueo de workers.dev de los ISP españoles.
  // + Informe de campañas al cierre del día (REPORT_HOUR Madrid, def 21h) a Telegram.
  async scheduled(event, env, ctx) {
    // Hay dos cron (*/2 y */10) y coinciden en cada minuto múltiplo de diez.
    // Si ambos consolidan, dos isolates pueden ver el marker ausente a la vez y
    // enviar el mismo resumen antes de que Workers KV propague el put. Un solo
    // cron es el dueño del flush; el */10 conserva sus otras tareas.
    if (shouldFlushNotificationAggregates(event)) {
      ctx.waitUntil(flushNotificationAggregates(env.SIGNAGE_KV, text => sendTelegram(env, text))
        .catch(() => console.warn('notification-aggregator-flush-failed')));
    }
    if (event && event.cron === '*/2 * * * *') {
      ctx.waitUntil(tgEntregarPendientes(env));
      ctx.waitUntil(agoraActivityMonitor(env));
      ctx.waitUntil(signageHealthMonitor(env));
    } else {
      ctx.waitUntil(rebuildAndSyncTaggedStock(env));
      ctx.waitUntil(maybeDailyReport(env));
      ctx.waitUntil(gridAlertsCheck(env, ctx));
    }
  },

  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') {
      // /da/* es un proxy público (lo consumen digitalavatar.ai, el gemelo, etc.)
      // → preflight abierto a cualquier origen, no solo a ALLOWED_ORIGINS.
      if (new URL(req.url).pathname.startsWith('/da/')) {
        return new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        } });
      }
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    const url = new URL(req.url);
    const path = url.pathname;
    const t0 = Date.now();
    let res;
    try {
      if (path === '/healthz') {
        res = json({ ok: true, hasElevenKey: !!env.ELEVENLABS_KEY, hasXaiKey: !!env.XAI_KEY, hasGcpKey: !!env.GCP_SA_KEY, hasGeminiKey: !!env.GEMINI_API_KEY, hasOpenRouterKey: !!env.OPENROUTER_KEY, hasStockBucket: !!env.STOCK_BUCKET, hasSignageKv: !!env.SIGNAGE_KV, notificationAggregatorAvailable: !!env.SIGNAGE_KV });
      } else if ((path === '/grok/latest.json' || path === '/grok/latest') && req.method === 'GET') {
        res = grokLatestHandler();
      } else if (path === '/grok/agent-ack' && req.method === 'POST') {
        res = await grokAgentAckHandler(req);
      } else if (path === '/tts' && req.method === 'POST') {
        res = await ttsHandler(req, env);
      } else if (path === '/dubbing' && req.method === 'POST') {
        res = await dubbingProxy(req, env, '/dubbing');
      } else if (path.match(/^\/dubbing\/[A-Za-z0-9_-]+\/audio\/[A-Za-z0-9_-]+$/) && req.method === 'GET') {
        res = await dubbingProxy(req, env, path, 'video/mp4, audio/mpeg, application/octet-stream');
      } else if (path.match(/^\/dubbing\/[A-Za-z0-9_-]+$/) && req.method === 'GET') {
        res = await dubbingProxy(req, env, path);
      } else if (path === '/megafonia/push' && req.method === 'POST') {
        res = await megafoniaPushHandler(req, env);
      } else if (path === '/megafonia/next' && req.method === 'GET') {
        res = await megafoniaNextHandler(req, env, url);
      } else if (path.startsWith('/megafonia/audio/') && req.method === 'GET') {
        res = await megafoniaAudioHandler(req, env, path.slice('/megafonia/audio/'.length));
      } else if (path === '/hilomusical/push' && req.method === 'POST') {
        res = await hiloMusicalPushHandler(req, env, ctx);
      } else if (path === '/hilomusical/next' && req.method === 'GET') {
        res = await hiloMusicalNextHandler(req, env, url);
      } else if ((path === '/hilomusical/next' || path === '/megafonia/next') && req.method === 'DELETE') {
        // Reset de cola por tienda (limpieza / reinicio de demo).
        const st = String(url.searchParams.get('store') || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
        const key = (path === '/megafonia/next' ? 'megafonia:q:' : 'hilomusical:q:') + st;
        if (env.SIGNAGE_KV) await env.SIGNAGE_KV.delete(key);
        res = json({ ok: true, cleared: key });
      } else if (path === '/segmentado/generate' && req.method === 'POST') {
        res = await segmentadoGenerateHandler(req, env, ctx);
      } else if (path.startsWith('/da/') && (req.method === 'POST' || req.method === 'GET')) {
        res = await daProxyHandler(req, env);
      } else if ((path === '/locations' || path.startsWith('/locations/')) && (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT')) {
        res = await locationsProxyHandler(req, env);
      } else if (path === '/day/save' && req.method === 'POST') {
        res = await daySaveHandler(req, env);
      } else if (path === '/day/range' && req.method === 'GET') {
        res = await dayRangeHandler(req, env, url);
      } else if (path === '/day/delete' && (req.method === 'POST' || req.method === 'DELETE')) {
        res = await dayDeleteHandler(req, env);
      } else if (path === '/emit' && req.method === 'POST') {
        res = await emitSaveHandler(req, env);
      } else if (path === '/emit/range' && req.method === 'GET') {
        res = await emitRangeHandler(req, env, url);
      } else if (path === '/audience' && req.method === 'POST') {
        res = await audienceSaveHandler(req, env);
      } else if (path === '/audience/range' && req.method === 'GET') {
        res = await audienceRangeHandler(req, env, url);
      } else if (path === '/grid/day' && req.method === 'GET') {
        res = await gridDayHandler(req, env, url);
      } else if (path === '/grid/range' && req.method === 'GET') {
        res = await gridRangeHandler(req, env, url);
      } else if (path === '/grid/sales' && req.method === 'GET') {
        res = await gridSalesHandler(req, env, url);
      } else if (path === '/grid/ics' && req.method === 'GET') {
        res = await gridIcsHandler(req, env, url);
      } else if (path === '/segmentation/assigned' && req.method === 'GET') {
        res = await segAssignedHandler(req, env);
      } else if (path === '/segmentation/hits') {
        res = await segHitsHandler(req, env);
      } else if (path === '/segmentation') {
        res = await segmentationHandler(req, env, url);
      } else if (path === '/pay' && req.method === 'POST') {
        res = await payHandler(req, env, ctx);
      } else if (path === '/pay/list' && req.method === 'GET') {
        res = await payListHandler(req, env, url);
      } else if (path === '/grid/config') {
        res = await gridConfigHandler(req, env, url);
      } else if (path === '/grid/book' && req.method === 'POST') {
        res = await gridBookHandler(req, env);
      } else if (path === '/grid/rundown' && req.method === 'POST') {
        res = await gridRundownHandler(req, env);
      } else if (path === '/grid/tag-sync') {
        res = await gridTagSyncHandler(req, env);
      } else if (path === '/grid/unbook' && req.method === 'POST') {
        res = await gridUnbookHandler(req, env);
      } else if (path === '/grid/offer' && req.method === 'POST') {
        res = await gridOfferHandler(req, env);
      } else if (path === '/grid/decide' && req.method === 'POST') {
        res = await gridDecideHandler(req, env);
      } else if (path === '/grid/control') {
        res = await gridControlHandler(req, env, url);
      } else if (path === '/grid/emit' && req.method === 'POST') {
        res = await gridEmitHandler(req, env);
      } else if (path === '/grid/upload' && req.method === 'POST') {
        res = await gridUploadHandler(req, env, url);
      } else if (path === '/grid/screens' && req.method === 'GET') {
        res = await gridScreensHandler(req, env);
      } else if (path === '/grid/projects') {
        res = await gridProjectsHandler(req, env);
      } else if (path === '/grid/draft') {
        res = await gridDraftHandler(req, env, url);
      } else if (path === '/grid/playlist' && req.method === 'GET') {
        res = await gridPlaylistHandler(req, env, url);
      } else if (path === '/screen/cache' && (req.method === 'GET' || req.method === 'POST')) {
        res = await screenCacheHandler(req, env, url);
      } else if (path === '/segcpm' && req.method === 'GET') {
        res = await segCpmGetHandler(req, env, url);
      } else if (path === '/segcpm' && (req.method === 'PUT' || req.method === 'POST')) {
        res = await segCpmPutHandler(req, env, url);
      } else if (path === '/campaign' && req.method === 'POST') {
        res = await campaignCreateHandler(req, env);
      } else if (path === '/campaign/list' && req.method === 'GET') {
        res = await campaignListHandler(req, env, url);
      } else if (path === '/campaign/delete' && (req.method === 'POST' || req.method === 'DELETE')) {
        res = await campaignDeleteHandler(req, env);
      } else if (path === '/campaign/report' && (req.method === 'POST' || req.method === 'GET')) {
        // Dispara YA el informe de campañas a Telegram (el mismo que el cron de las 21h).
        const ymd = madridParts().ymd;
        const sent = await dailyCampaignReport(env, ymd);
        res = json({ ok: true, sent, ymd });
      } else if (path === '/rtb/decide' && req.method === 'POST') {
        res = await rtbDecideHandler(req, env, url);
      } else if (path === '/rtb/feed' && req.method === 'GET') {
        res = await rtbFeedHandler(req, env, url);
      } else if (path === '/tts/free' && req.method === 'POST') {
        res = await ttsFreeHandler(req);
      } else if (path === '/xai/image' && req.method === 'POST') {
        res = await xaiImageHandler(req, env);
      } else if (path === '/image/edit' && req.method === 'POST') {
        res = await imageEditHandler(req, env);
      } else if (path === '/twin/match' && req.method === 'POST') {
        res = await twinMatchHandler(req, env);
      } else if (path === '/twin/save' && req.method === 'POST') {
        res = await twinSaveHandler(req, env);
      } else if (path === '/twin/list' && req.method === 'GET') {
        res = await twinListHandler(req, env);
      } else if (path === '/twin/reset' && req.method === 'POST') {
        res = await twinResetHandler(req, env);
      } else if (path === '/twin/spawn' && req.method === 'POST') {
        res = await npcSpawnHandler(req, env);
      } else if (path === '/twin/spawn/pending' && req.method === 'GET') {
        res = await npcPendingHandler(req, env, url);
      } else if (path === '/twin/spawn/clear' && req.method === 'POST') {
        res = await npcClearHandler(req, env);
      } else if (path === '/twin/spawn/ack' && req.method === 'POST') {
        res = await npcAckHandler(req, env);
      } else if (path === '/twin/spawn/status' && req.method === 'GET') {
        res = await npcStatusHandler(req, env, url);
      } else if (path === '/image/proxy' && req.method === 'GET') {
        res = await imageProxyHandler(req);
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
      } else if (path === '/newsletter/subscribe' && req.method === 'POST') {
        res = await newsletterSubscribeHandler(req, env);
      } else if (path === '/newsletter/count' && req.method === 'GET') {
        res = await newsletterCountHandler(req, env);
      } else if (path === '/agora/gasto') {
        // Solo lectura: en que se van las escrituras de KV hoy. Sin esto, cuando
        // el tope corta hay que adivinar quien lo gasto (5-ago-2026).
        if (!agoraAuth(env, url.searchParams.get('key'))) return json({ error: 'unauthorized' }, { status: 401 });
        const hoy = new Date().toISOString().slice(0, 10);
        const gasto = JSON.parse((await env.SIGNAGE_KV.get('kvgasto:' + hoy)) || '{}');
        const usado = parseInt(await env.SIGNAGE_KV.get('kvbudget:' + hoy), 10) || 0;
        const tope = parseInt(env.KV_DAILY_WRITE_CAP, 10) || KV_DAILY_WRITE_CAP_DEFAULT;
        return json({ dia: hoy, usado, tope, restante: Math.max(0, tope - usado),
          por_prefijo: Object.fromEntries(Object.entries(gasto).sort((a, b) => b[1] - a[1])) });
      } else if (path === '/agora/presence') {
        res = await agoraPresenceHandler(req, env, url);
      } else if (path === '/agora/feed') {
        res = await agoraFeedHandler(req, env, url, ctx);
      } else if (path === '/agora/hook' && req.method === 'POST') {
        res = await agoraHookHandler(req, env, url, ctx);
      } else if (path === '/agora/enqueue' && req.method === 'POST') {
        res = await agoraEnqueueHandler(req, env);
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
      } else if (path === '/signage/assign' && req.method === 'POST') {
        res = await signageAssignHandler(req, env);
      } else if (path === '/signage/shot' && req.method === 'POST') {
        res = await signageShotPostHandler(req, env);
      } else if (path === '/signage/shot' && req.method === 'GET') {
        res = await signageShotGetHandler(req, env, url);
      } else if (path === '/notify' && req.method === 'POST') {
        res = await notifyHandler(req, env, ctx);
      } else if (path === '/telegram/webhook' && req.method === 'POST') {
        res = await telegramWebhookHandler(req, env, ctx);
      } else if (path === '/telegram/setup' && req.method === 'GET') {
        res = await telegramSetupHandler(req, env, url);
      } else if (path === '/stock/publish' && req.method === 'POST') {
        res = await stockPublishHandler(req, env, ctx);
      } else if (path === '/stock/reindex' && req.method === 'POST') {
        // Reconstruye el índice (asigna num a los assets sin él) bajo demanda. Auth NOTIFY_KEY.
        let _b = {}; try { _b = await req.json(); } catch {}
        if (!env.NOTIFY_KEY || _b.secret !== env.NOTIFY_KEY) { res = json({ error: 'unauthorized' }, { status: 401 }); }
        else { await rebuildStockIndex(env); res = json({ ok: true, reindexed: true }); }
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
      } else if (path === '/layout/report' && req.method === 'POST') {
        res = await layoutReportHandler(req, env);
      } else if (path === '/twin/cmd' && req.method === 'POST') {
        res = await twinCmdPostHandler(req, env);
      } else if (path === '/twin/cmd' && req.method === 'GET') {
        res = await twinCmdGetHandler(req, env, url);
      } else if (path === '/twin/result' && req.method === 'POST') {
        res = await twinResultPostHandler(req, env);
      } else if (path === '/twin/result' && req.method === 'GET') {
        res = await twinResultGetHandler(req, env, url);
      } else if (path === '/layout/current' && req.method === 'GET') {
        res = await layoutCurrentHandler(req, env, url);
      } else if (path === '/xpacio' && req.method === 'GET') {
        res = await xpacioGetHandler(req, env, url);
      } else if (path === '/xpacio/buy' && req.method === 'POST') {
        res = await xpacioBuyHandler(req, env);
      } else if (path === '/xpacio/credit' && req.method === 'POST') {
        res = await xpacioCreditHandler(req, env);
      } else if (path === '/xpacio/update' && req.method === 'POST') {
        res = await xpacioUpdateHandler(req, env);
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
    await handleAutomaticHttpNotification(ctx, env, req, path, res, ms);
    const cors = corsHeaders(req);
    Object.entries(cors).forEach(([k, v]) => {
      // No pisar un Access-Control-Allow-Origin:* que el handler ponga a propósito
      // (p.ej. /image/proxy: imagen pública sin credenciales, legible desde cualquier origen).
      if (k === 'Access-Control-Allow-Origin' && res.headers.get(k) === '*') return;
      res.headers.set(k, v);
    });
    return res;
  },
};

export function shouldFlushNotificationAggregates(event) {
  return !!event && event.cron === '*/2 * * * *';
}
