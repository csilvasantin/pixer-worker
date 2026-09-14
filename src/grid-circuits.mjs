// ── Registro de circuitos · GET/POST /grid/circuits ─────────────────────────
// Fuente única de circuitos de Cartelería Digital (Carlos, 14-sep-2026): los
// canales viven en KV `grid:projects` (los edita el CMS con GRID_KEY) y aquí se
// añade el alta de CIRCUITOS desde otros productos —hoy yokup.com— sin repartir
// la GRID_KEY. Yokup llama desde su backend con CIRCUIT_SERVICE_KEY (secreto solo
// de Workers); ningún navegador escribe aquí.
//
//   GET  /grid/circuits → { ok, circuits:[{id,name,project,source,created_by,created_at,updated_at}] }
//   POST /grid/circuits  Authorization: Bearer <CIRCUIT_SERVICE_KEY>  (o body.key = GRID_KEY)
//        { circuit, name?, project?, project_name?, source?, actor? }
//        → alta/actualización idempotente; si trae `project`, el circuito entra en
//          ese canal (y el canal se crea si no existe). Sin `project` queda «sin canal».
//
// La lectura es pública igual que /grid/projects: ids y nombres, nunca quién es el
// titular de un equipo ni datos del comercio.

export const GRID_CIRCUITS_KEY = 'grid:circuits';
const MAX_CIRCUITS = 5000;   // un Excel del portal del comercio trae hasta 500 establecimientos por archivo

export function circuitId(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '').slice(0, 40); }
function label(s, max) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max); }

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function circuitWriteAllowed(env, req, body) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') || '');
  if (env.CIRCUIT_SERVICE_KEY && bearer && safeEqual(bearer[1].trim(), env.CIRCUIT_SERVICE_KEY)) return 'service';
  if (env.GRID_KEY && body && safeEqual(body.key, env.GRID_KEY)) return 'grid';
  return '';
}

export function parseCircuitRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'bad-request' };
  // Estricto: un id que cambiaría al limpiarlo se rechaza (no se inventa otro circuito).
  const raw = String(body.circuit || '').trim().toLowerCase(), id = circuitId(raw);
  if (!id || id.length < 2 || id !== raw) return { error: 'bad-circuit' };
  const rawProject = body.project == null ? '' : String(body.project).trim().toLowerCase();
  const project = circuitId(rawProject);
  if (rawProject && project !== rawProject) return { error: 'bad-project' };
  return {
    id,
    name: label(body.name, 60) || id,
    project,
    projectName: label(body.project_name, 60),
    source: circuitId(body.source) || 'api',
    actor: label(body.actor, 120),
  };
}

// Aplica el alta sobre copias de registro y canales. Pura: se prueba sin KV.
export function applyCircuit(circuits, projects, req, now) {
  const list = Array.isArray(circuits) ? circuits.map(c => ({ ...c })) : [];
  const canals = Array.isArray(projects) ? projects.map(p => ({ ...p, circuits: Array.isArray(p.circuits) ? [...p.circuits] : [] })) : [];
  let entry = list.find(c => c.id === req.id), created = false;
  if (!entry) {
    if (list.length >= MAX_CIRCUITS) return { error: 'registry-full' };
    entry = { id: req.id, name: req.name, project: '', source: req.source, created_by: req.actor, created_at: now };
    list.push(entry); created = true;
  } else if (req.name && req.name !== req.id) {
    entry.name = req.name;
  }
  let projectsChanged = false, projectCreated = false;
  if (req.project) {
    let canal = canals.find(p => p.id === req.project);
    if (!canal) {
      if (canals.length >= 60) return { error: 'too-many-projects' };
      canal = { id: req.project, name: req.projectName || req.project, circuits: [] };
      canals.push(canal); projectCreated = true; projectsChanged = true;
    }
    if (!canal.circuits.includes(req.id)) {
      if (canal.circuits.length >= 40) return { error: 'project-full' };
      canal.circuits.push(req.id); projectsChanged = true;
    }
    entry.project = req.project;
  }
  entry.updated_at = now;
  return { circuits: list, projects: canals, entry, created, projectCreated, projectsChanged };
}

async function readJson(env, key) {
  try { return JSON.parse(await env.SIGNAGE_KV.get(key) || 'null'); } catch (_) { return null; }
}

export async function gridCircuitsHandler(req, env, { json, projectsDefault }) {
  if (!env.SIGNAGE_KV) return json({ error: 'kv-not-bound' }, { status: 500 });
  if (req.method === 'GET') {
    const circuits = await readJson(env, GRID_CIRCUITS_KEY);
    return json({ ok: true, circuits: Array.isArray(circuits) ? circuits : [] });
  }
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, { status: 405 });
  let body; try { body = await req.json(); } catch (_) { return json({ error: 'bad-json' }, { status: 400 }); }
  if (!env.CIRCUIT_SERVICE_KEY && !env.GRID_KEY) return json({ error: 'circuit-key-not-configured' }, { status: 503 });
  const who = circuitWriteAllowed(env, req, body);
  if (!who) return json({ error: 'bad-key' }, { status: 403 });
  const parsed = parseCircuitRequest(body);
  if (parsed.error) return json({ error: parsed.error }, { status: 400 });
  const storedProjects = await readJson(env, 'grid:projects');
  const projects = Array.isArray(storedProjects) && storedProjects.length ? storedProjects : projectsDefault;
  const result = applyCircuit(await readJson(env, GRID_CIRCUITS_KEY), projects, parsed, new Date().toISOString());
  if (result.error) return json({ error: result.error }, { status: 409 });
  await env.SIGNAGE_KV.put(GRID_CIRCUITS_KEY, JSON.stringify(result.circuits));
  if (result.projectsChanged) await env.SIGNAGE_KV.put('grid:projects', JSON.stringify(result.projects).slice(0, 16000));
  return json({ ok: true, via: who, circuit: result.entry, created: result.created, project_created: result.projectCreated,
    project: parsed.project ? result.projects.find(p => p.id === parsed.project) : null });
}
