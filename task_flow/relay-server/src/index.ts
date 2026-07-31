#!/usr/bin/env node

import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';

// ─── Config ─────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 4000;
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

if (!PUSH_TOKEN || !ACCESS_TOKEN) {
  console.error('[relay] PUSH_TOKEN and ACCESS_TOKEN env vars are required');
  process.exit(1);
}

// ─── SSE Client Management ──────────────────────────────────────────

const clients = new Set<ServerResponse>();

function broadcastToClients(event: string, data: string): void {
  const message = `event: ${event}\ndata: ${data}\n\n`;
  for (const client of clients) {
    try { client.write(message); } catch { clients.delete(client); }
  }
}

// ─── State Buffer ───────────────────────────────────────────────────

const terminalContent = new Map<string, string>();
const latestEvents = new Map<string, string>();
let stateSnapshot: string | null = null; // full sync snapshot from local MCP

// ─── Command Queue ──────────────────────────────────────────────────
// Remote app posts commands, local MCP polls and executes them.
// All connections are outbound from the local machine — no tunnels needed.

interface QueuedCommand {
  id: number;
  type: string;         // 'send-keys' | 'respond-message' | 'dismiss-message' | 'send-to-agent'
  payload: unknown;
  status: 'pending' | 'done' | 'error';
  result?: unknown;
  createdAt: string;
}

let commandIdCounter = 0;
const commandQueue: QueuedCommand[] = [];
const MAX_QUEUE_SIZE = 200;

function pruneQueue(): void {
  // Keep only last MAX_QUEUE_SIZE commands
  if (commandQueue.length > MAX_QUEUE_SIZE) {
    commandQueue.splice(0, commandQueue.length - MAX_QUEUE_SIZE);
  }
}

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
  if (extractToken(req) === ACCESS_TOKEN) return true;
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return u.searchParams.get('token') === ACCESS_TOKEN;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const fullUrl = req.url || '/';
  const urlObj = new URL(fullUrl, `http://${req.headers.host || 'localhost'}`);
  const url = urlObj.pathname;

  // ─── Health check (no auth) ─────────────────────────────────────
  if (url === '/health' && req.method === 'GET') {
    json(res, 200, {
      status: 'ok',
      clients: clients.size,
      pendingCommands: commandQueue.filter(c => c.status === 'pending').length,
      bufferedTerminals: terminalContent.size,
      hasState: !!stateSnapshot,
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PUSH TOKEN endpoints (local MCP → relay)
  // ═══════════════════════════════════════════════════════════════════

  // ─── Push SSE event ─────────────────────────────────────────────
  if (url === '/push' && req.method === 'POST') {
    if (!checkPushAuth(req)) { json(res, 401, { error: 'Invalid push token' }); return; }

    const body = await readBody(req);
    try {
      const { event, data } = JSON.parse(body);
      if (!event || !data) { json(res, 400, { error: 'Missing event or data' }); return; }

      const dataStr = typeof data === 'string' ? data : JSON.stringify(data);

      if (event === 'terminal_capture') {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (parsed.payload?.name) {
          terminalContent.set(parsed.payload.name, dataStr);
        }
      }
      latestEvents.set(event, dataStr);
      broadcastToClients(event, dataStr);

      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
    }
    return;
  }

  // ─── Push state snapshot (replaces /sync proxy) ─────────────────
  if (url === '/push/state' && req.method === 'POST') {
    if (!checkPushAuth(req)) { json(res, 401, { error: 'Invalid push token' }); return; }

    stateSnapshot = await readBody(req);
    console.log(`[relay] state snapshot received (${(stateSnapshot.length / 1024).toFixed(1)}KB)`);
    json(res, 200, { ok: true });
    return;
  }

  // ─── Poll pending commands (local MCP picks up work) ────────────
  if (url === '/commands/pending' && req.method === 'GET') {
    if (!checkPushAuth(req)) { json(res, 401, { error: 'Invalid push token' }); return; }

    const pending = commandQueue.filter(c => c.status === 'pending');
    json(res, 200, pending);
    return;
  }

  // ─── Acknowledge command execution ──────────────────────────────
  const ackMatch = url.match(/^\/commands\/(\d+)\/done$/);
  if (ackMatch && req.method === 'POST') {
    if (!checkPushAuth(req)) { json(res, 401, { error: 'Invalid push token' }); return; }

    const id = Number(ackMatch[1]);
    const cmd = commandQueue.find(c => c.id === id);
    if (!cmd) { json(res, 404, { error: 'Command not found' }); return; }

    const body = await readBody(req);
    try {
      const { status, result } = JSON.parse(body);
      cmd.status = status === 'error' ? 'error' : 'done';
      cmd.result = result;
    } catch {
      cmd.status = 'done';
    }

    // Broadcast command result to remote clients
    broadcastToClients('command_result', JSON.stringify({
      entity: 'command', action: 'command_result',
      payload: { id: cmd.id, type: cmd.type, status: cmd.status, result: cmd.result },
    }));

    json(res, 200, { ok: true });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // ACCESS TOKEN endpoints (remote app → relay)
  // ═══════════════════════════════════════════════════════════════════

  // ─── SSE stream ─────────────────────────────────────────────────
  if (url === '/stream' && req.method === 'GET') {
    if (!checkAccessAuth(req)) { json(res, 401, { error: 'Invalid access token' }); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    res.write(`event: connected\ndata: ${JSON.stringify({ relay: true })}\n\n`);

    for (const [, data] of terminalContent) {
      res.write(`event: terminal_capture\ndata: ${data}\n\n`);
    }

    clients.add(res);
    req.on('close', () => { clients.delete(res); });
    return;
  }

  // ─── Get state snapshot (replaces /proxy/sync) ──────────────────
  if (url === '/state' && req.method === 'GET') {
    if (!checkAccessAuth(req)) { json(res, 401, { error: 'Invalid access token' }); return; }

    if (!stateSnapshot) {
      json(res, 503, { error: 'No state available yet — local server has not pushed' });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(stateSnapshot);
    return;
  }

  // ─── Submit command (remote app queues work for local MCP) ──────
  if (url === '/command' && req.method === 'POST') {
    if (!checkAccessAuth(req)) { json(res, 401, { error: 'Invalid access token' }); return; }

    const body = await readBody(req);
    try {
      const { type, payload } = JSON.parse(body);
      if (!type) { json(res, 400, { error: 'Missing command type' }); return; }

      const cmd: QueuedCommand = {
        id: ++commandIdCounter,
        type,
        payload,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      commandQueue.push(cmd);
      pruneQueue();

      json(res, 200, { id: cmd.id, status: 'pending' });
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
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
});
