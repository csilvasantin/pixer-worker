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
| PATCH | `/stock/{id}/meta`     | `{catalogo?, tags_add?, tags_remove?}` — backfill/edición; misma clave que el DELETE |

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
