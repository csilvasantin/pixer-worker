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
3. **Fuente vertical (Shorts, TikTok, Reels) en 16x9:** desde v5.5, ver regla 13 (bandas laterales). Antes: vídeo a la DERECHA a toda la altura; titular y gancho/giro/remate a la IZQUIERDA; sin crédito ni pastilla en el cuerpo (v5.4).
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

## v5.5 · bandas laterales para fuente vertical (Carlos, 22-oct-2026 · todas las tipologías)

13. **Fuente vertical en 16x9:** la imagen/vídeo va CENTRADA en su proporción vertical a toda la altura. Las bandas laterales son un desenfoque muy apagado de la propia imagen (sin cajas). Banda izquierda: logo de Admira arriba a la izquierda (en blanco). Banda derecha: «¿Sabías que?» y debajo la tipología.
14. **Cartela inicial (0–2 s):** la imagen central pasa de borrosa a nítida en 1,6 s (smoothstep) mientras el logo y los textos de la derecha entran desde los lados.
15. **Cuerpo (2–14 s) con la misma composición de bandas** por coherencia: vídeo centrado sin saltos desde la cartela, logo y «¿Sabías que?» + tipología fijos en su sitio, titular y gancho/giro/remate en la banda izquierda bajo el logo; icono de reproducir en la esquina del vídeo.
16. **9x16:** sin bandas; composición v5.4 con la cartela de foto difuminada. El vídeo del cuerpo entra con un revelado breve de borroso a nítido (0,7 s).

## v5.6 (Carlos, 22-oct-2026 · todas las tipologías)

17. **Lados invertidos en 16x9 con fuente vertical** (cartela y cuerpo): banda IZQUIERDA = logo de Admira arriba y debajo «¿Sabías que?» + tipología; banda DERECHA = titular y gancho/giro/remate. El vídeo sigue centrado con el revelado borroso → nítido. (Sustituye el reparto de las reglas 13 y 15.)
18. **Sin icono de reproducir** en ningún formato (sustituye la regla 10). La interactividad es sólo del modal del Stock: cursor de mano y clic en la imagen dentro de 2–14 s abre la fuente; el modal ya no pinta la pastilla «Ver el original» (admira-studio, parche capsula-fuente-v56).
19. El crédito mínimo gris del cierre («Vídeo original: …») se mantiene como en v5.4.

## v5.7 · cartelas opcionales (Carlos, 22-oct-2026 · todas las tipologías)

20. **Preroll y postroll son opcionales y van DESACTIVADOS por defecto.** `POST /capsula/url/encargar` acepta `preroll` y `postroll` (booleanos, por defecto `false`); el encargo los guarda en `cartelas`, la cola los pasa al guion y `capsuleSource` los registra. En el Creador (`/creador/?capsula=new`) hay dos interruptores «Preroll» y «Postroll», apagados.
21. **Duración:** cuerpo 12 s + 2 s si hay preroll + 4 s si hay postroll (12, 14, 16 o 18 s). El vídeo de la fuente va en bucle si es más corto. El tramo interactivo (`capsuleSource.broll`) es el cuerpo: sin cartelas, toda la cápsula (0–12 s).
22. **Sin cartela** la marca sigue en el cuerpo: en 16x9 con fuente vertical, logo y «¿Sabías que?» + tipología en la banda izquierda; en 9x16, «¿Sabías que?» y logo en la franja superior. Sin postroll no hay crédito final (el crédito queda en `capsuleSource.credit` para el modal).
23. Guiones anteriores a v5.7 (sin `cartelas`) se renderizan con las dos cartelas, como antes.
