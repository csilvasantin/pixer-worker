# Política de notificaciones HTTP a Telegram

Esta política evita una notificación por cada petición hostil o repetitiva sin
ocultar incidentes operativos. La clasificación usa únicamente método, ruta
normalizada, estado y un código de error controlado por el Worker. Nunca usa el
`Origin`, la IP, la query ni el cuerpo como texto de una alerta.

## Decisión por clase

| Clase | Criterio | Acción | Umbral y ventana |
| --- | --- | --- | --- |
| `probe_404` | `POST` 404 sobre una ruta conocida de sondeo | Agregar; no avisar cada petición | 20 eventos / 10 minutos; resumir también al vencer |
| `auth_rejected` | 401/403 con código interno exacto `bad-key` | Agregar; no avisar cada petición | 3 eventos / 5 minutos; resumir también al vencer |
| `server_error` | Cualquier respuesta >= 500 | Aviso inmediato saneado, incluso si se repite o la ruta suele estar silenciada | Sin umbral |
| `business_error` | Otros 4xx de operaciones reales | Aviso inmediato saneado | Sin umbral |
| `invalid_ack_reference` repetido | `POST /locations/cmd/ack`, 4xx y código exacto | Primer aviso inmediato; repetición idéntica limitada y recuperación visible | 1 aviso / 5 minutos |
| éxito o ruido conocido | Respuesta esperada o ruta de telemetría | Silenciar salvo aviso explícito del handler | No aplica |

Si KV no está disponible, los agregados `auth_rejected` y `probe_404` fallan
cerrados: no reabren el envío individual a Telegram. La degradación queda
visible mediante un `console.warn` saneado y
`healthz.notificationAggregatorAvailable=false`. Los 5xx y errores de negocio
fallan abiertos: conservan el aviso para no ocultar el primer incidente, aunque
durante esa degradación no se puede garantizar su deduplicación ni anunciar una
recuperación que no se haya podido contrastar.

## Incidentes repetidos y recuperación

El fallo conocido `invalid_ack_reference` del ACK mantiene en KV un estado acotado por operación.
La operación se identifica con un hash de método, ruta saneada y clase de fuente;
el fallo añade estado HTTP y código interno controlado. El primer fallo siempre
se envía. Una repetición exactamente igual dentro de cinco minutos se suprime;
al vencer el cooldown se permite un recordatorio con el conteo acumulado. Un
estado o código distinto no entra en este rate-limit y avisa inmediatamente,
por lo que el cooldown de un `invalid_ack_reference` no puede ocultar un 5xx ni
otro error de negocio. La política no silencia globalmente respuestas 400.

El primer éxito posterior de la misma mutación emite `RECUPERADO` y desactiva el
incidente; éxitos sucesivos no repiten la recuperación. Rutas de telemetría y
polling que ya estaban silenciadas no añaden lecturas KV. La entrega es
at-least-once: el lock local serializa ráfagas dentro de un isolate y KV conserva
el estado entre isolates, pero Workers KV no ofrece compare-and-swap y una carrera
entre isolates podría duplicar un primer aviso; nunca puede suprimirlo.

## Resumen seguro

Formato orientativo, acotado a 1.200 caracteres:

```text
⚠️ HTTP agrupado · auth_rejected
· /grid/book · 7 intentos
· origen seguro cli:3bdb6c58d6f118baf85e
· umbral alcanzado · 5 min
```

El resumen contiene solo:

- clase y conteo total;
- ruta normalizada y duración de la ventana;
- motivo de consolidación (`umbral alcanzado` o `ventana cerrada`);
- clase de fuente y fingerprint irreversible para correlación.

En incidentes de navegador el User-Agent literal no forma parte del fingerprint
operativo. Clasificar la fuente como `browser` evita que Chrome/Safari comunes
fragmenten o fusionen el estado por versiones privadas, sin almacenar `Origin`,
`Referer`, IP ni contenido del request.

Quedan prohibidos: `Origin`, IP, user-agent literal, query string, cuerpo de la
respuesta, cookies, cabeceras de autorización, claves, tokens y secretos. Los
paths variables se convierten a patrones antes de agregarlos.

## Persistencia y concurrencia

Cada evento usa una clave inmutable
`notify:aggregate:v1:event:<kind>:<bucket>:<fingerprint>:<timestamp>:<uuid>`.
El shard contiene `v`, `kind`, `path`, `source`, `fingerprint`, `at` y `bucket`;
el marker de resumen conserva `reportedAt` y `count`. Ambos tienen TTL limitado.

La consolidación programada pertenece exclusivamente al cron `*/2`. El Worker
también tiene un cron `*/10`, pero ambos coinciden en los minutos múltiplos de
diez y Workers KV no ofrece compare-and-swap: permitir que los dos hicieran el
flush podía emitir dos resúmenes idénticos de una misma ventana. El cron `*/10`
mantiene sus otras tareas, pero no consolida alertas.

Un `get` seguido de `put(count + 1)` en Workers KV no es un contador atómico:
dos peticiones concurrentes pueden leer el mismo valor y sobrescribirse. Por
eso la implementación de producción debe serializar por clave, usar un Durable
Object o registrar eventos idempotentes fragmentados y consolidarlos. La prueba
de contrato `assertExactConcurrentCount` exige que una ráfaga conserve todos
los eventos; no se acepta un conteo meramente aproximado si el objetivo es no
perder incidentes.

## Observabilidad y pruebas

`test/support/notify-policy-harness.mjs` aporta reloj falso, KV en memoria con
TTL, envío Telegram espía y una aserción de concurrencia exacta. Las pruebas
deben cubrir:

1. umbral, vencimiento, resumen y reinicio de cada ventana;
2. ráfagas simultáneas con conteo exacto;
3. degradación por KV ausente;
4. spoofing de `Origin` y ausencia de IP, query, cuerpos y secretos;
5. tráfico frecuente de estadísticas sin Telegram real.
6. primer fallo, ráfaga repetida, fallo distinto y recuperación única para
   operaciones browser como `POST /locations/cmd/ack`.

El diagnóstico legible debe devolver únicamente los mismos campos saneados del
registro agregado. No debe exponer el valor original usado para construir un
fingerprint.
