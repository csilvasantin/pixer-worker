import test from 'node:test';
import assert from 'node:assert/strict';
import { signageHealthMonitor, SCREENS_INDEX } from '../src/index.js';

// FLT-1779 (5-sep-2026): el monitor de pantallas ya no oscila «MUDAS / de vuelta» cada
// pocos minutos: histéresis de dos comprobaciones y silencio para las intermitentes.

function kvFalso(inicial = {}) {
  const store = new Map(Object.entries(inicial));
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); } };
}
function envCon(kv, ahora) {
  const enviados = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { enviados.push(JSON.parse(init.body).text); return new Response('{"ok":true}', { status: 200 }); };
  const env = { SIGNAGE_KV: kv, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' };
  return { env, enviados, restaurar: () => { globalThis.fetch = realFetch; } };
}
const realNow = Date.now;
function pantalla(kv, id, vistaHace, ahora) { kv.store.set(`screen:${id}`, JSON.stringify({ last_seen: ahora - vistaHace, locName: id })); }

test('un latido tardío aislado no dispara MUDA ni de vuelta; hacen falta dos lecturas seguidas', async () => {
  const kv = kvFalso({ [SCREENS_INDEX]: JSON.stringify(['xtore']) });
  const t0 = 1_800_000_000_000; let ahora = t0; Date.now = () => ahora;
  const { env, enviados, restaurar } = envCon(kv);
  try {
    pantalla(kv, 'xtore', 60_000, ahora); await signageHealthMonitor(env);          // primera aparición: se registra
    ahora += 120_000; pantalla(kv, 'xtore', 5 * 60_000, ahora); await signageHealthMonitor(env); // 1ª lectura muda
    assert.equal(enviados.length, 0, 'una sola lectura sin señal no avisa');
    ahora += 120_000; pantalla(kv, 'xtore', 30_000, ahora); await signageHealthMonitor(env);     // vuelve la señal
    assert.equal(enviados.length, 0, 'ni MUDA ni de vuelta: no llegó a anunciarse nada');
    ahora += 120_000; pantalla(kv, 'xtore', 5 * 60_000, ahora); await signageHealthMonitor(env);
    ahora += 120_000; pantalla(kv, 'xtore', 7 * 60_000, ahora); await signageHealthMonitor(env); // 2ª seguida
    assert.equal(enviados.length, 1); assert.match(enviados[0], /MUDAS/);
    ahora += 120_000; pantalla(kv, 'xtore', 30_000, ahora); await signageHealthMonitor(env);
    ahora += 120_000; pantalla(kv, 'xtore', 30_000, ahora); await signageHealthMonitor(env);
    assert.equal(enviados.length, 2); assert.match(enviados[1], /de vuelta/);
  } finally { restaurar(); Date.now = realNow; }
});

test('a la tercera oscilación en una hora se avisa INTERMITENTE una vez y se calla', async () => {
  const kv = kvFalso({ [SCREENS_INDEX]: JSON.stringify(['rosa']) });
  const t0 = 1_800_000_000_000; let ahora = t0; Date.now = () => ahora;
  const { env, enviados, restaurar } = envCon(kv);
  try {
    pantalla(kv, 'rosa', 30_000, ahora); await signageHealthMonitor(env);
    const ciclo = async (online) => { for (let i = 0; i < 2; i++) { ahora += 120_000; pantalla(kv, 'rosa', online ? 30_000 : 6 * 60_000, ahora); await signageHealthMonitor(env); } };
    await ciclo(false); await ciclo(true);            // vaivén 1 y 2: MUDAS + de vuelta
    assert.equal(enviados.length, 2);
    await ciclo(false);                                // vaivén 3 → intermitente
    assert.equal(enviados.length, 3); assert.match(enviados[2], /INTERMITENTES/); assert.match(enviados[2], /3 vaivenes/);
    await ciclo(true); await ciclo(false); await ciclo(true);
    assert.equal(enviados.length, 3, 'silencio mientras dura la hora de mute');
  } finally { restaurar(); Date.now = realNow; }
});
