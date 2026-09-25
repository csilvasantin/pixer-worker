import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveBody, dataUrlFromImageField, durationError, normalizeScenes, pollFinished, providerVideoUrl, xaiClipPayload } from '../src/clip-from-image.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('el clip desde imagen dura 5 segundos y lleva la imagen', () => {
  assert.deepEqual(durationError({ image: PNG, duration: 8 }), { error: 'exact-duration-5', duration: 5 });
  assert.equal(durationError({ image: PNG, duration: 5 }), null);
  const payload = xaiClipPayload({ prompt: 'la taza gira', imageUrl: 'data:image/png;base64,aaa', aspect: '16:9' });
  assert.equal(payload.duration, 5);
  assert.equal(payload.model, 'grok-imagine-video');
  assert.equal(payload.image.url, 'data:image/png;base64,aaa');
});

test('una URL pública no sirve como imagen de origen', () => {
  assert.equal(dataUrlFromImageField('https://example.com/a.jpg').error, 'image-must-be-upload-or-stock');
  assert.equal(dataUrlFromImageField(PNG).url.startsWith('data:image/png;base64,'), true);
});

test('un guion son de 1 a 6 escenas, cada una con imagen y texto', () => {
  const ok = normalizeScenes({ scenes: [
    { text: 'entra', image: PNG },
    { text: 'mira', stock_id: 'asset-1' },
  ] });
  assert.equal(ok.scenes.length, 2);
  assert.equal(normalizeScenes({ scenes: [] }).error, 'scenes-1-to-6');
  assert.equal(normalizeScenes({ scenes: Array.from({ length: 7 }, () => ({ text: 'x', image: PNG })) }).error, 'scenes-1-to-6');
  assert.equal(normalizeScenes({ scenes: [{ image: PNG }] }).error, 'scene-missing-text');
  assert.equal(normalizeScenes({ scenes: [{ text: 'hola' }] }).error, 'scene-missing-image');
});

test('el clip terminado se guarda en Stock, no con el enlace temporal', () => {
  const poll = { status: 'done', video: { url: 'https://vidgen.x.ai/tmp/abc.mp4' } };
  assert.equal(pollFinished(poll), true);
  assert.equal(providerVideoUrl(poll), 'https://vidgen.x.ai/tmp/abc.mp4');
  const body = archiveBody({ providerUrl: providerVideoUrl(poll), prompt: 'gira', title: 'Escena 1' });
  assert.equal(body.type, 'video');
  assert.equal(body.mime, 'video/mp4');
  assert.equal(body.sourceUrl.includes('vidgen.x.ai'), true);
  assert.equal(body.comment.includes('biblioteca'), true);
});
