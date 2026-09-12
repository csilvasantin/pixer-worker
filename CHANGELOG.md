# CHANGELOG · pixer-eleven (api.admira.store)

Sello `v.DD.MM.AAAA.rN.HH:MM` (norma 07). Se lee en `GET /healthz`.

## v.12.09.2026.r2 — Póster representativo y validación de vídeos (Yokup #3199)
- Por qué: admira.tv/contentcatalogue enseñaba el previo del «Langostino cocido» en
  NEGRO. El máster no era negro: solo su fotograma 0 (relleno `#020508` del canvas
  antes de `captureStream()`, luma 20 en rango limitado ≈ 4,7 sobre 255); desde el
  fotograma 1 (t = 0,014 s) hay imagen (luma 62–93). El webm de MediaRecorder no
  lleva Duration ni Cues y el `#t=0.1` del previo acababa pintando el fotograma 0.
- `POST /stock/publish`: campos opcionales `poster` (data URL JPEG/WebP ≤ 400 KB,
  se guarda en `stock/<id>/poster.jpg`), `posterAt` y `validacion`
  `{ok, negros, muestras, duracion, motivo, por}` → `meta.poster`, `meta.thumbnail`,
  `meta.validacion`. Se validan ANTES de mover el asset.
- `GET /stock/poster/<id>` → `image/jpeg|webp`, `Cache-Control: public, max-age=86400`,
  CORS `*` (404 si no hay póster). `meta.poster` = `https://api.admira.store/stock/poster/<id>`.
- `POST /stock/poster`: clave también por cabecera `X-Notify-Key` o `?secret=`; acepta
  `poster` (data URL) además de `base64`+`mime`; opcional `validacion`.
- `PATCH /stock/:id/meta`: `oculto:true|false` (fuera de `/stock/list`, del índice
  `stock/index.json` y de `/stock/catalogos`, salvo `?ocultos=1`) y `validacion` (objeto
  o `null`).
- `GET /stock/exists` y `/stock/list` devuelven `poster`, `thumbnail`, `validacion`,
  `oculto` (exists además `posterFrameAt`).
- Nuevo `src/stock-poster.mjs` (regla pura: negro = luma < 16 o < 24 con varianza < 25;
  inválido si > 70 % negros, < 10 s o sin pista; póster = luma 40..220 y máxima
  varianza fuera de los 0,8 s de cada extremo) + `test/stock-poster-validacion.test.mjs`
  y `test/stock-poster-worker.test.mjs`.

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
