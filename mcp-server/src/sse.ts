import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { getDb } from './db.js';
import { logActivity } from './helpers.js';

const clients = new Set<ServerResponse>();
const PORT = parseInt(process.env.TASKFLOW_SSE_PORT || '3456', 10);

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

export function startSSEServer(): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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

      jsonResponse(res, 200, { tasks, projects, sessions, settings, activityLogs });
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
      logActivity('data_cleared', 'All data cleared via UI', { entityType: 'system' });
      broadcast('data_cleared', { entity: 'system', action: 'data_cleared', payload: {} });
      jsonResponse(res, 200, { cleared: true });
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

    res.writeHead(404);
    res.end('Not Found');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Another MCP instance already owns this port — skip SSE, MCP tools still work
      return;
    }
    // Unexpected error — still don't crash the MCP process
  });

  server.listen(PORT, () => {
    // Server started silently — don't write to stdout (MCP uses stdio)
  });
}

export function broadcast(event: string, data: object): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}
