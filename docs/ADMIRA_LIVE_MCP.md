# Admira Live MCP

## Objetivo

Crear un MCP de `www.admira.live` que permita a agentes y plataformas comunicarse con Admira usando una interfaz comun, segura y auditable.

El MCP no debe ser "otro bot". Debe actuar como capa de interoperabilidad:

- ChatGPT, Claude, Codex, OpenCode y futuros agentes usan las mismas herramientas.
- Telegram/AgoraMatrix sigue siendo el canal humano y operativo.
- `pixer-worker` sigue siendo el backend Cloudflare que ya conoce Telegram, KV, R2, Stock, Signage y Agora.
- `www.admira.live` queda como cara publica/documental del sistema y posible endpoint remoto cuando haya auth preparada.

## Encaje Actual

Infraestructura existente relevante:

- `pixer-worker` (`pixer-eleven`) ya ofrece endpoints `/agora/*`.
- `SIGNAGE_KV` guarda presencia, feed, inbox, tasks, configuracion y datos de producto.
- Telegram entra por `/telegram/webhook` y se enruta hacia AgoraMatrix.
- El CLI local `agora` ya habla con el backend via `AGORA_SYNC_KEY`.
- Hay bots/personas definidos: Neo, Morfeo, Trinity, Oraculo y Cypher.

Por eso el primer MCP debe envolver capacidades existentes antes de inventar nuevas.

## Arquitectura Propuesta

### Fase 1: MCP Local

Servidor MCP local en Node.js, pensado para Codex/Claude/ChatGPT Desktop:

```text
Cliente MCP -> admira-live-mcp local -> pixer-worker /agora + otros endpoints Admira
```

Ventajas:

- No expone secretos nuevos publicamente.
- Puede reutilizar `AGORA_SYNC_KEY` desde el entorno local.
- Permite iterar rapido con herramientas MCP reales.
- Evita cambiar el worker antes de validar el modelo.

### Fase 2: MCP Remoto

Servidor remoto con transporte HTTP Streamable:

```text
Cliente MCP remoto -> https://www.admira.live/mcp -> worker/router Admira -> plataformas
```

Requisitos antes de activar:

- Auth por token/OAuth o allowlist por cliente.
- Rate limiting por herramienta.
- Auditoria de acciones.
- Separar herramientas de lectura y herramientas de escritura.

## Herramientas MCP MVP

### agora_status

Devuelve estado de AgoraMatrix:

- agentes despiertos/dormidos;
- ultima presencia;
- colas pendientes;
- ultimo feed.

Equivalente aproximado: `/agora/presence`, `/agora/feed`, `/agora/inbox`, `/agora/tasks`.

### agora_send

Publica un mensaje en el feed y espejo Telegram cuando aplique.

Entrada:

- `from`;
- `text`;
- `kind`;
- `url`.

Equivalente: `POST /agora/feed`.

### agora_ping_agent

Encola una tarea para un agente/persona.

Entrada:

- `agent`: `neo | morfeo | trinity | oraculo | cypher`;
- `text`;
- `origin`.

Equivalente: `POST /agora/enqueue`.

### agora_read_queue

Lee inbox/tasks de una persona, con opcion de consumir.

Entrada:

- `agent`;
- `queue`: `inbox | tasks`;
- `consume`: boolean.

Equivalente: `GET /agora/inbox` y `GET /agora/tasks`.

### admira_live_status

Comprueba salud basica de plataformas:

- `www.admira.live`;
- worker `pixer-eleven`;
- Telegram bridge;
- KV/R2 si el worker expone healthcheck.

### admira_stock_search

Busca assets/contenidos de Stock/PixerIA cuando el worker ya pueda devolver indice.

Entrada:

- `query`;
- `type`;
- `limit`.

## Recursos MCP

### admira://agora/feed

Feed reciente de AgoraMatrix.

### admira://agora/agents

Mapa de personas, identidades y estado.

### admira://platforms

Inventario de plataformas Admira conectadas:

- `admira.live`;
- `admira.app`;
- `admira.studio`;
- `pixeria`;
- `xpaceos`;
- `pixer-worker`;
- Telegram/AgoraMatrix.

## Prompts MCP

### brief_agoramatrix

Genera un resumen operativo del grupo:

- que paso;
- quien esta activo;
- que esta bloqueado;
- siguiente accion recomendada.

### route_platform_request

Decide que plataforma o agente debe atender una peticion:

- web/publicacion;
- email/calendario;
- stock/assets;
- deploy;
- Telegram;
- investigacion.

## Seguridad

Reglas iniciales:

- Las herramientas de lectura pueden estar disponibles antes.
- Las herramientas de escritura requieren `AGORA_SYNC_KEY` o token dedicado.
- Ninguna herramienta debe devolver secretos.
- Las acciones destructivas quedan fuera del MVP.
- Toda escritura debe registrar `origin`, `from`, `ts` y resumen.
- Telegram no debe recibir salidas largas ni datos sensibles.

## Estructura Recomendada

Opcion local dentro del repo:

```text
mcp/
  package.json
  src/
    server.js
    admiraClient.js
    tools/
      agora.js
      health.js
      stock.js
```

Dependencia principal:

- `@modelcontextprotocol/sdk`

Transporte inicial:

- `stdio` para clientes locales.

Transporte posterior:

- HTTP Streamable si se publica remoto.

## Primer Sprint

1. Crear `mcp/` con servidor MCP local por `stdio`. Hecho.
2. Implementar `agora_status`, `agora_send`, `agora_read_queue`. Hecho.
3. Implementar `agora_ping_agent` con endpoint autenticado `/agora/enqueue`. Hecho y desplegado en `pixer-eleven`.
4. Leer `AGORA_SYNC_KEY` y `ADMIRA_WORKER_URL` desde variables de entorno. Hecho.
5. Probar desde un cliente MCP local. Hecho para discovery y health; pendiente prueba positiva de colas con `AGORA_SYNC_KEY` real en el cliente MCP.
6. Anadir README con configuracion para Codex/Claude/ChatGPT Desktop si aplica. Hecho.
7. Solo despues, valorar publicarlo como MCP remoto asociado a `www.admira.live`.

## Decision Recomendada

Empezar local, envolviendo AgoraMatrix. Cuando el set de herramientas sea estable y Carlos lo use desde Telegram/agentes durante unos dias, convertirlo en remoto.

Esto mantiene `www.admira.live` como marca y punto de entrada, pero evita exponer un MCP publico antes de tener permisos, auditoria y limites bien cerrados.
