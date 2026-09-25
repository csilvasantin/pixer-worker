// Clip desde imagen: 5 segundos exactos, imagen subida o asset del Stock.
// La imagen de origen no se vuelve a publicar. El clip sí entra en la biblioteca.

export const CLIP_SECONDS = 5;
export const MAX_SCENES = 6;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function clipMode(body) {
  if (!body || typeof body !== 'object') return false;
  return Boolean(body.image || body.stock_id || body.stockId || (Array.isArray(body.scenes) && body.scenes.length));
}

export function durationError(body) {
  if (!body || !(body.image || body.stock_id || body.stockId)) return null;
  if (body.duration != null && Number(body.duration) !== CLIP_SECONDS) {
    return { error: 'exact-duration-5', duration: CLIP_SECONDS };
  }
  return null;
}

function b64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function dataUrlFromImageField(image) {
  const raw = String(image || '').trim();
  if (!raw) return { error: 'missing-image' };
  if (/^https:\/\//i.test(raw)) return { error: 'image-must-be-upload-or-stock' };
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(raw);
  if (!m) return { error: 'bad-image' };
  const bytes = Uint8Array.from(atob(m[2].replace(/\s/g, '')), (c) => c.charCodeAt(0));
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return { error: 'image-too-big', max: MAX_IMAGE_BYTES };
  return { url: `data:${m[1].toLowerCase()};base64,${b64(bytes)}` };
}

export async function stockImageDataUrl(env, stockId) {
  const id = String(stockId || '').trim();
  if (!/^[A-Za-z0-9-]{4,80}$/.test(id)) return { error: 'bad-stock-id' };
  if (!env || !env.STOCK_BUCKET) return { error: 'r2-not-bound' };
  const metaObj = await env.STOCK_BUCKET.get(`stock/${id}/meta.json`);
  if (!metaObj) return { error: 'stock-not-found' };
  const meta = await metaObj.json();
  const key = String((meta && meta.assetKey) || '');
  if (!key.startsWith(`stock/${id}/`)) return { error: 'stock-no-asset' };
  const obj = await env.STOCK_BUCKET.get(key);
  if (!obj) return { error: 'stock-not-found' };
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return { error: 'image-too-big', max: MAX_IMAGE_BYTES };
  const mime = String((obj.httpMetadata && obj.httpMetadata.contentType) || meta.mime || '');
  if (!/^image\//i.test(mime)) return { error: 'stock-not-image' };
  return { url: `data:${mime};base64,${b64(bytes)}`, id };
}

export function xaiClipPayload({ prompt, imageUrl, aspect = '16:9', resolution = '720p' }) {
  const body = {
    model: 'grok-imagine-video',
    prompt: String(prompt || '').slice(0, 4000),
    duration: CLIP_SECONDS,
    aspect_ratio: aspect === '9:16' ? '9:16' : '16:9',
    resolution: resolution === '480p' ? '480p' : '720p',
  };
  if (imageUrl) body.image = { url: imageUrl };
  return body;
}

export function normalizeScenes(body) {
  const scenes = Array.isArray(body && body.scenes) ? body.scenes : null;
  if (!scenes) return { error: 'missing-scenes' };
  if (scenes.length < 1 || scenes.length > MAX_SCENES) return { error: 'scenes-1-to-6', max: MAX_SCENES };
  const out = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i] || {};
    const text = String(scene.text || scene.prompt || '').trim();
    if (!text) return { error: 'scene-missing-text', index: i };
    if (!(scene.image || scene.stock_id || scene.stockId)) return { error: 'scene-missing-image', index: i };
    if (scene.duration != null && Number(scene.duration) !== CLIP_SECONDS) {
      return { error: 'exact-duration-5', index: i, duration: CLIP_SECONDS };
    }
    out.push({
      index: i,
      text: text.slice(0, 4000),
      image: scene.image || '',
      stock_id: scene.stock_id || scene.stockId || '',
    });
  }
  return { scenes: out };
}

export function archiveBody({ providerUrl, prompt, title }) {
  return {
    type: 'video',
    motor: 'grok-imagine-video',
    prompt: String(prompt || 'clip desde imagen').slice(0, 1000),
    title: String(title || 'Clip 5s').slice(0, 300),
    sourceUrl: providerUrl,
    mime: 'video/mp4',
    tags: ['clip', '5s'],
    comment: 'Clip de 5 s guardado en la biblioteca. La URL temporal del proveedor no es la pieza.',
  };
}

export function providerVideoUrl(poll) {
  return (poll && poll.video && poll.video.url) || (poll && poll.url) || '';
}

export function pollFinished(poll) {
  const status = String((poll && (poll.status || poll.state)) || '').toLowerCase();
  return status === 'done' || status === 'completed' || status === 'succeeded';
}
