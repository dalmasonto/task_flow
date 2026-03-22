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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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
