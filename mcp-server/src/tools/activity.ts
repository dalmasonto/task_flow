import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, successResponse, broadcastChange } from '../helpers.js';

// ─── interfaces ───────────────────────────────────────────────────────

interface ActivityLogRow {
  id: number;
  action: string;
  title: string;
  detail: string | null;
  entity_type: string | null;
  entity_id: number | null;
  created_at: string;
}

// ─── exported handler functions ───────────────────────────────────────

export async function getActivityLog(params: {
  limit?: number;
  action?: string;
  entity_type?: string;
}) {
  const db = getDb();
  const limit = params.limit ?? 50;
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.action) {
    conditions.push('action = ?');
    values.push(params.action);
  }
  if (params.entity_type) {
    conditions.push('entity_type = ?');
    values.push(params.entity_type);
  }

  let sql = 'SELECT * FROM activity_logs';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  values.push(limit);

  const rows = db.prepare(sql).all(...values) as ActivityLogRow[];
  return successResponse(rows);
}

export async function clearActivityLog() {
  const db = getDb();
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get() as { count: number };
  db.prepare('DELETE FROM activity_logs').run();
  broadcastChange('activity', 'activity_cleared', {});
  return successResponse({ deleted: countRow.count, message: 'Activity log cleared' });
}

export async function logDebug(params: {
  message: string;
  task_id?: number;
  detail?: string;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO activity_logs (action, title, detail, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('debug_log', params.message, params.detail ?? null, params.task_id ? 'task' : null, params.task_id ?? null, now);

  const entry = db.prepare('SELECT * FROM activity_logs WHERE id = ?').get(result.lastInsertRowid);
  broadcastChange('activity', 'activity_logged', entry);
  return successResponse({ id: result.lastInsertRowid, message: params.message });
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerActivityTools(server: McpServer) {
  server.tool(
    'get_activity_log',
    'Retrieve recent activity log entries. Shows what has changed — task completions, timer events, status transitions. Filter by action or entity type.',
    {
      limit: z.number().optional(),
      action: z.string().optional(),
      entity_type: z.string().optional(),
    },
    async (params) => getActivityLog(params),
  );

  server.tool(
    'clear_activity_log',
    'Delete all activity log entries. Use with caution — this is irreversible.',
    {},
    async () => clearActivityLog(),
  );

  server.tool(
    'log_debug',
    'Log a debug entry to the activity log. Use this while debugging to record what you are investigating, what you tried, what you found, and your reasoning. Optionally link to a task. These entries appear in the Activity Pulse in the UI.',
    {
      message: z.string().describe('Short summary of what you are doing or found'),
      detail: z.string().optional().describe('Longer explanation — stack traces, error messages, hypotheses, what you tried'),
      task_id: z.number().optional().describe('Link this debug log to a specific task'),
    },
    async (params) => logDebug(params),
  );
}
