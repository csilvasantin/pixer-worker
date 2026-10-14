# Contexto compartido / Shared context — encargo #5934 · API y código común

## Estado / Status

Fase 1 implementada en ramas de API y admira-design. Sólo previews aisladas; sin merge, sin push a main y sin producción. Los cinco sitios deben integrar estos módulos en sus propios encargos antes de anunciar el paraguas global publicado. El acceso al servidor MCP XpaceOS y sus ayudas públicas no se modifica en esta fase.

Phase 1 is implemented in API and admira-design branches. Isolated previews only. The five platforms must integrate the modules in their own assignments; the global umbrella is not a production release. The live XpaceOS MCP service and public help are unchanged in this phase.

## Contrato / Contract

- `/marca <id>` / `/brand <id>`: sólo look and feel; disponible para cualquier usuario en Experto. Conserva el proyecto activo. `/marca off` restaura el look nativo. No incluye contenidos genéricos ni cambia asignaciones.
- `/proyecto <id>` / `/project <id>`: filtro de datos; sólo superusuario comprobado por la API contra la whitelist de admira-gate. `/proyecto off` limpia el filtro y también exige superusuario. Conserva la marca activa.
- `?marca=&proyecto=`: valores URL sobrescriben el contexto guardado después de verificar la sesión. Un proyecto no autorizado se retira de la URL y no se propaga. Las peticiones de datos de esa vista fallan para evitar mostrar una lista sin filtrar tras el rechazo.
- `GET/POST /ctx`: Bearer de `/auth/api-token` o token de admira-gate. Email sólo derivado de la sesión, nunca enviado por la UI. POST es un patch de `{marca?, proyecto?}` y rechaza campos ajenos. Estado en KV `ctx:v1:<email>`, separado por cuenta. KV es eventual: otra pestaña/región puede tardar hasta 60 s en restaurar la última preferencia; POST devuelve el valor escrito y los clientes envían explícitamente el filtro activo en cada lectura.
- Starbucks: provisionalmente sólo `locationId` con prefijo exacto `alsea-sbux-`. El alias legado `loc` se expone como `locationId`; si el ID de pantalla es ya un ID de local `alsea-sbux-*`, se usa como tal. No se deduce por nombre, etiqueta, marca visual o texto. `projects[]` nunca amplía esta regla. Metadatos pendientes requieren backfill en el encargo de inventario.

English: brand commands change presentation only; project commands filter data and require a server-verified superuser, including reset. URL parameters override saved context only after authentication. Context is scoped to the authenticated email, never a caller-supplied identity. Starbucks provisionally requires the exact `alsea-sbux-` location prefix; legacy `loc` and screen IDs that already are location IDs are supported. Project tags, names and brand appearance cannot override this rule. KV preferences are eventually consistent; filtered requests send their active project explicitly.

## Integración / Integration

Cargar una sola copia de cada módulo desde la misma revisión de la PR; no mezclar esta preview con el CDN de producción.

```html
<script>
window.ADMIRA_CONTEXT_OPTIONS = {
  // Existing expert-mode controller; never a role authorization source.
  expert: () => window.miShell.modo() === 'expert',
  api: 'https://api.admira.store'
};
</script>
<script src="/shared/contexto.js"></script>
<script src="/shared/marca-blanca.js" data-plataforma="studio"></script>
```

`data-plataforma`: studio/store/tv/app/biz. Distribuir también `marca-blanca.css` junto al loader. Este loader común deriva de Studio y usa el catálogo, contraste, logo, favicon, modo y analizador existentes de admiranext.com. El CSS de puente sólo actúa bajo `data-mb-marca` y conserva los selectores del shell entregado.

```js
await AdmiraContexto.ready;
await AdmiraContexto.comando('/marca lumbre');
await AdmiraContexto.comando('/proyecto starbucks');
const response = await AdmiraContexto.request('/signage/screens');
if (!response.ok) throw new Error('Project data unavailable');
const screens = (await response.json()).screens;
```

Registrar `/marca` y `/proyecto` con `comando` en el CLI existente; conservar historial, altura, identidades y comandos restantes. El módulo no instala otro CLI. Escuchar `admira:contexto` para refrescar la vista y `admira:contexto-error` para mostrar el rechazo. Las páginas usan `request` para `/grid/screens`, `/signage/screens`, `/stock` o `/stock/list`, `/grid/playlist` y `/grid/draft`. Esperar siempre a `ready`. `enlace(url)` y el observador propagan ambos parámetros en los enlaces de las cinco plataformas; preservan rutas, otros parámetros y fragmentos; excluyen `/auth/` y destinos externos. Los tokens sólo viajan al origen API configurado.

The host CLI routes commands through `comando` and retains its existing history and shell. Wait for `ready` before data reads. Handle context changes and errors; `request` supplies the session token and active project. Links between the five platforms retain routes, other parameters and fragments. Tokens never go to external links. Each host must provide its real authenticated token broker; the default is same-origin `/auth/api-token`. A host using admira-gate may provide `tokenProvider` returning `{ok, token, exp}`; do not store roles or infer identity in the browser.

## Retirada del atajo / Shortcut removal

No existe `pixeria:admin` ni un fallback de rol local en este módulo. Al integrar en Studio/Pixeria, sustituir la ruta antigua de `cliente-activo.js` y sus handlers de marca/filtro: no cargar ambos a la vez. La eliminación de los handlers antiguos en los sitios queda para sus PRs de integración, sin tocar aquí esos repos ni las cuentas asignadas a clientes. Sus restricciones propias deben mantenerse; este filtro de superusuario no es un sistema nuevo de ACL.

The shared module has no local admin shortcut. Platform integration must replace the legacy client-selector route and must preserve assigned-account restrictions. Do not load both implementations. This superuser view filter is not a new tenant ACL; legacy public unfiltered read endpoints remain public.

## Verificación / Verification

`node --test test/contexto.test.cjs`. Preview `preview.html`: cuatro pantallas de fixture (dos Starbucks y dos excluidas), sesiones sintéticas, clave exclusiva de sandbox, rol real consultado en whitelist. El email del fixture de superusuario es Carlos; no se usa ni se crea una sesión humana de Carlos. La preview API carece de bindings/secrets de producción y sólo permite las rutas de prueba. El rol lector muestra 403 al solicitar proyecto. La lectura pública del inventario real del 14-oct no mostró pantallas Starbucks: este resultado prueba el contrato con fixtures, no inventario físico ni playback.

Preview uses four fixture screens and synthetic sandbox sessions, with live whitelist role lookup. Its superuser fixture email is Carlos; it is not his human login. It proves filtering and permissions on test data, not production inventory or physical playback.

## API y MCP / API and MCP

Servidor localizado: `csilvasantin/pixer-worker`, Worker `pixer-eleven`, `src/worker.js` → `src/index.js`, API estable `https://api.admira.store`. Las rutas de prueba se sirven en otro Worker sin los bindings de producción. No publicar `preview/worker.mjs` como main del Worker real.

| Método / Method | Ruta / Route | Contrato / Contract |
|---|---|---|
| GET | `/ctx` | `{ok, marca, proyecto, superusuario}`; Bearer requerido / required |
| POST | `/ctx` | Patch `{marca?, proyecto?}`; proyecto exige superusuario / requires superuser |
| GET | `/grid/screens?proyecto=starbucks` | Configuraciones filtradas / filtered configs; screens[].projects[] |
| GET | `/signage/screens?proyecto=starbucks` | Pantallas vivas filtradas / filtered live screens; counts después del filtro / after filtering |
| GET | `/stock?proyecto=starbucks` o `/stock/list?proyecto=starbucks` | Assets filtrados antes de limit y total / filtered before limit and total |
| GET | `/grid/playlist?screen=…&proyecto=…` | Playlist de pantalla del proyecto / project's screen playlist; projects[], locationId; 404 fuera del proyecto / outside project |
| GET | `/grid/draft?screen=…&playlist=…&proyecto=…` | Misma pertenencia / same membership; draft.projects[], locationId |

Un Bearer con contexto guardado aplica el proyecto también sin query; una query explícita sustituye sólo la vista de esa lectura. Query `off` o vacía exige superusuario. Sin Bearer ni query se conservan las lecturas públicas existentes. No confundir este filtro de vista con autorización de todo el inventario/tenant: no cambia los accesos históricos directos a URLs de assets.

With a Bearer, saved project context also scopes reads without a query. An explicit query overrides only that read. Anonymous unfiltered reads retain their legacy behavior. This view filter does not replace tenant ACLs or make historical public assets private.

`projects[]` se normaliza y persiste en POST `/grid/config`, `/signage/heartbeat`, `/signage/now`, `/stock/publish` y en los drafts de playlist. `locationId` se admite en las mismas superficies. No se hace backfill de inventario ni se deduce Starbucks por texto; los productores deben enviar el local correcto. Los assets que carezcan de local no aparecen en Starbucks hasta asignarlos explícitamente. Un contexto de marca no influye en estos campos.

Production prerequisites, pending authorization: configure server-side `WHITELIST_SITE_TOKEN` (read-only `/access?site=pixeria&email=…`) or `WHITELIST_MACHINE_TOKEN` for the canonical whitelist `/list`. Context verification accepts signed Pixeria API tokens via the existing key, or remotely verified Studio/Pixeria/admira-gate sessions at fixed trusted endpoints. A fleet key does not identify a person. Role failures return 503; never fall back to local admin flags or hardcoded owner roles. No secret values belong in Git or URLs.

MCP source updated in `mcp/src/server.js`: `contexto_get`, `contexto_set`, `contexto_listar` and resource `admira://context/contract`. Configure `ADMIRA_CONTEXT_TOKEN` with a real user session token and `ADMIRA_WORKER_URL` with the intended API/preview; it is distinct from Agora sync keys. These tools never infer email/roles and obey the same 401/403/503 contract. Read-only tools: get/list; set changes preferences only. Running/updating the live XpaceOS MCP service remains outside this preview delivery.

## Comprobación aislada / Isolated verification

`npm test`: API regresiones y contrato. `wrangler deploy --config preview/wrangler.toml` publica sólo `pixer-ctx-5934-preview`, con KV `PREVIEW_KV` exclusivo. La entrada sandbox limita las rutas; no hay OMNI, Stock real, scheduler ni secretos de proveedores. `/preview/session?role=superuser|reader` emite sólo tokens de fixture firmados por una clave nueva de esta sandbox, por 15 minutos; jamás funciona en producción. La whitelist es de sólo lectura y comprueba el rol real del email del fixture. El frontend de preview está en una rama preview de un proyecto Pages independiente.

Changes require review in two draft PRs. Integration across the five sites, inventory metadata backfill and any production deployment remain pending Carlos's authorization. The 14 October public snapshot contained no Starbucks location matches; successful preview filtering is fixture evidence only.
