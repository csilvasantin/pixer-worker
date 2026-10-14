// Orígenes que pueden llamar al sandbox desde el navegador (encargo #5996). SOLO PREVIEW.
//
// Antes había uno solo (PREVIEW_ORIGIN = la preview de admira-design) y cualquier otra web de la suite que
// integrara el contexto común se quedaba fuera. Ahora la lista va en configuración (PREVIEW_ORIGINS en
// preview/wrangler.toml) y admite patrones:
//   https://*.admira-tv.pages.dev   cualquier preview de un proyecto de Pages (una sola etiqueta delante)
//   https://codex-5934.admira-design-preview.pages.dev   un origen exacto
//   http://localhost:*              cualquier puerto
// El servidor devuelve en Access-Control-Allow-Origin el Origin de la petición solo si casa, siempre con
// Vary: Origin, y nunca «*» (viaja Authorization). Un dominio de producción no entra salvo que se escriba.

export const ORIGENES_POR_DEFECTO = [
  'https://*.admira-design-preview.pages.dev',
  'https://*.admira-studio.pages.dev', 'https://*.pixeria.pages.dev',
  'https://*.admira-store.pages.dev', 'https://*.xpaceos.pages.dev',
  'https://*.admira-tv.pages.dev',
  'https://*.yokup.pages.dev', 'https://*.admira-app.pages.dev',
  'https://*.clearchannel-tv.pages.dev',
  'http://localhost:*', 'http://127.0.0.1:*',
];

const PATRON = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\*|\d{1,5}))?$/;
const ETIQUETA = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function listaDeOrigenes(env = {}) {
  const texto = env.PREVIEW_ORIGINS || env.PREVIEW_ORIGIN || '';
  const lista = String(texto).split(/[\s,]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  return lista.length ? lista : ORIGENES_POR_DEFECTO;
}

export function origenPermitido(origin, lista) {
  if (!origin || typeof origin !== 'string' || origin.length > 300) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin.toLowerCase()) return false; // un Origin no lleva ruta, usuario ni barra final
  for (const patron of lista) {
    const m = PATRON.exec(patron);
    if (!m) continue;
    const [, protocolo, comodin, host, puerto] = m;
    if (u.protocol !== protocolo + ':') continue;
    if (comodin) {
      if (!u.hostname.endsWith('.' + host)) continue;
      if (!ETIQUETA.test(u.hostname.slice(0, -host.length - 1))) continue; // una sola etiqueta: rama o hash
    } else if (u.hostname !== host) continue;
    if (puerto === '*' || (puerto ? u.port === puerto : !u.port)) return true;
  }
  return false;
}

// Pone (o quita) las cabeceras CORS de una respuesta del sandbox según el Origin de la petición.
export function aplicarCors(req, headers, lista) {
  const origin = req.headers.get('Origin') || '';
  const vary = headers.get('Vary');
  if (!vary || !/\borigin\b/i.test(vary)) headers.set('Vary', vary ? vary + ', Origin' : 'Origin');
  if (origenPermitido(origin, lista)) headers.set('Access-Control-Allow-Origin', origin);
  else headers.delete('Access-Control-Allow-Origin');
  return headers;
}
