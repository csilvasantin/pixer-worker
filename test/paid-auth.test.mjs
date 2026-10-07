import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizePaidGeneration, isPaidGeneration, verifyPixeriaApiToken } from '../src/paid-auth.mjs';

function req(headers = {}) {
  return new Request('https://api.admira.store/xai/video', { method: 'POST', headers });
}

async function token(secret, payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  const part = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`api:${part}`)));
  let sig = '';
  for (const b of sigBytes) sig += String.fromCharCode(b);
  return `${part}.${btoa(sig).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

test('la generación de pago está cerrada y /tts/free sigue abierto', () => {
  assert.equal(isPaidGeneration('POST', '/xai/video'), true);
  assert.equal(isPaidGeneration('POST', '/xai/image'), true);
  assert.equal(isPaidGeneration('POST', '/veo/generate'), true);
  assert.equal(isPaidGeneration('GET', '/veo/status/operations/abc'), true);
  assert.equal(isPaidGeneration('GET', '/veo/download'), true);
  assert.equal(isPaidGeneration('POST', '/imagen/generate'), true);
  assert.equal(isPaidGeneration('POST', '/lyria3/generate'), true);
  assert.equal(isPaidGeneration('POST', '/tts'), true);
  assert.equal(isPaidGeneration('POST', '/tts/free'), false);
  assert.equal(isPaidGeneration('GET', '/healthz'), false);
  assert.equal(isPaidGeneration('POST', '/xai/video/scenes'), true);
});

test('sin clave la puerta responde que no', async () => {
  const auth = await authorizePaidGeneration(req(), { NOTIFY_KEY: 'flota-secreta' });
  assert.equal(auth.ok, false);
});

test('con la clave de flota la puerta responde ok', async () => {
  const auth = await authorizePaidGeneration(req({ 'X-Fleet-Key': 'flota-secreta' }), { NOTIFY_KEY: 'flota-secreta' });
  assert.deepEqual(auth, { ok: true, via: 'fleet' });
  const bearer = await authorizePaidGeneration(req({ Authorization: 'Bearer flota-secreta' }), { FLEET_KEY: 'flota-secreta' });
  assert.equal(bearer.ok, true);
});

test('una clave distinta no pasa', async () => {
  const auth = await authorizePaidGeneration(req({ 'X-Fleet-Key': 'otra' }), { NOTIFY_KEY: 'flota-secreta' });
  assert.equal(auth.ok, false);
});

test('la sesión de Pixeria abre la puerta y un token caducado no', async () => {
  const now = Math.floor(Date.now() / 1000);
  const good = await token('firma', { v: 1, aud: 'api.admira.store', email: 'csilva@admira.com', iat: now, exp: now + 60 });
  const session = await authorizePaidGeneration(req({ Authorization: `Bearer ${good}` }), { PIXERIA_SIGNING_KEY: 'firma' }, async () => { throw new Error('no-red'); });
  assert.equal(session.ok, true);
  assert.equal(session.via, 'session');
  const old = await token('firma', { v: 1, aud: 'api.admira.store', email: 'csilva@admira.com', iat: now - 120, exp: now - 1 });
  const expired = await verifyPixeriaApiToken(old, 'firma', now);
  assert.equal(expired, null);
});

test('Studio uses its own signed-session verifier even with the Pixeria local key configured',async()=>{
  for(const origin of ['https://admira.studio','https://www.admira.studio']){
    let called=0;const r=await authorizePaidGeneration(req({Origin:origin,Authorization:'Bearer studio-session'}),{PIXERIA_SIGNING_KEY:'pixeria-key'},async(url,init)=>{called++;assert.equal(url,'https://admira.studio/auth/verify');assert.deepEqual(JSON.parse(init.body),{token:'studio-session'});return Response.json({ok:true,email:'allowed@example.test'});});
    assert.equal(called,1);assert.deepEqual(r,{ok:true,via:'session',email:'allowed@example.test'});
  }
});
test('forged Studio origin or rejected/failed verifier cannot authorize generation',async()=>{
  const origin='https://admira.studio';
  for(const fetchImpl of [async()=>Response.json({ok:false},{status:401}),async()=>{throw new Error('offline')}])assert.deepEqual(await authorizePaidGeneration(req({Origin:origin,Authorization:'Bearer invalid'}),{PIXERIA_SIGNING_KEY:'pixeria-key'},fetchImpl),{ok:false});
  for(const origin of ['https://admira.studio.evil.test','http://admira.studio','https://other.test']){
    let called=0;const r=await authorizePaidGeneration(req({Origin:origin,Authorization:'Bearer invalid'}),{PIXERIA_SIGNING_KEY:'pixeria-key'},async()=>{called++;return Response.json({ok:true});});assert.equal(called,0);assert.equal(r.ok,false);
  }
});
test('Studio origin without bearer never calls its verifier',async()=>{
  let calls=0;const r=await authorizePaidGeneration(req({Origin:'https://admira.studio'}),{},async()=>{calls++;return Response.json({ok:true});});assert.equal(r.ok,false);assert.equal(calls,0);
});
