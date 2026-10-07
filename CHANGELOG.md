# CHANGELOG · pixer-eleven (api.admira.store)

Sello `v.DD.MM.AAAA.rN.HH:MM` (norma 07). Se lee en `GET /healthz`.

## v.07.10.2026.r3 — Las etiquetas del Stock se guardan en una sola forma
- Por qué: la misma etiqueta convivía con y sin tilde («musica»/«música»), en inglés y castellano
  («tech»/«tecnología») y en singular y plural. Se limpiaron los datos (306 piezas) y esto evita
  que vuelva a ensuciarse (Carlos, 7-oct-2026: «normaliza al guardar»).
- `src/stock-catalogo.mjs`: tabla `TAG_CANON` y `canonTag`. Toda etiqueta libre que se guarda
  (publish y `PATCH /stock/:id/meta`) pasa por ella; los hashtags del catálogo y la calidad no.
  No se inventan tildes: sólo se corrige lo que está en la tabla.
- `?tag=` de `/stock/list` y el reparto por etiqueta (`stock-via1`) comparan sin tildes y con las
  equivalencias: `musica`, `música` y `music` traen lo mismo.
- Fuera a propósito: `animaciones` (etiqueta y categoría de sistema), `song` (demo 365) y
  good/better/best. La tabla de lectura equivalente vive en admira.tv.

## v.07.10.2026.r2 — ACK de otra pantalla sin tormenta de Telegram
- El 403 `command_screen_mismatch` de `/locations/cmd/ack` conserva el rechazo
  y el primer aviso, pero agrupa sus repeticiones como incidente (recordatorio
  cada cinco minutos y recuperación). Antes sólo entraba `invalid_ack_reference`.
- El aviso explica que el acuse corresponde a otra pantalla. Diagnóstico de
  estado/código/acción en los logs, sin body, identidad del equipo ni credenciales.
- Los otros errores de negocio y los 5xx mantienen sus alertas.

## v.07.10.2026.r1 — Límites de espera en las llamadas a proveedores (Anonimizador y resto)
- Por qué: si x.ai o Gemini no contestaban, el worker se quedaba colgado y el navegador
  cortaba por su cuenta (pixeria `assets/anonimizador-fiable.js`: 60 s Grok, 90 s Gemini)
  sin saber qué había pasado. Y si fallaba la descarga de la imagen de x.ai, `/xai/image`
  devolvía 200 sin imagen.
- Nuevo `src/fetch-limite.mjs`: `fetchConLimite` (hasta cabeceras, para streaming),
  `pedirConLimite` (incluye la lectura del cuerpo), `crearPresupuesto` y `conReintentos`
  (429/5xx, solo si queda presupuesto). Distingue timeout, error de red y abort.
- Límites: Grok imagen 55 s en total (generación + reintento + descarga); Gemini imagen
  (`/image/edit`, `/imagen/generate`, `/segmentado/generate`) 85 s; texto/chat 30 s
  (cápsula de artículo 45 s); descargas 30 s; vídeo asíncrono: inicio 30 s y cada sondeo
  20 s (el polling no cambia); Veo descarga y Pollinations hasta cabeceras (30 s / 180 s);
  ElevenLabs TTS 60 s, doblaje 120 s, catálogo 30 s; Lyria 120 s; token GCP 10 s;
  verificación de sesión Pixeria 10 s; trozos de TTS gratuito y etiquetas og: 10 s.
- Respuestas nuevas: tiempo agotado → `504 {ok:false, error:'timeout', reason:'timeout',
  proveedor, etapa, ms, detail}`; proveedor inaccesible → `502 {ok:false, error:'red',
  reason:'network', proveedor, etapa, detail}` (antes 500 `worker-exception`); descarga de
  la imagen de x.ai fallida → `502 {ok:false, error:'descarga_imagen', reason:'no-data',
  proveedor:'xai', etapa:'descarga', status, detail}`. Con varias imágenes, solo se
  entregan las descargadas. Las respuestas de éxito no cambian.
- `/xai/image` y `/image/edit` reintentan una vez un 429/5xx si queda presupuesto.
- `test/fetch-limite.test.mjs`: helper, presupuesto, reintentos, 504 por ruta con fetch
  colgado, 502 de descarga y éxito sin cambios.

## v.04.10.2026.r1 — Orígenes de admira.biz (intercambio de dominios, paso 1)
- `ALLOWED_ORIGINS` admite `https://admira.biz` y `https://www.admira.biz`, que pasarán a
  servir la parte de negocio hoy en admira.app. admira.app se mantiene para que todo
  funcione antes y después del corte.

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
