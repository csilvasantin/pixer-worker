# Admira Live MCP

Servidor MCP local para exponer capacidades de `www.admira.live`, AgoraMatrix y `pixer-worker` a clientes compatibles con MCP.

## Estado

MVP local por `stdio`.

Herramientas incluidas:

- `admira_live_status`
- `agora_status`
- `agora_send`
- `agora_read_queue`
- `agora_ping_agent`

Recursos incluidos:

- `admira://platforms`
- `admira://agora/agents`
- `admira://agora/feed`

Prompts incluidos:

- `brief_agoramatrix`
- `route_platform_request`

## Instalacion

```bash
cd /Users/csilvasantin/Documents/Admirito/github-csilvasantin/pixer-worker/mcp
npm install
```

## Variables

```bash
export ADMIRA_WORKER_URL="https://pixer-eleven.csilvasantin.workers.dev"
export AGORA_SYNC_KEY="<valor de la sync key>"
```

`AGORA_SYNC_KEY` es obligatoria para herramientas que leen o escriben AgoraMatrix.

## Ejecucion

```bash
npm start
```

## Configuracion MCP local

Ejemplo generico de cliente MCP:

```json
{
  "mcpServers": {
    "admira-live": {
      "command": "node",
      "args": [
        "/Users/csilvasantin/Documents/Admirito/github-csilvasantin/pixer-worker/mcp/src/server.js"
      ],
      "env": {
        "ADMIRA_WORKER_URL": "https://pixer-eleven.csilvasantin.workers.dev",
        "AGORA_SYNC_KEY": "<valor de la sync key>"
      }
    }
  }
}
```

## Seguridad

- No pongas secretos en Git.
- Usa variables de entorno del cliente MCP.
- Las herramientas de escritura registran origen como `Admira Live MCP` salvo que se indique otro.
- El MCP local no expone HTTP; el cliente lo lanza como proceso hijo por `stdio`.

## Siguiente fase

Cuando el set de herramientas sea estable, publicar una version remota en `https://www.admira.live/mcp` con transporte HTTP Streamable, auth dedicada, rate limits y auditoria.
