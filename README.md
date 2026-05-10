# pixer-eleven · Cloudflare Worker

Proxy server-side para llamadas de Pixer.ai a ElevenLabs y xAI/Grok.
Las API keys viven como **secrets de Cloudflare** — nunca se exponen al navegador.

## Deploy inicial

Desde esta carpeta:

```bash
npx wrangler login                          # 1ª vez
npx wrangler secret put ELEVENLABS_KEY      # pega tu sk_...
npx wrangler secret put XAI_KEY             # pega tu xai-...
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
