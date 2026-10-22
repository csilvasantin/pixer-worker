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

## Reglas básicas de la plantilla v5.3 (Carlos, 22-oct-2026 · todas las tipologías)

1. **Cartela inicial (0–2 s):** foto/miniatura de la fuente de fondo, difuminada y oscurecida; «¿Sabías que?» encima del logo de Admira (en blanco) y la tipología debajo (v5.2). Sin subtítulo (v5.4: repetía el titular).
2. **El vídeo de la fuente está presente durante TODA la explicación (2 s → 14 s)**, junto al texto, no en un tramo de 4 s. Se toman 12 s del centro de la fuente; si dura menos, se repite en bucle.
3. **Fuente vertical (Shorts, TikTok, Reels) en 16x9:** vídeo a la DERECHA a toda la altura; titular y gancho/giro/remate a la IZQUIERDA; sin crédito ni pastilla en el cuerpo (v5.4).
4. **Fuente vertical en 9x16:** vídeo a pantalla completa como protagonista; franja oscura degradada arriba (¿Sabías que? + logo) y abajo (titular y gancho/giro/remate); sin crédito ni pastilla (v5.4).
5. **Fuente horizontal:** la composición de siempre (caja a la derecha en 16x9, caja ancha en medio en 9x16), pero durante toda la explicación.
6. **Cierre (14–18 s):** fijo, por corte, sin animación (v5.1).
7. **Stock:** `capsuleSource.broll` = `{start:2,end:14}`: pulsar el vídeo en cualquier momento de la explicación abre la fuente.
8. **B-roll real:** si ya se bajó el vídeo en una versión anterior del mismo encargo se reutiliza; si no, yt-dlp con varios clientes (por defecto, android_vr, tv, ios, web_safari, mweb, web_embedded) sin cookies; bandas negras recortadas con cropdetect; si todo falla, «FALLBACK miniatura» en cola.log y `broll/origen.json`.
9. **Versiones:** `rehacer:true` en `/capsula/url/encargar` sube `capsuleVersion`; al publicar, las piezas anteriores quedan `oculto:true` (no se borran). Para rehacer a mano, parar antes `cola_bucle.sh` y reanudarlo después para no publicar dos veces.

## v5.4 · menos es más (Carlos, 22-oct-2026 · todas las tipologías)

10. **Nada de pastillas ni «Toca para ver el original».** La única pista es un icono pequeño de reproducir (círculo con triángulo) con un leve resplandor que respira, en la esquina superior derecha del vídeo. La interactividad real la da el modal del Stock (cursor de mano, clic abre la fuente en 2–14 s).
11. **La fuente se menciona una sola vez:** ni crédito «Vídeo: …» ni línea «Fuente: …» en el cuerpo. Al pie del cierre fijo, pequeño y gris: «Vídeo original: <autor> · <dominio>» (atribución mínima del material ajeno). El crédito sigue en `capsuleSource.credit` para el modal.
12. **Fuera lo que sobra:** sin subtítulo en la cartela inicial, sin degradado de pie en el vídeo de 16x9 (ya no hay texto encima).
