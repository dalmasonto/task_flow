import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse, now, broadcastChange } from '../helpers.js';
import { TaskStatus, TaskPriority, LinkSchema, VALID_TRANSITIONS } from '../types.js';
import type { ErrorCode } from '../types.js';

// ─── helpers ──────────────────────────────────────────────────────────

interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  project_id: number | null;
  dependencies: string;
  links: string;
  tags: string;
  due_date: string | null;
  estimated_time: number | null;
  created_at: string;
  updated_at: string;
}

function parseTask(row: TaskRow) {
  return {
    ...row,
    dependencies: JSON.parse(row.dependencies) as number[],
    links: JSON.parse(row.links) as Array<{ label: string; url: string }>,
    tags: JSON.parse(row.tags) as string[],
  };
}

/** Compact task for list/search responses — omits description, null fields, and empty arrays */
function parseTaskCompact(row: TaskRow) {
  const tags = JSON.parse(row.tags) as string[];
  const deps = JSON.parse(row.dependencies) as number[];
  const result: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
  };
  if (row.project_id != null) result.project_id = row.project_id;
  if (tags.length > 0) result.tags = tags;
  if (deps.length > 0) result.dependencies = deps;
  if (row.due_date != null) result.due_date = row.due_date;
  if (row.estimated_time != null) result.estimated_time = row.estimated_time;
  return result;
}

function detectCycle(taskId: number, proposedDeps: number[]): boolean {
  const db = getDb();
  const allTasks = db.prepare('SELECT id, dependencies FROM tasks').all() as { id: number; dependencies: string }[];

  // Build adjacency list: task -> its dependencies (task depends on dep means edge task->dep)
  // A cycle means: taskId depends on X which depends on Y ... which depends on taskId
  // We need to check: from any of proposedDeps, can we reach taskId by following dependencies?
  // Actually, the direction matters. If task A depends on B, it means B must be done before A.
  // A cycle: A depends on B, B depends on A.
  // Adjacency: A -> [B], B -> [A]. Starting from A's deps [B], follow B's deps [A], found A = cycle.

  const adj = new Map<number, number[]>();
  for (const t of allTasks) {
    const deps = JSON.parse(t.dependencies) as number[];
    if (t.id === taskId) {
      // Use proposed deps instead of current
      adj.set(t.id, proposedDeps);
    } else {
      adj.set(t.id, deps);
    }
  }
  // If task doesn't exist yet (create), add it
  if (!adj.has(taskId)) {
    adj.set(taskId, proposedDeps);
  }

  // DFS from taskId following dependency edges to see if we return to taskId
  const visited = new Set<number>();
  const inStack = new Set<number>();

  function dfs(node: number): boolean {
    if (inStack.has(node)) return true; // back-edge = cycle
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    const deps = adj.get(node) || [];
    for (const dep of deps) {
      if (dfs(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  return dfs(taskId);
}

// ─── exported handler functions ───────────────────────────────────────

export async function createTask(params: {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  project_id?: number;
  dependencies?: number[];
  tags?: string[];
  links?: Array<{ label: string; url: string }>;
  due_date?: string;
  estimated_time?: number;
}) {
  const db = getDb();
  const {
    title,
    description,
    status = 'not_started',
    priority = 'medium',
    project_id,
    dependencies = [],
    tags = [],
    links = [],
    due_date,
    estimated_time,
  } = params;

  // Validate project_id
  if (project_id != null) {
    const proj = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
    if (!proj) return errorResponse('Project not found', 'NOT_FOUND');
  }

  // Validate dependencies exist
  if (dependencies.length > 0) {
    const placeholders = dependencies.map(() => '?').join(',');
    const existing = db.prepare(`SELECT id FROM tasks WHERE id IN (${placeholders})`).all(...dependencies) as { id: number }[];
    if (existing.length !== dependencies.length) {
      return errorResponse('One or more dependency task IDs do not exist', 'VALIDATION_ERROR');
    }
  }

  // Check for cycles — we need a temporary ID; use max(id)+1 as placeholder
  if (dependencies.length > 0) {
    const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM tasks').get() as { next_id: number };
    if (detectCycle(maxRow.next_id, dependencies)) {
      return errorResponse('Adding these dependencies would create a cycle', 'CYCLE_DETECTED');
    }
  }

  const ts = now();
  const result = db.prepare(
    `INSERT INTO tasks (title, description, status, priority, project_id, dependencies, links, tags, due_date, estimated_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    title,
    description ?? null,
    status,
    priority,
    project_id ?? null,
    JSON.stringify(dependencies),
    JSON.stringify(links),
    JSON.stringify(tags),
    due_date ?? null,
    estimated_time ?? null,
    ts,
    ts,
  );

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid) as TaskRow;
  logActivity('task_created', title, { entityType: 'task', entityId: task.id });

  const createdTask = parseTask(task);
  broadcastChange('task', 'task_created', createdTask);
  return successResponse(createdTask);
}

export async function listTasks(params: {
  status?: string;
  project_id?: number;
  priority?: string;
  tag?: string;
}) {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.status) {
    conditions.push('status = ?');
    values.push(params.status);
  }
  if (params.project_id != null) {
    conditions.push('project_id = ?');
    values.push(params.project_id);
  }
  if (params.priority) {
    conditions.push('priority = ?');
    values.push(params.priority);
  }

  let sql = 'SELECT * FROM tasks';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  let rows = db.prepare(sql).all(...values) as TaskRow[];

  // Filter by tag in-memory (JSON column)
  if (params.tag) {
    rows = rows.filter(r => {
      const tags = JSON.parse(r.tags) as string[];
      return tags.includes(params.tag!);
    });
  }

  return successResponse(rows.map(parseTaskCompact));
}

export async function getTask(params: { id: number }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) as TaskRow | undefined;
  if (!row) return errorResponse('Task not found', 'NOT_FOUND');

  const timeRow = db.prepare(
    `SELECT
       COUNT(*) AS session_count,
       COALESCE(SUM((julianday(COALESCE(end, datetime('now'))) - julianday(start)) * 86400000), 0) AS total_time
     FROM sessions WHERE task_id = ?`
  ).get(params.id) as { session_count: number; total_time: number };

  return successResponse({
    ...parseTask(row),
    total_time: Math.round(timeRow.total_time),
    session_count: timeRow.session_count,
  });
}

export async function updateTask(params: {
  id: number;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  project_id?: number;
  dependencies?: number[];
  tags?: string[];
  links?: Array<{ label: string; url: string }>;
  due_date?: string;
  estimated_time?: number;
}) {
  const db = getDb();
  const old = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) as TaskRow | undefined;
  if (!old) return errorResponse('Task not found', 'NOT_FOUND');

  const oldParsed = parseTask(old);

  // Validate dependencies
  const newDeps = params.dependencies ?? oldParsed.dependencies;
  if (params.dependencies && params.dependencies.length > 0) {
    const placeholders = params.dependencies.map(() => '?').join(',');
    const existing = db.prepare(`SELECT id FROM tasks WHERE id IN (${placeholders})`).all(...params.dependencies) as { id: number }[];
    if (existing.length !== params.dependencies.length) {
      return errorResponse('One or more dependency task IDs do not exist', 'VALIDATION_ERROR');
    }
    // Cycle detection
    if (detectCycle(params.id, params.dependencies)) {
      return errorResponse('Adding these dependencies would create a cycle', 'CYCLE_DETECTED');
    }
  }

  // Validate project_id if changing
  if (params.project_id != null) {
    const proj = db.prepare('SELECT id FROM projects WHERE id = ?').get(params.project_id);
    if (!proj) return errorResponse('Project not found', 'NOT_FOUND');
  }

  const ts = now();
  const updates: Record<string, unknown> = {};
  if (params.title !== undefined) updates.title = params.title;
  if (params.description !== undefined) updates.description = params.description;
  if (params.status !== undefined) updates.status = params.status;
  if (params.priority !== undefined) updates.priority = params.priority;
  if (params.project_id !== undefined) updates.project_id = params.project_id;
  if (params.dependencies !== undefined) updates.dependencies = JSON.stringify(params.dependencies);
  if (params.tags !== undefined) updates.tags = JSON.stringify(params.tags);
  if (params.links !== undefined) updates.links = JSON.stringify(params.links);
  if (params.due_date !== undefined) updates.due_date = params.due_date;
  if (params.estimated_time !== undefined) updates.estimated_time = params.estimated_time;

  if (Object.keys(updates).length === 0) {
    return successResponse(oldParsed);
  }

  updates.updated_at = ts;
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(updates);
  db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...vals, params.id);

  // Log granular changes for deps, tags, links
  if (params.dependencies !== undefined) {
    const added = params.dependencies.filter(d => !oldParsed.dependencies.includes(d));
    const removed = oldParsed.dependencies.filter(d => !params.dependencies!.includes(d));
    for (const d of added) {
      logActivity('dependency_added', oldParsed.title, { detail: `Dependency ${d} added`, entityType: 'task', entityId: params.id });
    }
    for (const d of removed) {
      logActivity('dependency_removed', oldParsed.title, { detail: `Dependency ${d} removed`, entityType: 'task', entityId: params.id });
    }
  }
  if (params.tags !== undefined) {
    const added = params.tags.filter(t => !oldParsed.tags.includes(t));
    const removed = oldParsed.tags.filter(t => !params.tags!.includes(t));
    for (const t of added) {
      logActivity('tag_added', oldParsed.title, { detail: `Tag "${t}" added`, entityType: 'task', entityId: params.id });
    }
    for (const t of removed) {
      logActivity('tag_removed', oldParsed.title, { detail: `Tag "${t}" removed`, entityType: 'task', entityId: params.id });
    }
  }
  if (params.links !== undefined) {
    const oldUrls = new Set(oldParsed.links.map(l => l.url));
    const newUrls = new Set(params.links.map(l => l.url));
    const added = params.links.filter(l => !oldUrls.has(l.url));
    const removed = oldParsed.links.filter(l => !newUrls.has(l.url));
    for (const l of added) {
      logActivity('link_added', oldParsed.title, { detail: `Link "${l.label}" added`, entityType: 'task', entityId: params.id });
    }
    for (const l of removed) {
      logActivity('task_unlinked', oldParsed.title, { detail: `Link "${l.label}" removed`, entityType: 'task', entityId: params.id });
    }
  }

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) as TaskRow;
  const updatedTask = parseTask(updated);
  broadcastChange('task', 'task_updated', updatedTask);
  return successResponse(updatedTask);
}

export async function updateTaskStatus(params: { id: number; status: string }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) as TaskRow | undefined;
  if (!row) return errorResponse('Task not found', 'NOT_FOUND');

  const currentStatus = row.status as keyof typeof VALID_TRANSITIONS;
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(params.status as any)) {
    return errorResponse(
      `Cannot transition from "${currentStatus}" to "${params.status}"`,
      'INVALID_TRANSITION',
    );
  }

  const ts = now();

  // Auto-start a timer session when entering in_progress
  if (params.status === 'in_progress') {
    const existingOpen = db.prepare('SELECT id FROM sessions WHERE task_id = ? AND end IS NULL').get(params.id);
    if (!existingOpen) {
      const result = db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(params.id, ts, null);
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid);
      logActivity('timer_started', row.title, { entityType: 'task', entityId: params.id });
      broadcastChange('timer', 'timer_started', { task_id: params.id, session, task_status: 'in_progress' });
    }
  }

  // Auto-close any active timer session when leaving an active state
  const terminalStatuses = ['done', 'partial_done', 'blocked', 'paused'];
  if (terminalStatuses.includes(params.status)) {
    const openSession = db.prepare('SELECT * FROM sessions WHERE task_id = ? AND end IS NULL').get(params.id) as
      | { id: number; start: string }
      | undefined;
    if (openSession) {
      db.prepare('UPDATE sessions SET end = ? WHERE id = ?').run(ts, openSession.id);
      const duration = new Date(ts).getTime() - new Date(openSession.start).getTime();
      logActivity('timer_stopped', row.title, {
        detail: `Auto-stopped: duration ${duration}ms, status → ${params.status}`,
        entityType: 'task',
        entityId: params.id,
      });
      broadcastChange('timer', 'timer_stopped', { task_id: params.id, session: { ...openSession, end: ts, duration }, task_status: params.status });
    }
  }

  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(params.status, ts, params.id);

  // Log appropriate action
  let statusAction: string;
  if (params.status === 'done') {
    logActivity('task_completed', row.title, { entityType: 'task', entityId: params.id });
    statusAction = 'task_completed';
  } else if (params.status === 'partial_done') {
    logActivity('task_partial_done', row.title, { entityType: 'task', entityId: params.id });
    statusAction = 'task_partial_done';
  } else {
    logActivity('task_status_changed', row.title, {
      detail: `${currentStatus} -> ${params.status}`,
      entityType: 'task',
      entityId: params.id,
    });
    statusAction = 'task_status_changed';
  }

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) as TaskRow;
  broadcastChange('task', statusAction, parseTask(updated));
  return successResponse(parseTaskCompact(updated));
}

export async function deleteTask(params: { id: number }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) as TaskRow | undefined;
  if (!row) return errorResponse('Task not found', 'NOT_FOUND');

  db.prepare('DELETE FROM tasks WHERE id = ?').run(params.id);
  logActivity('task_deleted', row.title, { entityType: 'task', entityId: params.id });

  broadcastChange('task', 'task_deleted', { id: params.id });
  return successResponse({ deleted: true, id: params.id });
}

export async function bulkCreateTasks(params: {
  tasks: Array<{
    title: string;
    description?: string;
    priority?: string;
    project_id?: number;
    status?: string;
    dependencies?: number[];
    tags?: string[];
  }>;
}) {
  const db = getDb();
  const ts = now();
  const created: ReturnType<typeof parseTask>[] = [];

  const insertStmt = db.prepare(
    `INSERT INTO tasks (title, description, status, priority, project_id, dependencies, links, tags, due_date, estimated_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const transaction = db.transaction(() => {
    for (const t of params.tasks) {
      const result = insertStmt.run(
        t.title,
        t.description ?? null,
        t.status ?? 'not_started',
        t.priority ?? 'medium',
        t.project_id ?? null,
        JSON.stringify(t.dependencies ?? []),
        '[]',
        JSON.stringify(t.tags ?? []),
        null,
        null,
        ts,
        ts,
      );
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid) as TaskRow;
      created.push(parseTask(row));
    }
  });

  transaction();

  logActivity('tasks_bulk_created', `${created.length} tasks created`, {
    detail: created.map(t => t.title).join(', '),
  });

  const createdTasks = created;
  broadcastChange('task', 'tasks_bulk_created', { tasks: createdTasks });
  return successResponse(createdTasks);
}

export async function searchTasks(params: { query: string }) {
  const db = getDb();
  const like = `%${params.query}%`;
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE title LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE`
  ).all(like, like) as TaskRow[];

  return successResponse(rows.map(parseTaskCompact));
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerTaskTools(server: McpServer) {
  server.tool(
    'create_task',
    'Create a new task. Use this when starting new work to keep TaskFlow in sync. Supports dependencies, tags, links, and time estimates.',
    {
      title: z.string(),
      description: z.string().optional(),
      status: TaskStatus.optional(),
      priority: TaskPriority.optional(),
      project_id: z.number().optional(),
      dependencies: z.array(z.number()).optional(),
      tags: z.array(z.string()).optional(),
      links: z.array(LinkSchema).optional(),
      due_date: z.string().optional(),
      estimated_time: z.number().optional(),
    },
    async (params) => createTask(params),
  );

  server.tool(
    'list_tasks',
    'List tasks with optional filters. Use at conversation start to see what is in progress or blocked. Filter by status, project, priority, or tag.',
    {
      status: TaskStatus.optional(),
      project_id: z.number().optional(),
      priority: TaskPriority.optional(),
      tag: z.string().optional(),
    },
    async (params) => listTasks(params),
  );

  server.tool(
    'get_task',
    'Get a task by ID with time tracking info. Read the description carefully — it often contains implementation details and acceptance criteria.',
    { id: z.number() },
    async (params) => getTask(params),
  );

  server.tool(
    'update_task',
    'Update task fields. Use this to add details, update descriptions with progress notes, or adjust priority as you learn more.',
    {
      id: z.number(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: TaskStatus.optional(),
      priority: TaskPriority.optional(),
      project_id: z.number().optional(),
      dependencies: z.array(z.number()).optional(),
      tags: z.array(z.string()).optional(),
      links: z.array(LinkSchema).optional(),
      due_date: z.string().optional(),
      estimated_time: z.number().optional(),
    },
    async (params) => updateTask(params),
  );

  server.tool(
    'update_task_status',
    'Update task status with transition validation. Use when a task becomes blocked, is partially done, or needs to be reopened.',
    {
      id: z.number(),
      status: TaskStatus,
    },
    async (params) => updateTaskStatus(params),
  );

  server.tool(
    'delete_task',
    'Delete a task by ID. Use sparingly — prefer updating status to "done" instead of deleting.',
    { id: z.number() },
    async (params) => deleteTask(params),
  );

  server.tool(
    'bulk_create_tasks',
    'Create multiple tasks in a single transaction. Useful when breaking down a feature into subtasks.',
    {
      tasks: z.array(z.object({
        title: z.string(),
        description: z.string().optional(),
        priority: TaskPriority.optional(),
        project_id: z.number().optional(),
        status: TaskStatus.optional(),
        dependencies: z.array(z.number()).optional(),
        tags: z.array(z.string()).optional(),
      })),
    },
    async (params) => bulkCreateTasks(params),
  );

  server.tool(
    'search_tasks',
    'Search tasks by title or description. Use this to find tasks related to your current work before creating duplicates.',
    { query: z.string() },
    async (params) => searchTasks(params),
  );
}
