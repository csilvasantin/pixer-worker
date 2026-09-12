# CHANGELOG · pixer-eleven (api.admira.store)

Sello `v.DD.MM.AAAA.rN.HH:MM` (norma 07). Se lee en `GET /healthz`.

## v.12.09.2026.r1 — Catálogo del Stock (Yokup #3183)
- `POST /stock/publish`: objeto opcional `catalogo` → `meta.catalogo` saneado; hashtags
  automáticos `catalogo · <cliente> · <id> · <AAAA-MM>`; tope de tags 4 → 10.
- `GET /stock/list`: filtros `catalogo=`, `cliente=`, `tag=`, `q=`.
- `GET /stock/catalogos`: agrupación desde el índice (`stock/catalogos.json`, mantenido al reindexar).
- `PATCH /stock/:id/meta` `{catalogo?, tags_add?, tags_remove?}` con la clave del DELETE.
- CORS: `PATCH` en `Allow-Methods`; `X-AdmiraNeXT-Ingest, X-Notify-Key` en `Allow-Headers`
  (bloqueaban el preflight de las galerías).
- Backfill de las piezas de Alcampo (langostino, mejillón, surimi) al catálogo `alcampo-2026-09-10`.
- Nuevo `src/stock-catalogo.mjs` + `test/stock-catalogo.test.mjs`.

## v.11.09.2026.r1 — Dedup del Stock
- Dedup por contenido (sha256), sustitución por `externalId`, ventana de recientes,
  `GET /stock/exists`, `DELETE /stock/:id` con clave. Ver README «Dedup del Stock».
