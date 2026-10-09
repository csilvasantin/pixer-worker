# CHANGELOG · pixer-eleven (api.admira.store)

Sello `v.DD.MM.AAAA.rN.HH:MM` (norma 07). Se lee en `GET /healthz`.

## v.09.10.2026.r4.13:17 · TrinityMBP16 · MacBookPro16

- Stock admite el contrato opcional `admira.composition.v1` para capas de texto escritas por el compositor de Studio. Valida esquema, medio y dimensiones, exige la autenticación existente y vincula la declaración al SHA-256 calculado sobre el binario real. Ignora sellos y hashes aportados por el cliente; las importaciones conservan su recorrido anterior.
- La deduplicación sólo añade capas a una pieza sin contrato cuando se ha comprobado el mismo binario y sus dimensiones. Reemplazar el archivo invalida las capas anteriores y actualiza su hash; el índice del hash antiguo se retira sólo si todavía pertenece a esa pieza. Stock devuelve y conserva el contrato en su índice; no reconstruye textos desde prompts ni atribuye metadatos retroactivamente.
- La creación de anuncios e imagen/vídeo de Xpace pide la pieza final sin añadir marcos, pantallas o mockups ambientales. Respeta escenas que solicitan explícitamente una instalación o hardware; «para pantalla 9:16» sigue siendo un destino de emisión. No cambia el texto, idioma, producto ni referencia de origen del encargo.
- Verificación: 251/251 pruebas con proveedores simulados, incluidas reemplazo de binario seguido de republicación del original y preservación de un índice propiedad de otra pieza. Sintaxis y diff correctos, Wrangler `deploy --dry-run` correcto con las vinculaciones existentes. Sin llamadas a proveedores ni despliegue; no sustituye la revisión visual ni la aprobación de cada pieza.

## v.09.10.2026.r3.13:03 · TrinityMBP16 · MacBookPro16

- Las cajas de OCR y producto se validan antes y después de redondearlas a enteros: una caja que colapsa deja de ser evidencia válida y el análisis falla cerrado. No se adivina ni convierte una escala 0–1.
- El esquema de salida pide coordenadas `INTEGER` de 0 a 1000; confianza y rasgos tipográficos conservan `NUMBER`. La verificación de composición pide cajas ajustadas al objeto en GENERATED, nunca coordenadas de REFERENCE ni cajas del fondo completo.
- Pruebas con proveedor simulado cubren cajas degeneradas al redondear, ejemplos fraccionarios 0–1, decimales válidos y comparación con referencia. No cambia autenticación, márgenes ni controles de producto, texto y aprobación. Este endurecimiento no confirma la causa del rechazo real del anuncio de café.

## v.09.10.2026.r2.12:09 · TrinityMBP16 · MacBookPro16

- El análisis de anuncios describe grafitis y rótulos ambientales fotografiados en la escena, sin convertirlos en copia publicitaria editable. Conserva titulares, precios, promociones y textos legales como copia externa.
- `verify-visual` admite `referenceImage` opcional (PNG/JPEG/WebP en base64) para comparar referencia y resultado. Solo permite marcas naturales coincidentes; sigue señalando overlays, titulares publicitarios y letras inventadas, aunque el titular aparezca en la referencia. Sin referencia mantiene la revisión estricta anterior.
- Ambas imágenes y el resto del JSON comparten un límite de 8 MiB en bytes, con lectura acotada y cancelación del stream. Las referencias inválidas se rechazan antes del proveedor; no se descargan URLs.
- Pruebas con proveedor simulado: orden y etiquetas de las imágenes, contrato anterior, errores de referencia, overlays, protección de producto, límites y dos imágenes válidas cerca de 8 MiB sin desbordar la pila de expresiones regulares. No cambia la autenticación ni autoriza exportaciones automáticamente.

## Sin sellar · rama morfeo/stock-subida-partes · SubMorfeoMacMini · MacMini

- **Subida por partes, a prueba de MP4 truncados y sin basura** (8-oct-2026). El Adaptador de Pixeria
  mandaba MP4 de ~70 MB en base64 dentro de un JSON y el isolate pasaba de 128 MB (503 «Worker exceeded
  resource limits»). Pasa a usar `/stock/upload/*` + `/stock/publish {r2Staged}`, que ya existía; aquí se
  endurece:
  - `/stock/upload/init` guarda `size` en el customMetadata de la subida (`declaredSize`); `size` no
    entero o negativo → 400 `bad-size`.
  - `/stock/upload/complete` compara lo ensamblado con lo anunciado: si no cuadra, borra el fichero y
    responde 400 `size-mismatch {declared, size}`.
  - `/stock/publish` con `r2Staged` borra también la copia de `uploads/` cuando responde `reused`.
  - El cron de cada 10 min borra de `uploads/` lo cerrado hace más de 24 h y nunca publicado
    (`stockStagingSweep`).
- Test: `test/stock-subida-partes.test.mjs` (trozos en streaming sin leerlos a memoria, tamaño, abort,
  limpieza y misma entrada del Stock que el carril base64).

## v.07.10.2026.r4.22:03 · NeoMBP16 · MacBookPro16

- **Hashtags de destino** (Carlos, 7-oct-2026). Una etiqueta admite 80 caracteres (antes 30): el hashtag de una
  pantalla —`#starbucks_paseodegracia_103_pantalla1`— se cortaba y dos pantallas acababan en la misma etiqueta.
- Al publicar (`POST /stock/publish`, también las importaciones por Telegram) los hashtags escritos en el comentario,
  el título o el texto pasan a ser etiquetas de la pieza y van delante de las automáticas. No cuentan colores
  (`#ff8800`), números sueltos ni anclas de enlace.
- `POST /stock/:id/tags` guarda en la misma forma canónica que el resto y ya no descarta en silencio las largas.

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
