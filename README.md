# pixer-eleven · Cloudflare Worker

Proxy server-side para llamadas de Pixer.ai a ElevenLabs y xAI/Grok.
Las API keys viven como **secrets de Cloudflare** — nunca se exponen al navegador.

## Deploy inicial

Desde esta carpeta:

```bash
npx wrangler login                          # 1ª vez
npx wrangler secret put ELEVENLABS_KEY      # pega tu sk_...
npx wrangler secret put XAI_KEY             # pega tu xai-...
npx wrangler secret put ADMIRANEXT_INGEST_TOKEN # carril interno ADmiraNeXT → Stock
npx wrangler deploy
```

URL resultante: `https://pixer-eleven.<tu-subdomain>.workers.dev`

## Verificar

```bash
curl https://pixer-eleven.<tu-subdomain>.workers.dev/healthz
# → {"ok":true,"hasElevenKey":true,"hasXaiKey":true}
```

## Endpoints

| Método | Path | Descripción |
|---|---|---|
| GET  | `/healthz`              | Ping + estado de las keys |
| POST | `/tts`                  | ElevenLabs text-to-speech (audio/mpeg) |
| POST | `/xai/image`            | Grok 2 Image (devuelve `{data:[{url}]}`) |
| POST | `/xai/video`            | Grok Imagine Video — start (devuelve `{request_id}`) |
| GET  | `/xai/video/{id}`       | Grok Imagine Video — poll status |
| POST | `/stock/publish`        | Publica en Stock; `externalId` requiere el secreto interno y evita duplicados (ver «Dedup del Stock») |
| GET  | `/stock/exists`         | `?hash=<sha256>` o `?externalId=<id>` → `{exists, id, url}`; pregunta ANTES de subir |
| DELETE | `/stock/{id}`         | Borra asset+meta. Con clave: `X-AdmiraNeXT-Ingest` o `NOTIFY_KEY` (`?secret=`, `X-Notify-Key` o `{secret}`) |
| GET  | `/stock/list`           | Listado; filtros `type`, `motor`, `catalogo=<id>`, `cliente=<slug>`, `tag=<tag>`, `q=<texto>` (ver «Catálogo») |
| GET  | `/stock/catalogos`      | Catálogos agrupados desde el índice: `{ok, catalogos:[{id, cliente, nombre, desde, hasta, proyecto, count, ultimo, vigente, ids}]}` |
| PATCH | `/stock/{id}/meta`     | `{catalogo?, tags_add?, tags_remove?, oculto?, validacion?}` — backfill/edición; misma clave que el DELETE |
| GET  | `/stock/poster/{id}`    | Póster representativo (`image/jpeg`, caché 1 día, CORS `*`); 404 si no lo tiene. Es `meta.poster` |
| POST | `/stock/poster`         | `{id, poster:<data URL> \| base64+mime, at?, validacion?}` — clave `STOCK_POSTER_KEY`/`NOTIFY_KEY` en `secret`, `X-Notify-Key` o `?secret=` |

### Póster y validación de vídeos (v.12.09.2026.r2 · Yokup #3199)

El previo del «Langostino cocido» salía negro en admira.tv/contentcatalogue: el máster solo tiene
negro el fotograma 0 (relleno `#020508` del canvas antes de `captureStream()`) y el webm de
MediaRecorder no lleva Duration ni Cues, así que el `#t=0.1` del previo pintaba ese fotograma.
Regla de Carlos: el previo nunca es un fotograma negro y nada se publica sin validar.

- `POST /stock/publish` acepta **`poster`** (data URL JPEG/WebP ≤ 400 KB), `posterAt` y
  **`validacion`** `{ok, negros, muestras, duracion, motivo, por}`. El póster va a
  `stock/<id>/poster.jpg`; `meta.poster = https://api.admira.store/stock/poster/<id>` (estable) y
  `meta.thumbnail` (R2 directo con `?v=`). Se valida antes de mover el asset (400/413 sin dejar restos).
- `/stock/list`, `/stock/exists` y el índice exponen `poster`, `thumbnail`, `validacion`, `oculto`.
- **`oculto:true`** (vía PATCH) saca la pieza de `/stock/list`, `stock/index.json` y `/stock/catalogos`
  sin borrarla; `?ocultos=1` en `/stock/list` la enseña. Para un máster inválido: `PATCH {oculto:true,
  validacion:{ok:false, motivo}}`.
- Criterio (mismo en el creador, el catálogo y el backfill): negro = luma < 16 (o < 24 con varianza
  < 25); inválido si > 70 % negros, < 10 s o sin pista; póster = luma 40..220 y máxima varianza
  fuera de los 0,8 s de cada extremo (`src/stock-poster.mjs`).
- Backfill con ffmpeg: `NOTIFY_KEY=… node tools/valida-videos-catalogo.mjs --catalogo <id> --subir`
  (repo admira-next-web).

### Catálogo del Stock (v.12.09.2026.r1 · Yokup #3183)

Las piezas que admiranext genera para un folleto (Alcampo 10–23 sep) entraban como
vídeos sueltos con 4 etiquetas fijas. Ahora (reglas puras en `src/stock-catalogo.mjs`):

- `POST /stock/publish` acepta **`catalogo`**:
  `{id:"alcampo-2026-09-10", cliente:"alcampo", nombre:"Alcampo · 10–23 sep 2026", desde:"2026-09-10", hasta:"2026-09-23", proyecto:"admira-tv", producto:"coca-cola"}`
  → `meta.catalogo` saneado (id/cliente/producto/proyecto `[a-z0-9-]`, fechas ISO, nombre ≤120).
  Si viene y no trae id utilizable → `400 bad-catalogo`.
- **Hashtags automáticos** con catálogo: `catalogo`, `<cliente>`, `<catalogo.id>`, `<AAAA-MM de desde>`
  se añaden a `tags` además de los del cliente. **Tope de tags: 10** (antes 4). Si sobran se
  recortan los del cliente por el final; los automáticos y el de calidad nunca.
- `GET /stock/list?catalogo=<id>` · `?cliente=<slug>` · `?tag=<tag>` · `?q=<texto>` (todas las
  palabras en título/prompt/comentario/tags/id/num/campos del catálogo).
- `GET /stock/catalogos[?cliente=&vigente=1]` sale de `stock/catalogos.json` (se escribe en cada
  reindex, o sea tras cada publish/patch/delete y con el cron); `vigente` se recalcula al servir.
  `ids` lleva hasta 500 ids por catálogo, ordenados por `ultimo` desc.
- `PATCH /stock/{id}/meta` con `{catalogo?, tags_add?:[], tags_remove?:[]}` (`catalogo:null` lo
  retira). Recalcula hashtags (quita los del catálogo anterior) y regenera el índice.
  Clave: `X-AdmiraNeXT-Ingest`, o `NOTIFY_KEY` por `?secret=`, `X-Notify-Key` o `{secret}`.
- CORS: `Allow-Methods` incluye `PATCH`; `Allow-Headers` incluye `X-AdmiraNeXT-Ingest, X-Notify-Key`.

Test: `node --test test/stock-catalogo.test.mjs`.

### Dedup del Stock (v.11.09.2026.r1)

El 11-sep-2026 entró dos veces el mismo vídeo. Causa: sin `externalId` cada publish
inventa un id (`${ts}-${random}`), así que un doble clic, un reintento o dos paquetes
de admiranext con el mismo máster creaban dos assets; y con `externalId` solo se
miraba la identidad, nunca el contenido. Reglas (decisión pura en `src/stock-dedup.mjs`):

1. **Contenido** — sha256 del binario completo, guardado en `meta.contentHash`.
   Índice KV `stock:hash:<sha256>` → id (repesca en `stock/index.json` si el KV no se
   escribió). Mismo hash en otro asset → `{ok, reused:true, reason:'duplicate_content', id}`
   y no se crea nada. En base64 se decide antes del put; en streaming (`sourceUrl`,
   `r2Staged`) el hash se calcula al vuelo con `crypto.DigestStream` y, si es duplicado,
   se borra lo recién escrito. Solo los assets publicados desde esta versión tienen hash.
2. **Identidad** — mismo `externalId` → mismo id opaco. Contenido igual →
   `reused` (`duplicate_external_id`); contenido distinto → se **sustituye el binario y
   se conserva el id** (`{ok, replaced:true, reason:'external_id_new_content'}`),
   manteniendo num, valoraciones, consumos, alta y cara. Para no descargar en vano,
   manda `contentHash` en el body: si coincide con el que hay, responde `reused` sin bajar nada.
3. **Reciente** — mismo `title`+`motor`+`sourceUrl` en los últimos
   `STOCK_DEDUP_WINDOW_MIN` minutos (10; `0` apaga) → `reused` (`duplicate_recent`)
   sin descargar. Solo sin `externalId`. KV `stock:recent:<sha256(tupla)>` con TTL.

Cómo debe llamar un creador: `GET /stock/exists?hash=<sha256>` (o `externalId=`) →
si `exists`, usa `id`/`url`; si no, `POST /stock/publish` incluyendo `contentHash`.
Test: `node --test test/stock-dedup.test.mjs`.

### POST /tts
```json
{ "text": "...", "voice_id": "EXAVITQu4vr4xnSDxMaL", "model_id": "eleven_multilingual_v2" }
```

### POST /xai/image
```json
{ "prompt": "...", "n": 1 }
```

### POST /xai/video
```json
{ "prompt": "...", "duration": 8, "aspect_ratio": "16:9", "resolution": "720p" }
```

## RTB · Motor de decisión programática (subasta de segundo precio)

El "hueco del medio" entre inventario (`/campaign`) y emisión (`/emit`, `/signage`):
dada una impresión concreta (pantalla + circuito + segmento) decide en tiempo real
qué campaña gana y a qué precio con **second-price REAL** (no `Math.random`).

| Método | Path | Descripción |
|---|---|---|
| POST | `/rtb/decide` | Subasta una impresión entre las campañas activas |
| GET  | `/rtb/feed?limit=20` | Últimas decisiones (para que el reproductor sustituya su feed simulado) |

### POST /rtb/decide
```json
{ "screen": "scr-001", "circuit": "xtanco-madrid",
  "segment": { "audience": "female", "age": "adulto", "category": "", "slot": "" },
  "floor": 0 }
```
- **Candidatas**: campañas de `/campaign` con `active !== false` y `budget > 0` cuyo
  targeting case con el segmento. `audience`/`age` se normalizan a la clave del gemelo
  (`joven_m`,`adulto_f`,`senior_m`,`nino_f`…). Campaña con `seg` vacío = run-of-network
  (elegible para cualquier segmento). `category`/`slot` filtran solo si ambos lados los declaran.
- **Precio (second-price)**: gana el mayor CPM y paga `max(floor, 2º-CPM + 0.01)`
  (nunca por encima de su propia puja); si es la única candidata paga `max(floor, CPM*0.6)`.
- **Efectos**: descuenta `price` del `budget` de la ganadora y apunta la decisión en
  KV `rtb:day:<YYYYMMDD>` (array circular, máx 500).

Respuesta con demanda (200):
```json
{ "ok": true, "decision": {
  "id": "…", "advertiser": "Coca-Cola", "title": "Coca-Cola Zero",
  "creativeUrl": "https://…", "medio": "led",
  "cpm": 12, "price": 9.01, "currency": "EUR", "ttlSec": 300 } }
```
Sin demanda (200): `{ "ok": false, "reason": "no_demand" }`.

### GET /rtb/feed?limit=20
```json
{ "ok": true, "count": 2, "decisions": [ { …decision, "screen", "circuit", "seg", "budgetLeft", "ts" } ] }
```
Más recientes primero; rellena con las de ayer al cruzar medianoche (zona Europe/Madrid).

### Campos opcionales de /campaign para RTB (retrocompatibles)
`advertiser`, `medio` (p.ej. `led`,`dooh`,`totem`), `stockId` (resuelve `creativeUrl`
contra el Stock si la campaña no trae uno propio), `category`, `slot`, `circuit`. `seg` pasa
a ser **opcional** (vacío = sin targeting demográfico); si se envía uno debe seguir siendo válido.

- `slot` y `category` se validan contra **enums** (400 `bad-slot`/`bad-category` si no casan,
  normalizando tildes/ñ — `"mañana"` se acepta y guarda como `manana`):
  - `slot`: `manana` | `mediodia` | `tarde` | `noche`
  - `category`: `atraer` | `producto` | `promo` | `marca`
  La misma normalización se aplica en `/rtb/decide` al comparar (defensa en profundidad
  para campañas guardadas antes de esta validación).
- `circuit`: si la campaña lo declara, **solo casa** en decides de ese circuito (incluye
  excluirla de decides sin `circuit`). Sin él, la campaña es run-of-network: compite en
  todo circuito (comportamiento por defecto, decisión de Neo).
- Buckets de edad del canal: `vejez` (cámara 75+) se normaliza a `senior` — no se amplía
  `SEG_CPM_KEYS`. Un segmento **incompleto o irreconocible** en el decide NUNCA gana
  campañas con targeting demográfico: solo compiten las catch-all sin `seg`.

CORS: `admira.tv` y `clearchannel.tv` ya están en `ALLOWED_ORIGINS` (GET/POST + preflight).

## Rotar keys

```bash
npx wrangler secret put ELEVENLABS_KEY    # o XAI_KEY
```

## Costes

- Cloudflare Workers: gratis hasta 100k peticiones/día.
- ElevenLabs / xAI: lo que ya estés pagando — el worker solo proxea.

## Borrar el worker

```bash
npx wrangler delete pixer-eleven
```

## Anonimizador demo · Anonymizer demo

ES: Abre https://www.pixeria.com/anonimizador. Se carga por defecto visitor-green-v1, una persona ficticia con original y ejemplos 8, 16 y 32 bits. No necesita cámara, subida, generación ni publicación en Stock. Descargar guarda cada variante. Usar mi foto abre el flujo anterior; Usar ejemplo recupera la demo. La transformación de una foto real no garantiza anonimización irreversible.

EN: Open https://www.pixeria.com/en/anonimizador.html. visitor-green-v1 loads by default: a fictional person with an original and 8, 16 and 32-bit examples. No camera, upload, generation or Stock publication is required. Download saves each variant. Use my photo opens the existing workflow; Use example restores the demo. Transforming a real photo does not guarantee irreversible anonymization.

Tutorial ES: 1. Compara las cuatro tarjetas. 2. Pulsa Enviar al Xpacio. 3. Abre https://www.xpaceos.com/admira-xp/ y entra en una tienda. 4. Activa /clientes on y elige Good, Better o Best. Se añade UN visitante: Good usa su sprite 8-bit; Better y Best interpretan su ficha de ropa, pelo y colores con sus modelos, no muestran una foto plana idéntica. Las imágenes 16/32 también viajan como recursos del personaje. La demo no incluye caminata Matrix/64-bit. La visibilidad inicial de la tienda sigue en OFF.

Tutorial EN: 1. Compare the four cards. 2. Click Send to Xpace. 3. Open https://www.xpaceos.com/admira-xp/ and enter a store. 4. Enable /customers on and choose Good, Better or Best. ONE visitor is added: Good uses its 8-bit sprite; Better and Best interpret its outfit/hair/palette profile using their models, rather than displaying an identical flat photo. The 16/32 images also travel as character assets. This demo does not include Matrix/64-bit walking. Store visibility still starts OFF.

MCP: https://mcp-pixeria.admira.store/mcp → anonymizer_demo {action:"info"} returns assets and instructions. {action:"send",screen:"optional-target"} requires the existing authenticated fleet key and queues the prepared visitor. {action:"status",id:"npc_..."} checks receipt. ES: No confundir queued con entrega. EN: queued is not delivery. consumed:true is the Xpace software acknowledgement, not proof of physical screen playback. Without a target the existing visitor queue is shared by open twins; provide screen when targeting one. Never announce arrival merely because send returned ok.

API: POST https://api.admira.store/twin/spawn with image (8-bit data URL), persona (fictional original), npc16, npc32 (PNG data URLs), demo_id:"visitor-green-v1", name and optional screen. GET /twin/persona?id=… returns demo, ready, style, npc16 and npc32. This allowlisted preset supplies the style without paid generation. /twin/spawn/status?id=… returns consumed. Existing personal-photo generation remains unchanged.

Assets: https://www.pixeria.com/assets/anonymizer-demo/{original.jpg,8-bit.png,16-bit.png,32-bit.png}. Artistic 8/16/32-bit labels describe visual style, not file color depth. Generated with imagegen from a fictional adult, dark wavy hair, forest-green cardigan, ivory T-shirt, charcoal trousers and white sneakers. Source prompt: front-facing full-body studio photo, neutral background, no logos. Variant prompts: same outfit and pose, transparent background; coarse chibi NES sprite, detailed SNES pixel sprite, early PlayStation low-poly 3D character respectively. Generation originals retained locally; optimized assets are checked into Pixeria.

## Locuciones de España / Spain announcements

`GET /tts/catalog` returns native voice metadata, TTS model IDs and subscription tier with the same authentication as paid TTS. `POST /tts` keeps its existing defaults; it also supports `output_format=mp3_44100_192|pcm_44100` and `language_code`. `model_id=eleven_v4` uses the official `/v1/text-to-dialogue` API; prior models retain text-to-speech. Creator supports MP3 192 kbps; PCM 44.1 kHz requires Pro. Provider keys remain server-side.

`GET /tts/catalog` devuelve metadatos de voces, modelos TTS y plan con la misma autenticación que TTS de pago. `POST /tts` conserva sus valores originales y admite formato 192 kbps/PCM e idioma. Eleven v4 usa la API oficial de diálogo. Creator admite MP3 192 kbps; PCM 44,1 kHz exige Pro. Las claves se quedan en el servidor.

`AnnouncementTts` is a named private Worker entrypoint with only `generate({text,voice})`. Voice is `male` (David Martín) or `female` (Sara Martín); maximum 1500 characters. It uses Eleven v4 at 44.1 kHz/192 kbps. Pages validates its signed session and same origin before invoking this internal binding. No credential is copied to Pages, and no public route exposes this entrypoint.

## Retail announcement preview / Vista previa de anuncios

ES: El entrypoint privado AnnouncementTts conserva generate({text,voice,language}) para las voces ESP/ENG y añade generateImage({text,language}) para una imagen PixerIA de la pantalla del contador. Pages comprueba sesión y origen. El texto admite hasta 1500 caracteres; la imagen fija grok-imagine-image, n=1 y base64, reutilizando xaiImageHandler. La vista previa original no crea campañas. El nuevo flujo autenticado archiva en Stock como se describe debajo. Las credenciales permanecen privadas.

EN: Private AnnouncementTts retains generate({text,voice,language}) for ESP/ENG voices and adds generateImage({text,language}) for one PixerIA counter-screen image. Pages validates session and origin. Briefs are limited to 1500 characters; images use fixed grok-imagine-image, n=1 and base64 through the existing xaiImageHandler. The original preview does not create campaigns. The new authenticated flow archives to Stock as described below. Credentials remain private.

## XpaceOS · vídeo, imagen y locución en Stock / Media archive

Opciones → Vídeo: escribe en Qué quieres anunciar (hasta 1500 caracteres) y pulsa Generar vídeo (Grok). Se crea un vídeo de 8 segundos, 16:9 y 720p, con el idioma ESP/ENG seleccionado. El estado muestra generación y guardado; al terminar aparece el reproductor y Ver en Stock. Imágenes, vídeos y locuciones ElevenLabs se archivan automáticamente en Stock con ID, número de catálogo, hash y URL estable. Una locución se genera una vez y se reproduce tres veces. La sesión Admira existente sirve para las tres funciones, sin otra contraseña. Reintentar recupera el mismo trabajo; el servidor puede terminar el guardado aunque cierres la página. Un nuevo trabajo consume otra generación de pago. Publicar en Stock sigue sus contratos y distribución existentes; este botón no crea una campaña ni conecta equipos físicos.

Options → Video: enter What do you want to advertise? (up to 1500 characters), then press Generate video (Grok). It creates an 8-second, 16:9, 720p video in the selected ESP/ENG language. Status shows generation and saving; once complete, the player and Open in Stock appear. Images, videos and ElevenLabs announcements are automatically archived in Stock with an ID, catalog number, hash and stable URL. Each announcement is generated once and played three times. The existing Admira session covers all three functions, without another password. Retrying recovers the same operation; the server can finish archiving after you close the page. A new operation consumes another paid generation. Stock publication follows its existing contracts and distribution; this button does not create a campaign or connect physical devices.

Same-origin authenticated POST /admira-xp/advertising-image, /admira-xp/advertising-video and /admira-xp/announcement-tts accept {text,language,requestId}; audio additionally requires voice (male/female). requestId is a client UUID, scoped by a server-derived identity hash. GET /admira-xp/media-job?requestId=<UUID> recovers only that identity’s job and never starts paid generation. State: generating → pending (video only) → archiving → done, or failed. done requires Stock receipt {id,num,url,contentHash,mime}; video adds duration:8, aspect:16:9, resolution:720p. Image/audio are hashed before Stock publication; video uses deterministic internal ingest identity and actual Stock hash. The private AnnouncementTts entrypoint reuses existing providers, secrets, STOCK_BUCKET and Stock publish pipeline. Provider IDs and keys are not exposed. Conditional R2 leases prevent concurrent duplicate provider starts; durable job and pending records precede provider admission. No automatic provider restart after an ambiguous outcome. Archival failures retain generated output and retry only Stock. Existing */2 cron completes pending video/archival work after browser closure. Video provider output must use HTTPS x.ai. Tags: xpaceos, admira-xp, creatividad/locucion, es/en. Stock receipts expose https://api.admira.store/stock/asset/<id>; gallery uses https://www.pixeria.com/stock.html?highlight=<id>. These shared/public Stock assets are not private per-user media. Cancel/Stop stops local announcement playback; an accepted paid operation may finish in Stock. Original PA voice IDs, 44.1 kHz/192 kbps, three readings, ducking, counter image preview (30 s), video playback controls, CLI and /marca retained. Browser/free speech is local and does not produce an audio file to archive. First Google sign-in remains necessary where no session exists. xpaceos.com GoDaddy DNS migration remains pending; current interactive entry reaches admira.store.

Private RPC: generateImage({text,language,owner,requestId}), startVideo({text,language,owner,requestId}), generate({text,language,voice,owner,requestId,archive:true}), getMedia({owner,requestId}). Legacy calls without owner retain their prior behavior solely for deployment compatibility; current Pages always uses authenticated archive calls. Generated MP3 headers X-Stock-Id, X-Stock-Url, X-Stock-Num and X-Media-Job are relayed by Pages. No new public paid endpoint or credential.

### Admira Studio · sesiones de generación / Generation sessions (7-oct-2026)

ES: Las llamadas del editor Studio a `/image/edit` ya usan este motor y su autenticación de sesión. Studio firma sus tokens con su propia clave: para los orígenes exactos HTTPS `admira.studio` y `www.admira.studio`, `authorizePaidGeneration` verifica el token en el endpoint fijo `https://admira.studio/auth/verify`. La cabecera Origin no autoriza por sí sola; token ausente, rechazo o fallo de red cierran la puerta. Pixeria conserva su verificación local/remota y las claves de flota mantienen su contrato. No se publican recursos ni se programan pantallas al verificar.

EN: Studio uses this generation engine with its own signed session. Exact HTTPS Studio origins use the fixed Studio token verifier; Origin alone grants no access. Missing/invalid token, verifier rejection or network failure denies generation. Pixeria authentication and fleet keys remain unchanged. No content publication or screen scheduling occurs during verification. This restores existing Studio image generation, including static backgrounds for Altadis physical walls; rendering remains in the editor.

## XpaceOS image video / Vídeo desde imagen

Private AnnouncementTts.startVideo accepts validated Stock imageId, duration:10 and aspect 16:9 or 9:16. Existing perimeter identity and UUID leases retained; source ID is part of operation identity and receipt metadata. Uses the original image as provider input and archives before preview. Public Pixeria 5-second clips and XpaceOS text-only 8-second jobs remain unchanged. La imagen original no se republica; el vídeo de 10 s conserva su referencia en Stock.
