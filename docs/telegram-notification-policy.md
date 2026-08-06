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
| `server_error` | Cualquier respuesta >= 500 | Aviso inmediato saneado, incluso en rutas normalmente silenciadas | Sin umbral |
| `business_error` | Otros 4xx de operaciones reales | Aviso inmediato saneado | Sin umbral |
| éxito o ruido conocido | Respuesta esperada o ruta de telemetría | Silenciar salvo aviso explícito del handler | No aplica |

Si KV no está disponible, los agregados `auth_rejected` y `probe_404` fallan
cerrados: no reabren el envío individual a Telegram. La degradación queda
visible mediante un `console.warn` saneado y
`healthz.notificationAggregatorAvailable=false`. Los 5xx y errores de negocio
no dependen de KV y conservan su aviso inmediato.

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

Quedan prohibidos: `Origin`, IP, user-agent literal, query string, cuerpo de la
respuesta, cookies, cabeceras de autorización, claves, tokens y secretos. Los
paths variables se convierten a patrones antes de agregarlos.

## Persistencia y concurrencia

Cada evento usa una clave inmutable
`notify:aggregate:v1:event:<kind>:<bucket>:<fingerprint>:<timestamp>:<uuid>`.
El shard contiene `v`, `kind`, `path`, `source`, `fingerprint`, `at` y `bucket`;
el marker de resumen conserva `reportedAt` y `count`. Ambos tienen TTL limitado.

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

El diagnóstico legible debe devolver únicamente los mismos campos saneados del
registro agregado. No debe exponer el valor original usado para construir un
fingerprint.
