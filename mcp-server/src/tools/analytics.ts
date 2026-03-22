import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { successResponse } from '../helpers.js';

// ─── exported handler functions ───────────────────────────────────────

export async function getAnalytics(params: {
  start_date?: string;
  end_date?: string;
}) {
  const db = getDb();
  const { start_date, end_date } = params;

  // Build date filter for sessions
  const sessionConditions: string[] = [];
  const sessionValues: unknown[] = [];
  if (start_date) {
    sessionConditions.push('start >= ?');
    sessionValues.push(start_date);
  }
  if (end_date) {
    sessionConditions.push('start <= ?');
    sessionValues.push(end_date);
  }
  const sessionWhere = sessionConditions.length > 0
    ? `WHERE ${sessionConditions.join(' AND ')}`
    : '';

  // Total focused time (sum of all session durations in ms)
  const durationFormula = `(julianday(COALESCE(end, datetime('now'))) - julianday(start)) * 86400000`;
  const timeRow = db.prepare(
    `SELECT COALESCE(SUM(${durationFormula}), 0) AS total_focused_time FROM sessions ${sessionWhere}`
  ).get(...sessionValues) as { total_focused_time: number };

  const total_focused_time = Math.round(timeRow.total_focused_time);

  // Task counts by status
  const taskRows = db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all() as Array<{
    status: string;
    count: number;
  }>;

  const status_distribution: Record<string, number> = {};
  let tasks_completed = 0;
  let tasks_in_progress = 0;
  let total_tasks = 0;

  for (const row of taskRows) {
    status_distribution[row.status] = row.count;
    total_tasks += row.count;
    if (row.status === 'done') tasks_completed = row.count;
    if (row.status === 'in_progress') tasks_in_progress = row.count;
  }

  // Time per project (only tasks that belong to a project)
  const projectTimeRows = db.prepare(
    `SELECT
       t.project_id,
       p.name AS project_name,
       COALESCE(SUM(${durationFormula.replace(/start/g, 's.start').replace(/end/g, 's.end')}), 0) AS total_time
     FROM sessions s
     JOIN tasks t ON s.task_id = t.id
     JOIN projects p ON t.project_id = p.id
     ${sessionWhere.replace(/start/g, 's.start')}
     GROUP BY t.project_id, p.name`
  ).all(...sessionValues) as Array<{
    project_id: number;
    project_name: string;
    total_time: number;
  }>;

  const time_per_project = projectTimeRows.map(row => ({
    project_id: row.project_id,
    project_name: row.project_name,
    total_time: Math.round(row.total_time),
  }));

  return successResponse({
    total_focused_time,
    tasks_completed,
    tasks_in_progress,
    total_tasks,
    status_distribution,
    time_per_project,
  });
}

export async function getTimeline(params: {
  start_date?: string;
  end_date?: string;
  group_by?: 'day' | 'week';
}) {
  const db = getDb();
  const { start_date, end_date, group_by = 'day' } = params;

  const periodExpr = group_by === 'week'
    ? `strftime('%Y-W%W', start)`
    : `strftime('%Y-%m-%d', start)`;

  const durationFormula = `(julianday(COALESCE(end, datetime('now'))) - julianday(start)) * 86400000`;

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (start_date) {
    conditions.push('start >= ?');
    values.push(start_date);
  }
  if (end_date) {
    conditions.push('start <= ?');
    values.push(end_date);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(
    `SELECT
       ${periodExpr} AS period,
       COALESCE(SUM(${durationFormula}), 0) AS total_time,
       COUNT(*) AS session_count
     FROM sessions
     ${where}
     GROUP BY period
     ORDER BY period ASC`
  ).all(...values) as Array<{
    period: string;
    total_time: number;
    session_count: number;
  }>;

  const timeline = rows.map(row => ({
    period: row.period,
    total_time: Math.round(row.total_time),
    session_count: row.session_count,
  }));

  return successResponse(timeline);
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerAnalyticsTools(server: McpServer) {
  server.tool(
    'get_analytics',
    'Get analytics summary: total focused time, task counts, status distribution, and time per project',
    {
      start_date: z.string().optional(),
      end_date: z.string().optional(),
    },
    async (params) => getAnalytics(params),
  );

  server.tool(
    'get_timeline',
    'Get focused time grouped by day or week',
    {
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      group_by: z.enum(['day', 'week']).optional(),
    },
    async (params) => getTimeline(params),
  );
}
