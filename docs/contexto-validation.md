# Validación / Validation — encargo #5934 · API y código común

Estado: entrega de fase 1 para revisión; sólo preview. / Status: phase 1 review delivery; preview only.

- API source: pixer-worker → pixer-eleven → api.admira.store. Los dos `/healthz` públicos devolvieron el mismo JSON y versión `v.14.10.2026.r2.11:13` durante la inspección del 14-oct. No se cambió el Worker de producción.
- Preview API: https://pixer-ctx-5934-preview.csilvasantin.workers.dev
- Preview frontend: https://codex-5934.admira-design-preview.pages.dev/preview?proyecto=starbucks
- Ayuda / Help: https://codex-5934.admira-design-preview.pages.dev/help/
- Catálogo MCP / MCP catalogue: https://codex-5934.admira-design-preview.pages.dev/mcp/context-contract.json

## Resultados / Results

API: 299 tests passed. Shared context: 6 tests passed. MCP stdio client discovered and called contexto_get/set/listar against the preview and read admira://context/contract successfully. Browser: no JavaScript exceptions.

Preview live checks / comprobaciones de preview:

- POST and GET `/ctx`: 200, `{marca:null, proyecto:"starbucks", superusuario:true}` with isolated superuser fixture session.
- GET `/signage/screens?proyecto=starbucks`: 200, exactly two fixtures, both locationId starting `alsea-sbux-`; excludes Xtanco and the fixture with a false Starbucks project tag but another location.
- GET `/stock?proyecto=starbucks`: exactly two matching fixtures, correct filtered total.
- Normal-user POST `/ctx {proyecto:"starbucks"}` and GET filtered screens: 403 `superuser-required`.
- `/marca lumbre`: actual HTML data-mb-marca=lumbre, body background rgb(247,240,230), proyecto stays Starbucks. Links propagate both verified parameters; reset affects only the selected field.
- Unprivileged URL `?proyecto=starbucks`: removed, no project on outgoing links. No local admin shortcut.
- Shared draft revisions retain 409 stale-rev behavior; metadata persists on legacy heartbeats.

Los resultados usan sesiones y datos sintéticos. El rol de sus emails se consulta en la whitelist real; la firma es exclusiva de la sandbox. No se usó sesión humana de Carlos, no se cambió producción, no se verificó playback físico. Inventario público observado: cero pantallas Starbucks en los listados leídos; backfill/location assignments pendientes de integración autorizada.

These results prove the phase 1 contract on isolated fixtures with live read-only whitelist role verification. They do not prove production inventory, platform rollout or physical playback. Platform integration, inventory metadata, production whitelist credentials and live XpaceOS MCP integration remain pending authorization and their separate work.

## Rebase del 14-oct-2026 / Rebase on 14 October 2026

ES: Rama rebasada sobre `e3f7632` · main con telemetría de Bugito, descendiente de `74f942c` · integración de presencia por latido. Conserva las PR #23 · estimación de Xpacios con cupo atómico y #24 · reloj de presencia de pantallas. `wrangler.toml` y las migraciones `xpacio-cupo-v1` → `presence-clock-v1` quedan idénticos a main, incluidos tags y clases SQLite. Esta PR guarda el contexto en KV y no añade una migración de Durable Objects.

EN: The branch was rebased onto `e3f7632` · main with Bugito telemetry, a descendant of `74f942c` · heartbeat presence integration. It retains PR #23 · Xpacio estimation with atomic quota and PR #24 · screen presence clock. `wrangler.toml` and the `xpacio-cupo-v1` → `presence-clock-v1` migrations remain identical to main, including tags and SQLite classes. This PR stores context in KV and adds no Durable Objects migration.

Validación local / Local validation: 330 API tests passed; MCP syntax check passed; production and preview entrypoint syntax checks passed; migration order and unchanged production configuration verified. The rebase completed without conflicts.

ES: La PR sigue en borrador. API y frontend de preview existentes responden HTTP 200; conservan la versión publicada antes del rebase. No se han desplegado ni preview ni producción, ni se ha fusionado o actualizado main.

EN: The PR remains a draft. Existing API and frontend previews respond with HTTP 200 and retain the version published before the rebase. Neither preview nor production has been deployed; main has not been merged into or updated.
