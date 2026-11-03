/*
 * VENDORIZADO desde admiranext.com/mcp/identidad-flota.mjs (v.05.09.2026.r1) + equipo MacStudio.
 * identidad-flota.mjs — identidad común de la flota AdmiraNeXT para TODOS los MCP de la
 * suite (admira.live, yokup.com, admira.store/XpaceOS, admira.app, admira.studio).
 *
 * FLT-2137 (Carlos, 5-sep-2026): «estamos uniendo todos los elementos de AdmiraNeXT por
 * MCP». Unir no es un servidor único: es que cada servidor reconozca a la misma persona
 * con la misma clave. La clave de un agente es una función de su persona y su equipo:
 *
 *     clave = base64url( HMAC-SHA256( MCP_FLOTA_SEED, "Persona|Equipo" ) ).slice(0, 40)
 *
 * · La semilla MCP_FLOTA_SEED es un secreto de cada worker (wrangler secret put) y vive en
 *   la bóveda como s:MCP_FLOTA_SEED. No se sirve nunca por HTTP.
 * · El agente lee su clave de la bóveda (s:MCP_KEY_<PERSONA>_<EQUIPO>) o la deriva con la
 *   semilla; mcp-conectar.sh (admira-vault) la registra en su cliente MCP.
 * · El servidor no guarda ninguna tabla de claves: recalcula las 11×8 parejas y compara en
 *   tiempo constante. Revocar = rotar la semilla (todas) o retirar una persona de la lista.
 *
 * Sin dependencias: WebCrypto (Cloudflare Workers, Node ≥ 20, Deno, navegador).
 * Uso:
 *   import { identidadPorClave, claveFlota } from 'https://www.admiranext.com/mcp/identidad-flota.mjs';
 *   const id = await identidadPorClave(bearer, env.MCP_FLOTA_SEED);
 *   // → { persona:'Morfeo', equipo:'MacMini', runtime:'Claude Code', agente:'MorfeoMacMini' } | null
 * Mejor vendorizar el fichero en el repo del worker (Workers no importa por URL) y comprobar
 * su hash contra el publicado.
 */

export const VERSION = 'v.05.09.2026.r1';

export const PERSONAS = ['Morfeo', 'Neo', 'Smith', 'Trinity', 'Oraculo', 'Niobe', 'Link', 'Cypher', 'Switch', 'Persefone', 'Seraph'];
export const EQUIPOS = ['MacMini', 'MacBookPro14', 'MacBookPro16', 'MacBookAirAzul', 'MacBookAirRosa', 'MacBookAirCrema', 'MacBookAirPlata', 'MacBookAir16', 'MacStudio'];  // pixer-worker: + MacStudio (Trinity-MacStudio)
export const CONSEJEROS = ['Wozniak', 'Jobs', 'Lucas', 'Disney'];   // GrokBot: clave propia (MCP_KEYS), no derivada
export const RUNTIME_POR_DEFECTO = { Oraculo: 'Codex', Trinity: 'Codex', Niobe: 'OpenCode', Persefone: 'OpenCode', Seraph: 'OpenCode', Smith: 'Grok CLI' };

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Normaliza «Oráculo», «oraculo», «OraculoMacMini» → «Oraculo»; «MacBook Pro Negro 14» → «MacBookPro14». */
export function personaCanonica(nombre) {
  const n = norm(nombre);
  return PERSONAS.find((p) => n === norm(p)) || PERSONAS.find((p) => n.startsWith(norm(p))) || null;
}
export function equipoCanonico(nombre) {
  const n = norm(nombre);
  if (!n) return null;
  if (n.includes('macmini')) return 'MacMini';
  if (n.includes('macstudio')) return 'MacStudio';
  if (n.includes('macbookairazul')) return 'MacBookAirAzul';
  if (n.includes('macbookairrosa')) return 'MacBookAirRosa';
  if (n.includes('macbookaircrema')) return 'MacBookAirCrema';
  if (n.includes('macbookairplata')) return 'MacBookAirPlata';
  if (n.includes('macbookair16')) return 'MacBookAir16';
  if (n.includes('macbookpro16')) return 'MacBookPro16';
  if (n.includes('macbookpro') && n.includes('14')) return 'MacBookPro14';
  return EQUIPOS.find((e) => n === norm(e)) || null;
}
export function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/** Clave de una pareja persona+equipo con una semilla. */
export async function claveFlota(seed, persona, equipo) {
  if (!seed) throw new Error('falta la semilla MCP_FLOTA_SEED');
  const p = personaCanonica(persona), e = equipoCanonico(equipo);
  if (!p || !e) throw new Error(`persona o equipo desconocidos: ${persona} · ${equipo}`);
  const k = await crypto.subtle.importKey('raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(`${p}|${e}`)));
  return b64url(sig).slice(0, 40);
}

/** Comparación en tiempo constante. */
export function iguales(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Identidad a partir de la clave recibida (Authorization: Bearer <clave>, X-MCP-Key o ?key=).
 * Devuelve null si la clave no corresponde a ninguna pareja. `opciones.personas`/`equipos`
 * permiten acotar (p. ej. un producto que solo admite a su equipo responsable).
 */
export async function identidadPorClave(clave, seed, opciones = {}) {
  clave = String(clave || '').trim();
  if (!clave || !seed) return null;
  const personas = opciones.personas || PERSONAS, equipos = opciones.equipos || EQUIPOS;
  for (const p of personas) for (const e of equipos) {
    if (iguales(await claveFlota(seed, p, e), clave)) {
      return { persona: p, equipo: e, runtime: RUNTIME_POR_DEFECTO[p] || 'Claude Code', agente: `${p}${e}`, tipo: 'agente', via: 'clave-flota' };
    }
  }
  return null;
}

/** Saca la clave de una Request estándar (Bearer, X-MCP-Key o ?key=). */
export function claveDeRequest(request) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.slice(0, 7).toLowerCase() === 'bearer ' ? auth.slice(7).trim() : '';
  let q = ''; try { q = new URL(request.url).searchParams.get('key') || ''; } catch { /* sin URL */ }
  return bearer || request.headers.get('x-mcp-key') || q || '';
}

/** Respuesta 401 uniforme para toda la suite. */
export function sinAutorizacion(servicio = 'admiranext-mcp') {
  return new Response(JSON.stringify({ ok: false, error: 'no autorizado: falta la clave de flota (Authorization: Bearer <clave>)', ayuda: 'https://www.admiranext.com/mcp/#identidad' }, null, 1), {
    status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': `Bearer realm="${servicio}"`, 'cache-control': 'no-store' },
  });
}
