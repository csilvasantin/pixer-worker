// Cupo de POST /xpacio/estimar (DCL-ddf3203078fe9471f3796130): comprobar-y-reservar ATÓMICO.
//
// Vive en un Durable Object propio y pequeño, XpacioCupo (src/xpacio-cupo-do.mjs, una sola
// instancia global). Aquí está su núcleo puro y síncrono, para los tests: el DO lo ejecuta sobre su
// SQLite sin ningún `await` entre leer y escribir, así que dos peticiones simultáneas nunca leen el
// mismo contador (lo que pasaba con los topes en memoria del isolate y con el KV de lectura-suma-
// escritura). Tres topes por día UTC, decididos por Carlos el 14-oct-2026:
//   · global: 30 estimaciones (var XPACIO_ESTIMAR_TOPE_DIA);
//   · por IP: 5 (var XPACIO_ESTIMAR_TOPE_IP), con las IPv6 agrupadas por /64;
//   · de coste: 5 $ (var XPACIO_ESTIMAR_TOPE_USD). Cada reserva aparta el peor caso de una llamada
//     y, al terminar, se liquida con el coste real (tokens de usageMetadata).
// Si el DO no responde o falla, el worker contesta 429 `cupo-no-disponible`: sin cupo no hay Gemini.
// Las IPs no se guardan: la clave es un hash del grupo, y las filas se purgan a los dos días.

export const CUPO_DIA = 30;
export const CUPO_IP = 5;
export const CUPO_USD = 5;
export const MICRO = 1e6; // el coste se lleva en micro-dólares enteros

export const diaUtc = ms => new Date(ms).toISOString().slice(0, 10);
const entero = (v, def, min = 0) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= min ? n : def; };
const numero = (v, def) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : def; };

// Topes desde las vars del worker (con sus valores por defecto).
export function topesCupo(env = {}) {
  return {
    topeDia: entero(env.XPACIO_ESTIMAR_TOPE_DIA, CUPO_DIA),
    topeIp: entero(env.XPACIO_ESTIMAR_TOPE_IP, CUPO_IP),
    topeMicro: Math.round(numero(env.XPACIO_ESTIMAR_TOPE_USD, CUPO_USD) * MICRO)
  };
}

// Grupo de una IP: una IPv4 tal cual; una IPv6, su /64 (un hogar o un móvil suele tener un /64
// entero y podría rotar direcciones dentro de él para saltarse el tope).
export function grupoIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return 'sin-ip';
  if (!s.includes(':')) return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? s : 'ip-rara';
  const sinZona = s.split('%')[0];
  if (sinZona.split('::').length > 2) return 'ip-rara';
  // IPv4 mapeada (::ffff:1.2.3.4) → la IPv4.
  const v4 = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(sinZona);
  if (v4 && /^::ffff:/.test(sinZona)) return v4[1];
  const [izq, der = null] = sinZona.split('::');
  const a = izq ? izq.split(':') : [], b = der != null && der ? der.split(':') : [];
  if (der == null && a.length !== 8) return 'ip-rara';
  const relleno = der == null ? [] : Array(Math.max(0, 8 - a.length - b.length)).fill('0');
  const bloques = [...a, ...relleno, ...b];
  if (bloques.length !== 8 || !bloques.every(x => /^[0-9a-f]{1,4}$/.test(x))) return 'ip-rara';
  return bloques.slice(0, 4).map(x => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// Clave de la IP en el DO: hash del grupo (no se guarda la IP).
export async function claveIp(ip) {
  const bytes = new TextEncoder().encode('xpacio-cupo|' + grupoIp(ip));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return 'ip:' + Array.from(h.slice(0, 12), x => x.toString(16).padStart(2, '0')).join('');
}

// ── Núcleo síncrono (lo ejecuta el DO sobre SQLite; los tests, sobre un Map) ─────
// almacen: { leer(dia, clave) → {n, micro} | null, escribir(dia, clave, {n, micro}), purgar(diaMin) }
export function reservarCupo(almacen, { clave, topeDia, topeIp, topeMicro, reservaMicro, ahora = Date.now() }) {
  const dia = diaUtc(ahora);
  const g = almacen.leer(dia, '*') || { n: 0, micro: 0 };
  const i = almacen.leer(dia, clave) || { n: 0, micro: 0 };
  if (g.n >= topeDia) return { ok: false, motivo: 'dia', tope: topeDia };
  if (i.n >= topeIp) return { ok: false, motivo: 'ip', tope: topeIp };
  if (g.micro + reservaMicro > topeMicro) return { ok: false, motivo: 'coste', tope: topeMicro / MICRO };
  almacen.escribir(dia, '*', { n: g.n + 1, micro: g.micro + reservaMicro });
  almacen.escribir(dia, clave, { n: i.n + 1, micro: i.micro });
  if (almacen.purgar) almacen.purgar(diaUtc(ahora - 2 * 86400000));
  return { ok: true, dia, reservaMicro, usadasIp: i.n + 1, topeIp, usadasDia: g.n + 1, topeDia };
}

// Cambia lo apartado (el peor caso) por el coste real. La estimación sigue contada: una petición
// que no llega a Gemini (cuerpo no válido) no gasta dinero pero sí su turno.
export function liquidarCupo(almacen, { dia, reservaMicro, costeMicro }) {
  const g = almacen.leer(dia, '*');
  if (!g) return { ok: false };
  const real = Math.max(0, Math.round(Number(costeMicro) || 0));
  const micro = Math.max(0, g.micro - Math.max(0, Math.round(Number(reservaMicro) || 0)) + real);
  almacen.escribir(dia, '*', { n: g.n, micro });
  return { ok: true, micro };
}

// Almacén en memoria con la misma interfaz (tests).
export function almacenMemoria() {
  const m = new Map();
  return {
    m,
    leer: (dia, clave) => m.get(dia + '|' + clave) || null,
    escribir: (dia, clave, fila) => { m.set(dia + '|' + clave, { n: fila.n, micro: fila.micro }); },
    purgar: diaMin => { for (const k of m.keys()) if (k.split('|')[0] < diaMin) m.delete(k); }
  };
}
