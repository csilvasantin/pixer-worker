import test from 'node:test';
import assert from 'node:assert/strict';
import { signagePushMerecetAviso } from '../src/index.js';
// FLT-1779: un SIGNAGE PUSH automático no es noticia; uno humano o con INTERRUPT sí.
test('idle, localhost, blob y source unknown callan', () => {
  assert.equal(signagePushMerecetAviso({ assetLabel: '[scr:totem] _idle_', sourceLabel: 'unknown', pageUrl: 'http://127.0.0.1:5858', src: 'about:blank' }), false);
  assert.equal(signagePushMerecetAviso({ assetLabel: '[scr:escaparate] Daluwi Torres', sourceLabel: 'unknown', pageUrl: 'https://www.xpaceos.com', src: 'blob:https://www.xpaceos.com/x' }), false);
  assert.equal(signagePushMerecetAviso({ assetLabel: 'Anuncio', sourceLabel: 'control', pageUrl: 'about:blank', src: '' }), false);
});
test('un INTERRUPT o un envío desde el mando avisan', () => {
  assert.equal(signagePushMerecetAviso({ interrupt: true, assetLabel: 'Aviso urgente', sourceLabel: 'unknown', pageUrl: 'https://www.admira.live/control', src: '' }), true);
  assert.equal(signagePushMerecetAviso({ assetLabel: 'Campaña Decathlon', sourceLabel: 'admira.live/control', pageUrl: 'https://www.admira.live/control', src: 'https://stock.admira.store/stock/x/asset.mp4' }), true);
});
