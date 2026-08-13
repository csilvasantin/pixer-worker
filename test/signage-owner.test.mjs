import test from 'node:test';
import assert from 'node:assert/strict';

import { signageClaimOwner, signageOwnerDecision, signageProducerPriority } from '../src/index.js';

function envWithStrongNativeMarker() {
  const objects = new Map();
  return {
    SIGNAGE_KV: {
      async get() { return null; },
      async put() {},
    },
    STOCK_BUCKET: {
      async put(key, value) { objects.set(key, value); },
      async head(key) { return objects.has(key) ? { key } : null; },
    },
    objects,
  };
}

test('el player macOS tiene prioridad sobre una pestaña web', () => {
  assert.ok(
    signageProducerPriority('AdmiraMacOSPlayer/2.0', true) >
    signageProducerPriority('Mozilla/5.0 Chrome/151', true),
  );
});

test('el mismo productor conserva la concesión', () => {
  const now = 1_000_000;
  const owner = { producer: 'native-a', priority: 22, seen: now - 10_000 };
  assert.equal(signageOwnerDecision(owner, { producer: 'native-a', priority: 22 }, now), 'accept');
});

test('una pestaña no puede pisar al player nativo vivo', () => {
  const now = 1_000_000;
  const owner = { producer: 'native-a', priority: 22, seen: now - 10_000 };
  assert.equal(signageOwnerDecision(owner, { producer: 'chrome-a', priority: 12 }, now), 'reject');
});

test('el player nativo recupera inmediatamente una pantalla tomada por Chrome', () => {
  const now = 1_000_000;
  const owner = { producer: 'chrome-a', priority: 12, seen: now - 10_000 };
  assert.equal(signageOwnerDecision(owner, { producer: 'native-a', priority: 22 }, now), 'claim');
});

test('una concesión caducada puede ser reclamada', () => {
  const now = 1_000_000;
  const owner = { producer: 'native-a', priority: 22, seen: now - 76_000 };
  assert.equal(signageOwnerDecision(owner, { producer: 'native-b', priority: 22 }, now), 'claim');
});

test('un latido nativo blinda fuertemente la pantalla frente a Chrome', async () => {
  const env = envWithStrongNativeMarker();
  const nativeReq = { headers: new Headers({ 'User-Agent': 'AdmiraMacOSPlayer/2.0' }) };
  const chromeReq = { headers: new Headers({ 'User-Agent': 'Mozilla/5.0 Chrome/151' }) };
  const native = await signageClaimOwner(env, 'macbookairazul', { producer: 'native-a' }, nativeReq, 1_000_000);
  const chrome = await signageClaimOwner(env, 'macbookairazul', { producer: 'chrome-a' }, chromeReq, 1_001_000);
  assert.equal(native.ok, true);
  assert.equal(chrome.ok, false);
  assert.equal(chrome.owner.native, true);
});
