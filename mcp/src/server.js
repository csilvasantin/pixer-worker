#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const DEFAULT_WORKER_URL = 'https://pixer-eleven.csilvasantin.workers.dev';
const AGENTS = {
  neo: 'Claude·admira',
  morfeo: 'Claude·gmail',
  trinity: 'Codex·admira',
  oraculo: 'Codex·gmail',
  cypher: 'OpenCode·grok',
};

function workerUrl() {
  return String(process.env.ADMIRA_WORKER_URL || DEFAULT_WORKER_URL).replace(/\/+$/, '');
}

function syncKey() {
  return process.env.AGORA_SYNC_KEY || process.env.GRID_KEY || '';
}

function requireSyncKey() {
  const key = syncKey();
  if (!key) {
    throw new Error('Missing AGORA_SYNC_KEY. Set it in the MCP client env.');
  }
  return key;
}

function asText(data) {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function fetchJson(path, options = {}) {
  const url = `${workerUrl()}${path}`;
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const detail = body && (body.error || body.detail || body.raw) || response.statusText;
    throw new Error(`${response.status} ${response.statusText}: ${detail}`);
  }
  return body;
}

function authedQuery(params = {}) {
  const search = new URLSearchParams({ key: requireSyncKey() });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  return search.toString();
}

async function getPresence() {
  return fetchJson(`/agora/presence?${authedQuery()}`);
}

async function getFeed(limit = 10) {
  return fetchJson(`/agora/feed?${authedQuery({ limit })}`);
}

async function getQueue(agent, queue, consume = false) {
  const identity = AGENTS[agent] || agent;
  return fetchJson(`/agora/${queue}?${authedQuery({ id: identity, consume: consume ? '1' : '' })}`);
}

async function summarizeStatus(limit = 8) {
  const [health, presence, feed] = await Promise.all([
    fetchJson('/healthz').catch(error => ({ ok: false, error: String(error.message || error) })),
    getPresence(),
    getFeed(limit),
  ]);
  return { worker: workerUrl(), health, presence, feed };
}

const server = new McpServer({
  name: 'admira-live-mcp',
  version: '0.1.0',
  websiteUrl: 'https://www.admira.live',
});

server.registerTool('admira_live_status', {
  title: 'Admira Live Status',
  description: 'Check pixer-worker health and the configured Admira Live MCP backend.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
}, async () => {
  const health = await fetchJson('/healthz');
  return asText({
    worker: workerUrl(),
    admiraLive: 'https://www.admira.live',
    health,
  });
});

server.registerTool('agora_status', {
  title: 'AgoraMatrix Status',
  description: 'Read AgoraMatrix presence and recent shared feed.',
  inputSchema: {
    feedLimit: z.number().int().min(1).max(50).default(10).describe('Number of recent feed items to include.'),
  },
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
}, async ({ feedLimit }) => {
  return asText(await summarizeStatus(feedLimit));
});

server.registerTool('agora_send', {
  title: 'Send AgoraMatrix Message',
  description: 'Publish a short message to AgoraMatrix feed. The worker may mirror it to Telegram.',
  inputSchema: {
    from: z.string().min(1).max(80).default('Admira Live MCP').describe('Sender name shown in AgoraMatrix.'),
    text: z.string().min(1).max(2000).describe('Message body. Do not include secrets.'),
    kind: z.string().min(1).max(40).default('mcp').describe('Message kind for audit.'),
    url: z.string().url().optional().describe('Optional public URL attached to the message.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
}, async ({ from, text, kind, url }) => {
  const body = { key: requireSyncKey(), from, text, kind, url };
  const result = await fetchJson('/agora/feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return asText(result);
});

server.registerTool('agora_read_queue', {
  title: 'Read AgoraMatrix Queue',
  description: 'Read inbox or tasks for an AgoraMatrix agent.',
  inputSchema: {
    agent: z.enum(['neo', 'morfeo', 'trinity', 'oraculo', 'cypher']).describe('Agent/persona to read.'),
    queue: z.enum(['inbox', 'tasks']).default('tasks').describe('Queue to read.'),
    consume: z.boolean().default(false).describe('If true, clear the queue after reading.'),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
}, async ({ agent, queue, consume }) => {
  return asText(await getQueue(agent, queue, consume));
});

server.registerTool('agora_ping_agent', {
  title: 'Ping AgoraMatrix Agent',
  description: 'Queue a task for Neo, Morfeo, Trinity, Oraculo or Cypher via authenticated /agora/enqueue.',
  inputSchema: {
    agent: z.enum(['neo', 'morfeo', 'trinity', 'oraculo', 'cypher']).describe('Agent/persona to notify.'),
    text: z.string().min(1).max(1000).describe('Concrete task or question for the agent.'),
    origin: z.string().min(1).max(120).default('Admira Live MCP').describe('Origin recorded in the queue.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
}, async ({ agent, text, origin }) => {
  const result = await fetchJson('/agora/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: requireSyncKey(),
      agent,
      text,
      origin,
      command: '/mcp',
    }),
  });
  return asText(result);
});

server.registerResource('admira-platforms', 'admira://platforms', {
  title: 'Admira Platforms',
  description: 'Connected Admira surfaces and platform roles.',
  mimeType: 'application/json',
}, async () => {
  return {
    contents: [
      {
        uri: 'admira://platforms',
        mimeType: 'application/json',
        text: JSON.stringify({
          publicHub: 'https://www.admira.live',
          worker: workerUrl(),
          platforms: [
            { id: 'agoramatrix', role: 'Telegram and multi-agent operations' },
            { id: 'pixer-worker', role: 'Cloudflare backend for Agora, Stock, Signage and media' },
            { id: 'pixeria', role: 'Asset and furniture creation' },
            { id: 'xpaceos', role: 'Digital twin and signage surface' },
            { id: 'admira-studio', role: 'Production and creative tools' },
            { id: 'admira-app', role: 'Business/product app surface' },
          ],
        }, null, 2),
      },
    ],
  };
});

server.registerResource('agora-agents', 'admira://agora/agents', {
  title: 'AgoraMatrix Agents',
  description: 'Known AgoraMatrix agents and MCP aliases.',
  mimeType: 'application/json',
}, async () => {
  return {
    contents: [
      {
        uri: 'admira://agora/agents',
        mimeType: 'application/json',
        text: JSON.stringify(AGENTS, null, 2),
      },
    ],
  };
});

server.registerResource('agora-feed', 'admira://agora/feed', {
  title: 'AgoraMatrix Feed',
  description: 'Recent AgoraMatrix feed, requires AGORA_SYNC_KEY.',
  mimeType: 'application/json',
}, async () => {
  return {
    contents: [
      {
        uri: 'admira://agora/feed',
        mimeType: 'application/json',
        text: JSON.stringify(await getFeed(20), null, 2),
      },
    ],
  };
});

server.registerPrompt('brief_agoramatrix', {
  title: 'Brief AgoraMatrix',
  description: 'Create a concise operational brief from AgoraMatrix status.',
  argsSchema: {
    focus: z.string().optional().describe('Optional topic or agent to focus on.'),
  },
}, async ({ focus }) => ({
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: [
          'Use the admira-live MCP tools to prepare an AgoraMatrix brief.',
          'Include active agents, pending queues, recent feed, blockers and recommended next action.',
          focus ? `Focus: ${focus}` : '',
        ].filter(Boolean).join('\n'),
      },
    },
  ],
}));

server.registerPrompt('route_platform_request', {
  title: 'Route Platform Request',
  description: 'Decide which Admira platform or agent should handle a request.',
  argsSchema: {
    request: z.string().describe('User request to route.'),
  },
}, async ({ request }) => ({
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: [
          'Route this Admira request to the best platform or AgoraMatrix agent.',
          'Return the destination, reason, needed tool, risk level and next action.',
          '',
          request,
        ].join('\n'),
      },
    },
  ],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
