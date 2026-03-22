import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { successResponse } from '../helpers.js';

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
  return successResponse({ deleted: countRow.count, message: 'Activity log cleared' });
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerActivityTools(server: McpServer) {
  server.tool(
    'get_activity_log',
    'Retrieve activity log entries with optional filters',
    {
      limit: z.number().optional(),
      action: z.string().optional(),
      entity_type: z.string().optional(),
    },
    async (params) => getActivityLog(params),
  );

  server.tool(
    'clear_activity_log',
    'Delete all activity log entries',
    {},
    async () => clearActivityLog(),
  );
}
