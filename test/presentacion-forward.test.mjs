import test from 'node:test';
import assert from 'node:assert/strict';
import { esParaPresentacion, reenviarPresentacion, PVN_HOOK_URL } from '../src/presentacion-forward.mjs';

const env = { TELEGRAM_CHAT_ID: '1234567', PVN_TELEGRAM_HOOK_SECRET: 's3cr3t' };
const carlos = { id: 1234567 }, chat = { id: 1234567, type: 'private' };

test('solo reenvía del dueño, en su chat, respuestas a diapositivas o /editar', () => {
  assert.equal(esParaPresentacion({ from: carlos, chat, text: '/editar 3.2 hola' }, env), true);
  assert.equal(esParaPresentacion({ from: carlos, chat, text: '/deshacer' }, env), true);
  assert.equal(esParaPresentacion({ from: carlos, chat, text: 'nuevo', reply_to_message: { text: '🎞 3 · Pasaporte\n\nPVN·ES·3' } }, env), true);
  assert.equal(esParaPresentacion({ from: carlos, chat, text: 'https://youtu.be/x' }, env), false, 'las importaciones de Stock siguen igual');
  assert.equal(esParaPresentacion({ from: carlos, chat, text: 'nuevo', reply_to_message: { text: 'otro aviso' } }, env), false);
  assert.equal(esParaPresentacion({ from: { id: 9 }, chat, text: '/editar 1 x' }, env), false, 'nadie más');
  assert.equal(esParaPresentacion({ from: carlos, chat: { id: -100 }, text: '/editar 1 x' }, env), false, 'ni en grupos');
  assert.equal(esParaPresentacion({ from: carlos, chat, text: '/editar 1 x' }, { TELEGRAM_CHAT_ID: '1234567' }), false, 'sin secreto, apagado');
});

test('reenvía con el secreto y devuelve la confirmación del sitio', async () => {
  let seen;
  const reply = await reenviarPresentacion({ message: { text: 'x' } }, env, async (u, init) => { seen = { u, h: init.headers }; return new Response(JSON.stringify({ ok: true, reply: '✅ Diapositiva 3 actualizada' })); });
  assert.equal(seen.u, PVN_HOOK_URL); assert.equal(seen.h['X-PVN-Hook-Secret'], 's3cr3t');
  assert.equal(reply, '✅ Diapositiva 3 actualizada');
  assert.match(await reenviarPresentacion({}, env, async () => new Response('x', { status: 500 })), /HTTP 500/);
  assert.match(await reenviarPresentacion({}, env, async () => { throw new Error('down'); }), /no responde/);
});
