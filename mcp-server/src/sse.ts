import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { execFileSync } from 'child_process';
import { getDb } from './db.js';
import { logActivity } from './helpers.js';
import { getConfig } from './config.js';
import { validateKeys } from './tools/terminal.js';

const SERVICE_ID = 'taskflow-mcp';
const PROBE_TIMEOUT_MS = 2000;

// ─── Relay upstream config (from config file, env vars, or .env) ────
const { relayUrl: RELAY_URL, relayPushToken: RELAY_PUSH_TOKEN } = getConfig();

const clients = new Set<ServerResponse>();

// ─── Event buffer for Last-Event-ID replay ──────────────────────────
const EVENT_BUFFER_SIZE = 200;
let eventIdCounter = 0;
const eventBuffer: Array<{ id: number; event: string; data: string }> = [];

function bufferEvent(event: string, data: string): number {
  const id = ++eventIdCounter;
  eventBuffer.push({ id, event, data });
  if (eventBuffer.length > EVENT_BUFFER_SIZE) {
    eventBuffer.shift();
  }
  return id;
}

const cfg = getConfig();
const PREFERRED_PORT = cfg.port;
/** The port that is actually serving SSE — either ours or an existing instance's */
let activePort = PREFERRED_PORT;

/** Probe a port to check if a TaskFlow service is already running there */
async function probeTaskFlow(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.json() as { service?: string };
    return body.service === SERVICE_ID;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function jsonResponse(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

// ─── Terminal capture & prompt detection poller ─────────────────────

interface AgentRegistryRow {
  name: string;
  tmux_pane: string | null;
  status: string;
  pid: number;
}

/**
 * Detect an active Claude Code permission prompt.
 *
 * The definitive marker is "Esc to cancel" which only appears in the
 * footer of active prompts and disappears once the user responds.
 * We check only the last 10 lines of the VISIBLE screen (not full
 * scrollback) to avoid matching old, already-answered prompts.
 *
 * Generic patterns like "Do you want to" and "(y/n)" are intentionally
 * excluded — Claude writes these in prose responses too, causing false flags.
 */
function detectPrompt(content: string): { detected: boolean; hints: string[] } {
  // Only check last 10 lines — the prompt footer is always at the bottom
  const lines = content.split('\n');
  const tail = lines.slice(-10).join('\n');
  const hints: string[] = [];

  const hasEsc = /Esc to cancel/i.test(tail);
  const hasTab = /Tab to amend/i.test(tail);

  if (hasEsc) hints.push('Esc to cancel');
  if (hasTab) hints.push('Tab to amend');
  if (/shift\+tab/i.test(tail)) hints.push('Shift+Tab');

  // Only flag as detected if we see the actual prompt footer
  const detected = hasEsc || hasTab;
  return { detected, hints };
}

/** Fast string hash (djb2) for content change detection */
function hashContent(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Unified terminal poller — single capture per agent, broadcasts:
 * - terminal_capture: full pane content for UI rendering (only when changed)
 * - agent_awaiting_input / agent_input_resolved: prompt state transitions
 * - notification_created: when an agent first needs input
 */
function pollAgentTerminals(promptState: Map<string, boolean>, contentHashes: Map<string, number>): void {
  const db = getDb();
  const agents = db.prepare(
    "SELECT name, tmux_pane, status, pid FROM agent_registry WHERE status = 'connected' AND tmux_pane IS NOT NULL"
  ).all() as AgentRegistryRow[];

  for (const agent of agents) {
    try {
      const content = execFileSync(
        'tmux', ['capture-pane', '-p', '-S', '-', '-t', agent.tmux_pane!],
        { timeout: 5000 }
      ).toString();

      // Only broadcast if content actually changed
      const hash = hashContent(content);
      const prevHash = contentHashes.get(agent.name);
      if (hash !== prevHash) {
        contentHashes.set(agent.name, hash);
        broadcast('terminal_capture', {
          entity: 'terminal',
          action: 'terminal_capture',
          payload: { name: agent.name, pane: agent.tmux_pane, content },
        });
      }

      // Prompt detection with state transitions (always check, even if content unchanged hash-wise)
      const { detected, hints } = detectPrompt(content);
      const wasAwaiting = promptState.get(agent.name) ?? false;

      if (detected && !wasAwaiting) {
        promptState.set(agent.name, true);

        const ts = new Date().toISOString();
        const hintsText = hints.length > 0 ? ` (${hints.join(' · ')})` : '';
        db.prepare(
          'INSERT INTO notifications (title, message, type, created_at) VALUES (?, ?, ?, ?)'
        ).run(
          `Agent "${agent.name}" needs input`,
          `A permission prompt is waiting for your response${hintsText}`,
          'warning',
          ts
        );

        const notification = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 1').get();
        broadcast('notification_created', { entity: 'notification', action: 'notification_created', payload: notification });
        broadcast('agent_awaiting_input', { entity: 'agent', action: 'agent_awaiting_input', payload: { name: agent.name, hints, awaiting: true } });
      } else if (!detected && wasAwaiting) {
        promptState.set(agent.name, false);
        broadcast('agent_input_resolved', { entity: 'agent', action: 'agent_input_resolved', payload: { name: agent.name, awaiting: false } });
      }
    } catch {
      // tmux capture failed — agent pane may be gone
    }
  }

  // Clean up agents that disconnected
  for (const [name] of promptState) {
    if (!agents.some(a => a.name === name)) {
      promptState.delete(name);
      contentHashes.delete(name);
    }
  }
}

export async function startSSEServer(): Promise<void> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /healthz — identity probe so other instances can detect us
    if (req.url === '/healthz' && req.method === 'GET') {
      jsonResponse(res, 200, { service: SERVICE_ID, pid: process.pid });
      return;
    }

    if (req.url === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Send initial connection event
      res.write('event: connected\ndata: {}\n\n');

      // Replay missed events if client sends Last-Event-ID
      const lastEventId = req.headers['last-event-id'];
      if (lastEventId && typeof lastEventId === 'string') {
        const missed = eventBuffer.filter(e => e.id > Number(lastEventId));
        for (const e of missed) {
          res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${e.data}\n\n`);
        }
      }

      clients.add(res);

      req.on('close', () => {
        clients.delete(res);
      });
      return;
    }

    if (req.url === '/sync' && req.method === 'GET') {
      const db = getDb();
      const tasks = db.prepare('SELECT * FROM tasks').all();
      const projects = db.prepare('SELECT * FROM projects').all();
      const sessions = db.prepare('SELECT * FROM sessions').all();
      const settings = db.prepare('SELECT * FROM settings').all();
      const activityLogs = db.prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 200').all();
      const agentMessages = db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT 100').all();
      const agentRegistry = db.prepare('SELECT * FROM agent_registry ORDER BY connected_at DESC').all();

      jsonResponse(res, 200, { tasks, projects, sessions, settings, activityLogs, agentMessages, agentRegistry });
      return;
    }

    // ─── Mutation endpoints ───────────────────────────────────────────

    if (req.url === '/api/clear-data' && req.method === 'POST') {
      const db = getDb();
      db.exec('DELETE FROM sessions');
      db.exec('DELETE FROM tasks');
      db.exec('DELETE FROM projects');
      db.exec('DELETE FROM notifications');
      db.exec('DELETE FROM activity_logs');
      db.exec('DELETE FROM agent_messages');
      db.exec('DELETE FROM agent_registry');
      logActivity('data_cleared', 'All data cleared via UI', { entityType: 'system' });
      broadcast('data_cleared', { entity: 'system', action: 'data_cleared', payload: {} });
      jsonResponse(res, 200, { cleared: true });
      return;
    }

    // PATCH /api/tasks/:id — partial update
    const taskPatchMatch = req.url?.match(/^\/api\/tasks\/(\d+)$/);
    if (taskPatchMatch && req.method === 'PATCH') {
      const db = getDb();
      const id = Number(taskPatchMatch[1]);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!task) { jsonResponse(res, 404, { error: 'Task not found' }); return; }

      const body = JSON.parse(await readBody(req));
      const fieldMap: Record<string, string> = {
        title: 'title', description: 'description', status: 'status',
        priority: 'priority', projectId: 'project_id', dueDate: 'due_date',
        estimatedTime: 'estimated_time', dependencies: 'dependencies',
        tags: 'tags', links: 'links',
      };

      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [camel, col] of Object.entries(fieldMap)) {
        if (body[camel] !== undefined) {
          const val = body[camel];
          if (col === 'dependencies' || col === 'tags' || col === 'links') {
            sets.push(`${col} = ?`);
            vals.push(JSON.stringify(val));
          } else if (col === 'due_date' && val) {
            sets.push(`${col} = ?`);
            vals.push(new Date(val).toISOString());
          } else if (col === 'project_id' && (val === null || val === undefined)) {
            sets.push(`${col} = ?`);
            vals.push(null);
          } else {
            sets.push(`${col} = ?`);
            vals.push(val);
          }
        }
      }

      if (sets.length > 0) {
        sets.push('updated_at = ?');
        vals.push(new Date().toISOString());
        db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      }

      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      broadcast('task_updated', { entity: 'task', action: 'task_updated', payload: updated });
      jsonResponse(res, 200, updated);
      return;
    }

    // DELETE /api/tasks/:id
    const taskDeleteMatch = req.url?.match(/^\/api\/tasks\/(\d+)$/);
    if (taskDeleteMatch && req.method === 'DELETE') {
      const db = getDb();
      const id = Number(taskDeleteMatch[1]);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as { title: string } | undefined;
      if (!task) { jsonResponse(res, 404, { error: 'Task not found' }); return; }
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      logActivity('task_deleted', task.title, { entityType: 'task', entityId: id });
      broadcast('task_deleted', { entity: 'task', action: 'task_deleted', payload: { id } });
      jsonResponse(res, 200, { deleted: true, id });
      return;
    }

    // POST /api/tasks — create a task
    if (req.url === '/api/tasks' && req.method === 'POST') {
      const db = getDb();
      const body = JSON.parse(await readBody(req));
      const ts = new Date().toISOString();
      const result = db.prepare(
        `INSERT INTO tasks (title, description, status, priority, project_id, dependencies, links, tags, due_date, estimated_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        body.title, body.description ?? null, body.status ?? 'not_started',
        body.priority ?? 'medium', body.projectId ?? null,
        JSON.stringify(body.dependencies ?? []), JSON.stringify(body.links ?? []),
        JSON.stringify(body.tags ?? []), body.dueDate ? new Date(body.dueDate).toISOString() : null,
        body.estimatedTime ?? null, ts, ts,
      );
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
      logActivity('task_created', body.title, { entityType: 'task', entityId: result.lastInsertRowid as number });
      broadcast('task_created', { entity: 'task', action: 'task_created', payload: task });
      jsonResponse(res, 201, task);
      return;
    }

    // POST /api/sessions — create a timer session
    if (req.url === '/api/sessions' && req.method === 'POST') {
      const db = getDb();
      const body = JSON.parse(await readBody(req));
      const ts = new Date().toISOString();
      const result = db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        body.taskId, body.start ? new Date(body.start).toISOString() : ts, body.end ? new Date(body.end).toISOString() : null,
      );
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid);
      broadcast('timer_started', { entity: 'timer', action: 'timer_started', payload: { task_id: body.taskId, session } });
      jsonResponse(res, 201, session);
      return;
    }

    // PATCH /api/sessions/:id — update session (close it)
    const sessionPatchMatch = req.url?.match(/^\/api\/sessions\/(\d+)$/);
    if (sessionPatchMatch && req.method === 'PATCH') {
      const db = getDb();
      const id = Number(sessionPatchMatch[1]);
      const body = JSON.parse(await readBody(req));
      if (body.end) {
        db.prepare('UPDATE sessions SET end = ? WHERE id = ?').run(new Date(body.end).toISOString(), id);
      }
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      jsonResponse(res, 200, session);
      return;
    }

    // PATCH /api/projects/:id — partial update
    const projectPatchMatch = req.url?.match(/^\/api\/projects\/(\d+)$/);
    if (projectPatchMatch && req.method === 'PATCH') {
      const db = getDb();
      const id = Number(projectPatchMatch[1]);
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      if (!project) { jsonResponse(res, 404, { error: 'Project not found' }); return; }

      const body = JSON.parse(await readBody(req));
      const fieldMap: Record<string, string> = {
        name: 'name', color: 'color', type: 'type', description: 'description',
      };

      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [camel, col] of Object.entries(fieldMap)) {
        if (body[camel] !== undefined) {
          sets.push(`${col} = ?`);
          vals.push(body[camel]);
        }
      }

      if (sets.length > 0) {
        sets.push('updated_at = ?');
        vals.push(new Date().toISOString());
        db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      }

      const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      broadcast('project_updated', { entity: 'project', action: 'project_updated', payload: updated });
      jsonResponse(res, 200, updated);
      return;
    }

    // DELETE /api/projects/:id
    const projectDeleteMatch = req.url?.match(/^\/api\/projects\/(\d+)$/);
    if (projectDeleteMatch && req.method === 'DELETE') {
      const db = getDb();
      const id = Number(projectDeleteMatch[1]);
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as { name: string } | undefined;
      if (!project) { jsonResponse(res, 404, { error: 'Project not found' }); return; }
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      logActivity('project_deleted', project.name, { entityType: 'project', entityId: id });
      broadcast('project_deleted', { entity: 'project', action: 'project_deleted', payload: { id } });
      jsonResponse(res, 200, { deleted: true, id });
      return;
    }

    // POST /api/broadcast — relay SSE events from other processes (e.g. MCP)
    if (req.url === '/api/broadcast' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (body.event && body.data) {
        broadcastLocal(body.event, body.data);
      }
      jsonResponse(res, 200, { relayed: true });
      return;
    }

    // POST /api/agent-messages/:id/respond — user responds to an agent question
    const agentRespondMatch = req.url?.match(/^\/api\/agent-messages\/(\d+)\/respond$/);
    if (agentRespondMatch && req.method === 'POST') {
      const db = getDb();
      const id = Number(agentRespondMatch[1]);

      const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!message) {
        jsonResponse(res, 404, { error: 'Message not found' });
        return;
      }
      if (message.status === 'answered') {
        jsonResponse(res, 400, { error: 'Already answered' });
        return;
      }

      const body = JSON.parse(await readBody(req));
      const response = body.response as string;
      if (!response) {
        jsonResponse(res, 400, { error: 'Response is required' });
        return;
      }

      const ts = new Date().toISOString();
      db.prepare('UPDATE agent_messages SET response = ?, status = ?, answered_at = ?, delivered = NULL WHERE id = ?')
        .run(response, 'answered', ts, id);

      const updated = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
      broadcast('agent_question_answered', { entity: 'agent_message', action: 'agent_question_answered', payload: updated });
      logActivity('agent_question_answered', `Responded to: ${message.question}`, { entityType: 'agent_message', entityId: id });

      jsonResponse(res, 200, updated);
      return;
    }

    // POST /api/agent-messages/:id/dismiss — dismiss without responding (answered in terminal)
    const agentDismissMatch = req.url?.match(/^\/api\/agent-messages\/(\d+)\/dismiss$/);
    if (agentDismissMatch && req.method === 'POST') {
      const db = getDb();
      const id = Number(agentDismissMatch[1]);

      const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!message) {
        jsonResponse(res, 404, { error: 'Message not found' });
        return;
      }
      if (message.status !== 'pending') {
        jsonResponse(res, 400, { error: 'Message is not pending' });
        return;
      }

      const ts = new Date().toISOString();
      db.prepare('UPDATE agent_messages SET status = ?, answered_at = ? WHERE id = ?')
        .run('dismissed', ts, id);

      const updated = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
      broadcast('agent_question_answered', { entity: 'agent_message', action: 'agent_question_answered', payload: updated });

      jsonResponse(res, 200, updated);
      return;
    }

    // POST /api/agent-messages/send — send a message (from user UI or capture system)
    if (req.url === '/api/agent-messages/send' && req.method === 'POST') {
      const db = getDb();
      const body = JSON.parse(await readBody(req));
      const { recipient, message: msgText, projectId, source: msgSource, senderName } = body as {
        recipient: string; message: string; projectId?: number; source?: string; senderName?: string
      };

      if (!recipient || !msgText) {
        jsonResponse(res, 400, { error: 'recipient and message are required' });
        return;
      }

      const source = msgSource || 'ui';
      const sender = senderName || 'user';
      const ts = new Date().toISOString();
      const result = db.prepare(
        `INSERT INTO agent_messages (project_id, question, sender_name, recipient_name, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      ).run(projectId ?? null, msgText, sender, recipient, source, ts);

      const id = (result as { lastInsertRowid: number }).lastInsertRowid;
      const msg = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
      broadcast('agent_question', { entity: 'agent_message', action: 'agent_question', payload: msg });

      jsonResponse(res, 200, msg);
      return;
    }

    // GET /api/terminal/:agentName/capture — capture terminal content via tmux
    const captureMatch = req.url?.match(/^\/api\/terminal\/([^/]+)\/capture$/);
    if (captureMatch && req.method === 'GET') {
      const agentName = decodeURIComponent(captureMatch[1]);
      const db = getDb();
      const agent = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(agentName) as { tmux_pane: string | null; status: string } | undefined;

      if (!agent) { jsonResponse(res, 404, { error: `Agent "${agentName}" not found` }); return; }
      if (!agent.tmux_pane) { jsonResponse(res, 400, { error: `Agent "${agentName}" has no tmux pane` }); return; }

      try {
        const output = execFileSync('tmux', ['capture-pane', '-p', '-S', '-', '-t', agent.tmux_pane], { timeout: 5000 }).toString();
        jsonResponse(res, 200, { agent: agentName, pane: agent.tmux_pane, content: output });
      } catch (err: any) {
        jsonResponse(res, 500, { error: `Failed to capture pane: ${err.message}` });
      }
      return;
    }

    // POST /api/terminal/:agentName/send-keys — inject raw keystrokes into agent's tmux pane
    const sendKeysMatch = req.url?.match(/^\/api\/terminal\/([^/]+)\/send-keys$/);
    if (sendKeysMatch && req.method === 'POST') {
      const agentName = decodeURIComponent(sendKeysMatch[1]);
      const db = getDb();
      const agent = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(agentName) as { tmux_pane: string | null; status: string } | undefined;

      if (!agent) { jsonResponse(res, 404, { error: `Agent "${agentName}" not found` }); return; }
      if (!agent.tmux_pane) { jsonResponse(res, 400, { error: `Agent "${agentName}" has no tmux pane` }); return; }
      if (agent.status !== 'connected') { jsonResponse(res, 403, { error: `Agent "${agentName}" is disconnected — sending keys to a bare shell is blocked for security` }); return; }

      let body: any;
      try { body = JSON.parse(await readBody(req)); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
      const keys = body.keys;
      const enter = body.enter !== false; // default: send Enter after keys
      const literal = body.literal !== false; // default: send as literal text

      if (typeof keys !== 'string') { jsonResponse(res, 400, { error: 'keys must be a string' }); return; }

      // Block shell escape patterns and oversized payloads
      const violation = validateKeys(keys);
      if (violation) { jsonResponse(res, 403, { error: violation }); return; }

      try {
        const pane = agent.tmux_pane!;
        if (literal) {
          execFileSync('tmux', ['send-keys', '-t', pane, '-l', keys], { stdio: 'ignore', timeout: 5000 });
          if (enter) execFileSync('tmux', ['send-keys', '-t', pane, 'Enter'], { stdio: 'ignore', timeout: 5000 });
        } else {
          const args = ['send-keys', '-t', pane, keys];
          if (enter) args.push('Enter');
          execFileSync('tmux', args, { stdio: 'ignore', timeout: 5000 });
        }
        logActivity('terminal_send_keys', `Sent keys to ${agentName}: ${keys.slice(0, 50)}`, { entityType: 'agent' });
        jsonResponse(res, 200, { agent: agentName, pane: agent.tmux_pane, keys, enter, literal, sent: true });
      } catch (err: any) {
        jsonResponse(res, 500, { error: `Failed to send keys: ${err.message}` });
      }
      return;
    }

    // GET /api/terminal/agents — list agents with tmux panes for terminal interaction
    if (req.url === '/api/terminal/agents' && req.method === 'GET') {
      const db = getDb();
      const agents = db.prepare("SELECT name, tmux_pane, status, pid FROM agent_registry WHERE tmux_pane IS NOT NULL ORDER BY connected_at DESC").all();
      jsonResponse(res, 200, agents);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // Try ports sequentially: probe occupied ports to see if they're ours
  await new Promise<void>((resolve) => {
    let attempt = 0;

    function tryPort(port: number) {
      if (attempt >= cfg.maxPortAttempts) {
        console.error(`[SSE] failed to bind after ${cfg.maxPortAttempts} attempts (ports ${PREFERRED_PORT}–${port - 1})`);
        resolve();
        return;
      }

      server.once('error', async (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          const isTaskFlow = await probeTaskFlow(port);
          if (isTaskFlow) {
            // Another TaskFlow instance owns this port — connect to it instead
            activePort = port;
            console.log(`[SSE] port ${port} owned by another TaskFlow instance (pid probe) — using it`);
            resolve();
          } else {
            // Not ours — try next port
            console.log(`[SSE] port ${port} in use by non-TaskFlow service — trying ${port + 1}`);
            attempt++;
            tryPort(port + 1);
          }
        } else {
          console.error('[SSE] unexpected server error:', err.message);
          resolve();
        }
      });

      server.listen(port, cfg.host, () => {
        activePort = port;
        markSSEActive();

        // Heartbeat — keeps connections alive and detects stale clients
        setInterval(() => {
          const ping = `:ping ${Date.now()}\n\n`;
          for (const client of clients) {
            try { client.write(ping); } catch { clients.delete(client); }
          }
        }, 30_000);

        // Terminal capture & prompt detection — single capture loop for all agents
        const promptState = new Map<string, boolean>();
        const contentHashes = new Map<string, number>();
        setInterval(() => {
          try { pollAgentTerminals(promptState, contentHashes); } catch { /* ignore */ }
        }, 3_000);

        if (port !== PREFERRED_PORT) {
          console.log(`[SSE] listening on fallback port ${port} (preferred ${PREFERRED_PORT} was unavailable)`);
        } else {
          console.log(`[SSE] listening on port ${port}`);
        }

        // Register with remote relay so it knows where to proxy commands
        if (RELAY_URL && RELAY_PUSH_TOKEN) {
          const localUrl = `http://${cfg.host}:${port}`;
          fetch(`${RELAY_URL}/register`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${RELAY_PUSH_TOKEN}`,
            },
            body: JSON.stringify({ url: localUrl }),
          }).then(async (res) => {
            if (res.ok) {
              console.log(`[SSE] registered with relay at ${RELAY_URL}`);
            } else {
              const body = await res.text().catch(() => '');
              console.error(`[SSE] relay registration rejected: ${res.status} ${body}`);
            }
          }).catch((err) => {
            console.error(`[SSE] relay registration failed: ${err.message}`);
          });
        }

        resolve();
      });
    }

    tryPort(PREFERRED_PORT);
  });
}

/** Broadcast directly to connected SSE clients in this process */
function broadcastLocal(event: string, data: object): void {
  const dataStr = JSON.stringify(data);
  const id = bufferEvent(event, dataStr);
  const message = `id: ${id}\nevent: ${event}\ndata: ${dataStr}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

/** Track whether this process owns the SSE server */
let sseServerActive = false;

export function markSSEActive(): void {
  sseServerActive = true;
}

/**
 * Broadcast an SSE event. If this process owns the SSE server, send directly.
 * Otherwise, relay via HTTP to the process that does.
 * Also pushes to the remote relay server if configured.
 */
export function broadcast(event: string, data: object): void {
  if (sseServerActive && clients.size > 0) {
    broadcastLocal(event, data);
  } else {
    // Relay to the SSE server owner via HTTP
    const body = JSON.stringify({ event, data });
    fetch(`http://localhost:${activePort}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch((err) => {
      console.error(`[SSE] broadcast relay to port ${activePort} failed: ${err.message}`);
    });
  }

  // Push to remote relay server (fire-and-forget)
  if (RELAY_URL && RELAY_PUSH_TOKEN) {
    fetch(`${RELAY_URL}/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_PUSH_TOKEN}`,
      },
      body: JSON.stringify({ event, data }),
    }).catch(() => {}); // silent — relay may be down
  }
}

/** Returns the port the SSE server is actively using */
export function getActivePort(): number {
  return activePort;
}
