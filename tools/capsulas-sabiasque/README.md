# Cápsulas «¿Sabías que?» · pipeline v5 / v5.1 (Python + ffmpeg, GrokBotBox)

Copia versionada de `/workspace/sabiasque` en GrokBotBox (22-oct-2026). Se ejecuta en el Box (Python 3 + Pillow + numpy + ffmpeg + yt-dlp), no en el Worker.

| Fichero | Qué hace |
|---|---|
| `plantilla_v5.py` | Piezas de la plantilla: barras de progreso, una línea a la vez, línea de fuente. v5.1: `CIERRE_S=4`, `T_TOTAL_V51=18` (2 + 12 + 4). |
| `render_url.py` | Render de las cápsulas encargadas desde el Creador (generaliza `referencia-taalas-v2/render_v2.py`). v5.1: «¿Sabías que?» encima del logo y tipología debajo; cartela final fija por corte seco; crédito «Vídeo: autor» + «Toca para ver el original» en el b-roll. |
| `capsula_cola.py` | Lee `GET api.admira.store/capsula/url/cola`, prepara `guion.json`, b-roll (yt-dlp o miniatura), renderiza y publica vertical + horizontal con `externalRef = capsula-url:<hash>` y `capsuleSource {sourceUrl, credit, broll{start,end}, version}`. Una versión nueva oculta (no borra) la anterior. |
| `cola_bucle.sh` | Bucle cada 2 min: `nohup ./cola_bucle.sh >> cola.log 2>&1 &`. |
| `publicar_sabias_v5.py` | Publicador original de las cápsulas v5 (ensayo sin `--publicar`). |
| `capsula_desde_url.py` | Flujo manual URL → carpeta de cápsula. |
| `subir_youtube.py` | Subida a YouTube; lee credenciales de `/home/box/.secrets` (no incluidas). |
| `referencia-taalas-v2/` | Render y guion de #1793/#1794 como referencia. |

Rehacer una cápsula: `POST /capsula/url/encargar` con `rehacer: true` (sube `capsuleVersion`).
