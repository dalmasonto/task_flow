#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from 'http';

// ─── Config ─────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 4000;
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

if (!PUSH_TOKEN || !ACCESS_TOKEN) {
  console.error('[relay] PUSH_TOKEN and ACCESS_TOKEN env vars are required');
  process.exit(1);
}

// The local MCP server URL — set by the local MCP when it registers
let upstreamUrl: string | null = process.env.UPSTREAM_URL || null;

// ─── SSE Client Management ──────────────────────────────────────────

const clients = new Set<ServerResponse>();

function broadcastToClients(event: string, data: string): void {
  const message = `event: ${event}\ndata: ${data}\n\n`;
  for (const client of clients) {
    try { client.write(message); } catch { clients.delete(client); }
  }
}

// ─── State Buffer (latest per key) ──────────────────────────────────

// Buffer latest terminal content and agent states so new clients get
// current state immediately on connect
const terminalContent = new Map<string, string>(); // agent name → content JSON
const latestEvents = new Map<string, string>();     // event type → last data

// ─── Auth Helpers ───────────────────────────────────────────────────

function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

function checkPushAuth(req: IncomingMessage): boolean {
  return extractToken(req) === PUSH_TOKEN;
}

function checkAccessAuth(req: IncomingMessage): boolean {
  // Check header first, then query param (EventSource can't send headers)
  if (extractToken(req) === ACCESS_TOKEN) return true;
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return urlObj.searchParams.get('token') === ACCESS_TOKEN;
}

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

// ─── HTTP Server ────────────────────────────────────────────────────

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url || '/';

  // ─── Health check (no auth) ─────────────────────────────────────
  if (url === '/health' && req.method === 'GET') {
    json(res, 200, {
      status: 'ok',
      upstream: upstreamUrl ? 'connected' : 'waiting',
      clients: clients.size,
      bufferedTerminals: terminalContent.size,
    });
    return;
  }

  // ─── Push endpoint (local MCP → relay) ──────────────────────────
  if (url === '/push' && req.method === 'POST') {
    if (!checkPushAuth(req)) { json(res, 401, { error: 'Invalid push token' }); return; }

    const body = await readBody(req);
    try {
      const { event, data } = JSON.parse(body);
      if (!event || !data) { json(res, 400, { error: 'Missing event or data' }); return; }

      const dataStr = typeof data === 'string' ? data : JSON.stringify(data);

      // Buffer state
      if (event === 'terminal_capture') {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (parsed.payload?.name) {
          terminalContent.set(parsed.payload.name, dataStr);
        }
      }
      latestEvents.set(event, dataStr);

      // Forward to all connected remote clients
      broadcastToClients(event, dataStr);

      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
    }
    return;
  }

  // ─── Register upstream URL (local MCP tells relay where it is) ──
  if (url === '/register' && req.method === 'POST') {
    if (!checkPushAuth(req)) { json(res, 401, { error: 'Invalid push token' }); return; }

    const body = await readBody(req);
    try {
      const { url: upstream } = JSON.parse(body);
      if (!upstream) { json(res, 400, { error: 'Missing url' }); return; }
      upstreamUrl = upstream;
      console.log(`[relay] upstream registered: ${upstreamUrl}`);
      json(res, 200, { ok: true, upstream: upstreamUrl });
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
    }
    return;
  }

  // ─── SSE stream (remote app ← relay) ───────────────────────────
  if (url === '/stream' && req.method === 'GET') {
    if (!checkAccessAuth(req)) { json(res, 401, { error: 'Invalid access token' }); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    res.write(`event: connected\ndata: ${JSON.stringify({ relay: true, upstream: !!upstreamUrl })}\n\n`);

    // Send buffered terminal content so client gets current state
    for (const [, data] of terminalContent) {
      res.write(`event: terminal_capture\ndata: ${data}\n\n`);
    }

    clients.add(res);
    req.on('close', () => { clients.delete(res); });
    return;
  }

  // ─── Proxy: forward API calls to local MCP ─────────────────────
  // /proxy/* → upstream/*
  if (url.startsWith('/proxy/') && req.method) {
    if (!checkAccessAuth(req)) { json(res, 401, { error: 'Invalid access token' }); return; }
    if (!upstreamUrl) { json(res, 502, { error: 'No upstream registered' }); return; }

    const targetPath = url.slice(6); // strip /proxy
    const targetUrl = `${upstreamUrl}${targetPath}`;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const fetchOpts: RequestInit = { method: req.method, headers };

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fetchOpts.body = await readBody(req);
      }

      const upstream = await fetch(targetUrl, fetchOpts);
      const responseBody = await upstream.text();

      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      res.end(responseBody);
    } catch (err: any) {
      json(res, 502, { error: `Upstream error: ${err.message}` });
    }
    return;
  }

  // ─── 404 ────────────────────────────────────────────────────────
  json(res, 404, { error: 'Not found' });
});

// ─── Heartbeat ──────────────────────────────────────────────────────

setInterval(() => {
  const ping = `:ping ${Date.now()}\n\n`;
  for (const client of clients) {
    try { client.write(ping); } catch { clients.delete(client); }
  }
}, 30_000);

// ─── Start ──────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[relay] listening on port ${PORT}`);
  console.log(`[relay] push token: ${PUSH_TOKEN.slice(0, 4)}...`);
  console.log(`[relay] access token: ${ACCESS_TOKEN.slice(0, 4)}...`);
  if (upstreamUrl) console.log(`[relay] upstream: ${upstreamUrl}`);
});
