import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from './db.js';

interface ProjectRow {
  id: number
  name: string
  description: string | null
  color: string
  type: string
  created_at: string
  updated_at: string
}

interface TaskRow {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  project_id: number | null
  tags: string | null
  due_date: string | null
  created_at: string
  updated_at: string
}

export function registerResources(server: McpServer) {
  // ─── Projects Resource ──────────────────────────────────────────────

  server.resource(
    'projects',
    new ResourceTemplate('taskflow://projects/{id}', {
      list: async () => {
        const db = getDb();
        const projects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
        return {
          resources: projects.map(p => ({
            uri: `taskflow://projects/${p.id}`,
            name: p.name,
            description: p.description ?? undefined,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    { description: 'TaskFlow projects', mimeType: 'application/json' },
    async (uri, variables) => {
      const db = getDb();
      const id = Number(variables.id);
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
      if (!project) {
        return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Project not found' }), mimeType: 'application/json' }] };
      }

      // Include task count and recent tasks
      const taskCount = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE project_id = ?').get(id) as { count: number };
      const recentTasks = db.prepare('SELECT id, title, status, priority FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 10').all(id);

      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ ...project, task_count: taskCount.count, recent_tasks: recentTasks }, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  );

  // ─── Tasks Resource ─────────────────────────────────────────────────

  server.resource(
    'tasks',
    new ResourceTemplate('taskflow://tasks/{id}', {
      list: async () => {
        const db = getDb();
        // List active tasks (not done) for discoverability
        const tasks = db.prepare(
          "SELECT * FROM tasks WHERE status != 'done' ORDER BY updated_at DESC LIMIT 50"
        ).all() as TaskRow[];
        return {
          resources: tasks.map(t => ({
            uri: `taskflow://tasks/${t.id}`,
            name: `[${t.status}] ${t.title}`,
            description: t.description?.slice(0, 100) ?? undefined,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    { description: 'TaskFlow tasks', mimeType: 'application/json' },
    async (uri, variables) => {
      const db = getDb();
      const id = Number(variables.id);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
      if (!task) {
        return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Task not found' }), mimeType: 'application/json' }] };
      }

      // Include time tracking and dependencies
      const sessions = db.prepare('SELECT * FROM sessions WHERE task_id = ? ORDER BY start DESC LIMIT 5').all(id);
      const totalTime = db.prepare('SELECT SUM(CASE WHEN end IS NOT NULL THEN (julianday(end) - julianday(start)) * 86400000 ELSE 0 END) as total FROM sessions WHERE task_id = ?').get(id) as { total: number | null };
      const deps = db.prepare('SELECT dependency_id FROM task_dependencies WHERE task_id = ?').all(id) as Array<{ dependency_id: number }>;

      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            ...task,
            tags: task.tags ? JSON.parse(task.tags) : [],
            total_time_ms: totalTime.total ?? 0,
            recent_sessions: sessions,
            dependencies: deps.map(d => d.dependency_id),
          }, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  );
}
