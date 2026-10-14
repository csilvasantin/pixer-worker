// Orígenes del sandbox de contexto (encargo #5996): las previews de las cinco webs de la suite y local entran;
// lo demás no. El servidor hace eco del Origin permitido, siempre con Vary: Origin, y nunca responde «*».
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ORIGENES_POR_DEFECTO, aplicarCors, listaDeOrigenes, origenPermitido } from '../preview/origenes.mjs';

const toml = await readFile(new URL('../preview/wrangler.toml', import.meta.url), 'utf8');
const configurada = listaDeOrigenes({ PREVIEW_ORIGINS: /PREVIEW_ORIGINS = "([^"]+)"/.exec(toml)[1] });

const PERMITIDOS = [
  'https://morfeo-5979-contexto.admira-tv.pages.dev',     // admira.tv
  'https://07f9f383.admira-tv.pages.dev',                  // despliegue concreto
  'https://5839-starbucks-preview.admira-studio.pages.dev',// admira.studio
  'https://rama.pixeria.pages.dev',
  'https://rama.admira-store.pages.dev',                   // admira.store
  'https://rama.xpaceos.pages.dev',
  'https://rama.yokup.pages.dev',                          // admira.app
  'https://rama.clearchannel-tv.pages.dev',                // admira.biz
  'https://codex-5934.admira-design-preview.pages.dev',    // la de siempre
  'http://localhost:8788', 'http://localhost:8811', 'http://127.0.0.1:5173', 'http://localhost',
];
const RECHAZADOS = [
  'https://example.com', 'null', '',
  'https://admira-tv.pages.dev',                    // la raíz del proyecto es el espejo de producción
  'https://www.admira.tv', 'https://admira.tv',     // producción nunca llama al sandbox
  'http://morfeo.admira-tv.pages.dev',              // sin https
  'https://a.b.admira-tv.pages.dev',                // más de una etiqueta
  'https://evil-admira-tv.pages.dev',               // sufijo sin punto
  'https://admira-tv.pages.dev.evil.com',
  'https://x.admira-tv.pages.dev/ruta',             // un Origin no lleva ruta
  'https://localhost:8788',                          // local va por http
  'http://localhost.evil.com',
];

test('la lista configurada deja entrar las previews de la suite y local', () => {
  for (const o of PERMITIDOS) assert.equal(origenPermitido(o, configurada), true, o);
});

test('la lista configurada rechaza producción, otros dominios y trucos de sufijo', () => {
  for (const o of RECHAZADOS) assert.equal(origenPermitido(o, configurada), false, o);
});

test('sin configuración se usa la lista por defecto; PREVIEW_ORIGIN antiguo sigue valiendo', () => {
  assert.deepEqual(listaDeOrigenes({}), ORIGENES_POR_DEFECTO);
  const antigua = listaDeOrigenes({ PREVIEW_ORIGIN: 'https://codex-5934.admira-design-preview.pages.dev' });
  assert.equal(origenPermitido('https://codex-5934.admira-design-preview.pages.dev', antigua), true);
  assert.equal(origenPermitido('https://otra.admira-design-preview.pages.dev', antigua), false, 'un origen exacto no es un patrón');
});

test('eco del Origin permitido, Vary: Origin siempre y nunca «*»', () => {
  const pedir = (origin) => new Request('https://sandbox.test/ctx', origin ? { headers: { Origin: origin } } : {});
  const ok = aplicarCors(pedir('https://morfeo-5979-contexto.admira-tv.pages.dev'), new Headers({ 'Access-Control-Allow-Origin': '*' }), configurada);
  assert.equal(ok.get('Access-Control-Allow-Origin'), 'https://morfeo-5979-contexto.admira-tv.pages.dev');
  assert.match(ok.get('Vary'), /Origin/);
  const no = aplicarCors(pedir('https://example.com'), new Headers({ 'Access-Control-Allow-Origin': '*', Vary: 'Accept' }), configurada);
  assert.equal(no.get('Access-Control-Allow-Origin'), null, 'quita el «*» de la API');
  assert.equal(no.get('Vary'), 'Accept, Origin');
  const sin = aplicarCors(pedir(''), new Headers(), configurada);
  assert.equal(sin.get('Access-Control-Allow-Origin'), null);
});
