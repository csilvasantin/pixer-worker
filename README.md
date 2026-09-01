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
| POST | `/xai/video/edit`       | Edita un vídeo preparado y genera su contexto lateral |
| GET  | `/xai/video/{id}`       | Grok Imagine Video — poll status |
| POST | `/stock/publish`        | Publica en Stock; `externalId` requiere el secreto interno y evita duplicados |

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

### POST /xai/video/edit
```json
{ "prompt": "Conserva el centro y completa los laterales de forma natural", "video_url": "data:video/mp4;base64,..." }
```

La entrada ya debe tener la relación de aspecto de salida. Pixeria prepara un
lienzo 16:9 con el vídeo vertical en el centro, solicita la generación lateral
y vuelve a superponer el original para conservar exactamente el contenido y el
audio centrales. xAI limita la edición a 8,7 segundos y devuelve como máximo
720p; el cliente debe validar esos límites antes de enviar. Este endpoint exige
el secreto servidor→servidor en `X-AdmiraNeXT-Ingest` y solo admite una data URI
de vídeo o una URL de los almacenes propios de Admira.
La autorización del llamador depende del secreto, no de la cabecera HTTP
`Origin` (que un cliente no navegador puede falsificar); la restricción de
origen descrita aquí se refiere a la procedencia del fichero de entrada.

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
