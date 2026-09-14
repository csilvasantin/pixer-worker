import test from 'node:test';
import assert from 'node:assert/strict';

import { applyCircuit, circuitWriteAllowed, gridCircuitsHandler, parseCircuitRequest } from '../src/grid-circuits.mjs';

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200 });
const DEFAULT = [{ id: 'kiosk', name: 'CanalKiosk', circuits: ['kiosko'] }];

function kv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
}
const post = (body, auth) => new Request('https://x/grid/circuits', { method: 'POST', body: JSON.stringify(body),
  headers: auth ? { Authorization: 'Bearer ' + auth } : {} });

test('valida el id del circuito y el canal', () => {
  assert.equal(parseCircuitRequest({ circuit: 'Mi Circuito!' }).id, 'micircuito');
  assert.equal(parseCircuitRequest({ circuit: 'x' }).error, 'bad-circuit');
  assert.equal(parseCircuitRequest({ circuit: 'ok', project: '!!' }).error, 'bad-project');
  assert.equal(parseCircuitRequest({ circuit: 'ok', name: '<b>Tienda</b>' }).name, 'bTienda/b');
});

test('alta sin canal queda en el registro y no toca los canales', () => {
  const r = applyCircuit([], DEFAULT, parseCircuitRequest({ circuit: 'farmacias', source: 'yokup', actor: 'a@admira.com' }), 't');
  assert.equal(r.created, true);
  assert.equal(r.projectsChanged, false);
  assert.deepEqual(r.entry, { id: 'farmacias', name: 'farmacias', project: '', source: 'yokup', created_by: 'a@admira.com', created_at: 't', updated_at: 't' });
});

test('alta con canal existente añade el circuito una sola vez', () => {
  const req = parseCircuitRequest({ circuit: 'kiosko-bcn', project: 'kiosk' });
  const a = applyCircuit([], DEFAULT, req, 't1');
  assert.deepEqual(a.projects[0].circuits, ['kiosko', 'kiosko-bcn']);
  const b = applyCircuit(a.circuits, a.projects, req, 't2');
  assert.equal(b.created, false);
  assert.equal(b.projectsChanged, false);
  assert.deepEqual(b.projects[0].circuits, ['kiosko', 'kiosko-bcn']);
  assert.deepEqual(DEFAULT[0].circuits, ['kiosko'], 'no muta la entrada');
});

test('un canal nuevo se crea con su nombre', () => {
  const r = applyCircuit([], DEFAULT, parseCircuitRequest({ circuit: 'farmacias', project: 'canal-farma', project_name: 'Canal Farma' }), 't');
  assert.equal(r.projectCreated, true);
  assert.deepEqual(r.projects[1], { id: 'canal-farma', name: 'Canal Farma', circuits: ['farmacias'] });
});

test('solo escribe con la clave de servicio o la GRID_KEY', () => {
  const env = { CIRCUIT_SERVICE_KEY: 'svc-123', GRID_KEY: 'grid-9' };
  assert.equal(circuitWriteAllowed(env, post({}, 'svc-123'), {}), 'service');
  assert.equal(circuitWriteAllowed(env, post({}, 'svc-124'), {}), '');
  assert.equal(circuitWriteAllowed(env, post({}), { key: 'grid-9' }), 'grid');
  assert.equal(circuitWriteAllowed({}, post({}, 'anything'), { key: '' }), '');
});

test('el handler persiste registro y canales y la lectura es pública', async () => {
  const store = kv({ 'grid:projects': JSON.stringify(DEFAULT) });
  const env = { SIGNAGE_KV: store, CIRCUIT_SERVICE_KEY: 'svc-123' };
  const denied = await gridCircuitsHandler(post({ circuit: 'farmacias' }, 'nope'), env, { json, projectsDefault: DEFAULT });
  assert.equal(denied.status, 403);
  const ok = await gridCircuitsHandler(post({ circuit: 'farmacias', project: 'kiosk', source: 'yokup' }, 'svc-123'), env, { json, projectsDefault: DEFAULT });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(store.m.get('grid:projects'))[0].circuits, ['kiosko', 'farmacias']);
  const list = await (await gridCircuitsHandler(new Request('https://x/grid/circuits'), env, { json, projectsDefault: DEFAULT })).json();
  assert.equal(list.circuits[0].id, 'farmacias');
  assert.equal(list.circuits[0].source, 'yokup');
});
