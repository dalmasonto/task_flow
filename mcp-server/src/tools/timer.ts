import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse, now } from '../helpers.js';
import { VALID_TRANSITIONS } from '../types.js';

// ─── types ────────────────────────────────────────────────────────────

interface TaskRow {
  id: number;
  title: string;
  status: string;
}

interface SessionRow {
  id: number;
  task_id: number;
  start: string;
  end: string | null;
}

// ─── exported handler functions ───────────────────────────────────────

export async function startTimer(params: { task_id: number }) {
  const db = getDb();
  const task = db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(params.task_id) as TaskRow | undefined;
  if (!task) return errorResponse('Task not found', 'NOT_FOUND');

  // Check no open session exists
  const openSession = db.prepare('SELECT id FROM sessions WHERE task_id = ? AND end IS NULL').get(params.task_id);
  if (openSession) return errorResponse('A timer session is already active for this task', 'SESSION_ALREADY_ACTIVE');

  // Check valid transition to in_progress
  const currentStatus = task.status as keyof typeof VALID_TRANSITIONS;
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes('in_progress')) {
    return errorResponse(
      `Cannot transition from "${currentStatus}" to "in_progress"`,
      'INVALID_TRANSITION',
    );
  }

  const ts = now();

  // Create session
  const result = db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(params.task_id, ts, null);

  // Update task status to in_progress
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('in_progress', ts, params.task_id);

  logActivity('timer_started', task.title, { entityType: 'task', entityId: params.task_id });

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid) as SessionRow;
  return successResponse(session);
}

export async function pauseTimer(params: { task_id: number }) {
  const db = getDb();
  const task = db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(params.task_id) as TaskRow | undefined;
  if (!task) return errorResponse('Task not found', 'NOT_FOUND');

  // Find open session
  const session = db.prepare('SELECT * FROM sessions WHERE task_id = ? AND end IS NULL').get(params.task_id) as SessionRow | undefined;
  if (!session) return errorResponse('No active timer session for this task', 'NO_ACTIVE_SESSION');

  const endTime = now();
  const duration = new Date(endTime).getTime() - new Date(session.start).getTime();

  // Close session
  db.prepare('UPDATE sessions SET end = ? WHERE id = ?').run(endTime, session.id);

  // Update task to paused
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('paused', endTime, params.task_id);

  logActivity('timer_paused', task.title, {
    detail: `Duration: ${duration}ms`,
    entityType: 'task',
    entityId: params.task_id,
  });

  return successResponse({ ...session, end: endTime, duration });
}

export async function stopTimer(params: { task_id: number; final_status?: string }) {
  const db = getDb();
  const task = db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(params.task_id) as TaskRow | undefined;
  if (!task) return errorResponse('Task not found', 'NOT_FOUND');

  // Find open session
  const session = db.prepare('SELECT * FROM sessions WHERE task_id = ? AND end IS NULL').get(params.task_id) as SessionRow | undefined;
  if (!session) return errorResponse('No active timer session for this task', 'NO_ACTIVE_SESSION');

  const finalStatus = params.final_status ?? 'done';
  const endTime = now();
  const duration = new Date(endTime).getTime() - new Date(session.start).getTime();

  // Close session
  db.prepare('UPDATE sessions SET end = ? WHERE id = ?').run(endTime, session.id);

  // Update task to final_status
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(finalStatus, endTime, params.task_id);

  logActivity('timer_stopped', task.title, {
    detail: `Duration: ${duration}ms, final status: ${finalStatus}`,
    entityType: 'task',
    entityId: params.task_id,
  });

  // Also log status-specific action
  if (finalStatus === 'done') {
    logActivity('task_completed', task.title, { entityType: 'task', entityId: params.task_id });
  } else if (finalStatus === 'partial_done') {
    logActivity('task_partial_done', task.title, { entityType: 'task', entityId: params.task_id });
  }

  return successResponse({ ...session, end: endTime, duration });
}

export async function listSessions(params: {
  task_id?: number;
  start_date?: string;
  end_date?: string;
}) {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.task_id != null) {
    conditions.push('task_id = ?');
    values.push(params.task_id);
  }
  if (params.start_date) {
    conditions.push('start >= ?');
    values.push(params.start_date);
  }
  if (params.end_date) {
    conditions.push('start <= ?');
    values.push(params.end_date);
  }

  let sql = 'SELECT * FROM sessions';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY start ASC';

  const rows = db.prepare(sql).all(...values) as SessionRow[];

  const nowMs = Date.now();
  const sessions = rows.map(row => {
    const startMs = new Date(row.start).getTime();
    const endMs = row.end ? new Date(row.end).getTime() : nowMs;
    const duration = endMs - startMs;
    return { ...row, duration };
  });

  return successResponse(sessions);
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerTimerTools(server: McpServer) {
  server.tool(
    'start_timer',
    'Start a timer session for a task',
    { task_id: z.number() },
    async (params) => startTimer(params),
  );

  server.tool(
    'pause_timer',
    'Pause the active timer session for a task',
    { task_id: z.number() },
    async (params) => pauseTimer(params),
  );

  server.tool(
    'stop_timer',
    'Stop the active timer session for a task and set its final status',
    {
      task_id: z.number(),
      final_status: z.enum(['done', 'partial_done', 'blocked']).optional(),
    },
    async (params) => stopTimer(params),
  );

  server.tool(
    'list_sessions',
    'List timer sessions with optional filters',
    {
      task_id: z.number().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
    },
    async (params) => listSessions(params),
  );
}
