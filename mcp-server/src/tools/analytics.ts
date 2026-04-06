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
    'Get a high-level analytics summary: total focused time, task completion rates, status distribution, and time per project. Useful for standup reports or understanding workload.',
    {
      start_date: z.string().optional(),
      end_date: z.string().optional(),
    },
    { readOnlyHint: true },
    async (params) => getAnalytics(params),
  );

  server.tool(
    'get_timeline',
    'Get focused time grouped by day or week. Use for visualizing work patterns over time.',
    {
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      group_by: z.enum(['day', 'week']).optional(),
    },
    { readOnlyHint: true },
    async (params) => getTimeline(params),
  );

  server.tool(
    'get_tool_stats',
    'Get tool execution statistics: call count, success rate, average duration per tool. Shows which tools are used most and which are slow or failing.',
    {
      since: z.string().optional().describe('ISO date to filter from (e.g. "2026-04-01"). Defaults to all time.'),
      tool_name: z.string().optional().describe('Filter to a specific tool name'),
    },
    { readOnlyHint: true },
    async (params) => {
      const db = getDb();
      const conditions: string[] = [];
      const values: unknown[] = [];

      if (params.since) {
        conditions.push('created_at >= ?');
        values.push(params.since);
      }
      if (params.tool_name) {
        conditions.push('tool_name = ?');
        values.push(params.tool_name);
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

      const stats = db.prepare(`
        SELECT
          tool_name,
          COUNT(*) as call_count,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failure_count,
          ROUND(AVG(duration_ms)) as avg_duration_ms,
          MAX(duration_ms) as max_duration_ms,
          MIN(created_at) as first_call,
          MAX(created_at) as last_call
        FROM tool_executions${where}
        GROUP BY tool_name
        ORDER BY call_count DESC
      `).all(...values);

      const total = db.prepare(`SELECT COUNT(*) as count FROM tool_executions${where}`).get(...values) as { count: number };

      return successResponse({ total_executions: total.count, tools: stats });
    },
  );

  server.tool(
    'get_task_cost',
    'Get per-task cost metrics: tool calls made during active timer sessions, total execution time, and tool breakdown. Useful for understanding which tasks consume the most resources.',
    {
      task_id: z.number().optional().describe('Get cost for a specific task. Omit for all tasks.'),
      project_id: z.number().optional().describe('Get cost for all tasks in a project'),
    },
    { readOnlyHint: true },
    async (params) => {
      const db = getDb();

      if (params.task_id) {
        // Cost for a single task — join tool_executions with sessions
        const stats = db.prepare(`
          SELECT
            t.id as task_id,
            t.title,
            COUNT(te.id) as tool_calls,
            COALESCE(SUM(te.duration_ms), 0) as total_tool_duration_ms,
            SUM(CASE WHEN te.success = 0 THEN 1 ELSE 0 END) as failed_calls,
            COALESCE(SUM(CASE WHEN s.end IS NOT NULL THEN (julianday(s.end) - julianday(s.start)) * 86400000 ELSE 0 END), 0) as total_session_time_ms
          FROM tasks t
          LEFT JOIN sessions s ON s.task_id = t.id
          LEFT JOIN tool_executions te ON te.created_at >= s.start AND (s.end IS NULL OR te.created_at <= s.end)
          WHERE t.id = ?
          GROUP BY t.id
        `).get(params.task_id);

        // Tool breakdown for this task
        const tools = db.prepare(`
          SELECT te.tool_name, COUNT(*) as call_count, ROUND(AVG(te.duration_ms)) as avg_ms
          FROM tool_executions te
          JOIN sessions s ON s.task_id = ? AND te.created_at >= s.start AND (s.end IS NULL OR te.created_at <= s.end)
          GROUP BY te.tool_name
          ORDER BY call_count DESC
        `).all(params.task_id);

        return successResponse({ task: stats, tool_breakdown: tools });
      }

      // All tasks (optionally filtered by project)
      const projectFilter = params.project_id ? 'AND t.project_id = ?' : '';
      const filterValues = params.project_id ? [params.project_id] : [];

      const tasks = db.prepare(`
        SELECT
          t.id as task_id,
          t.title,
          t.status,
          COUNT(te.id) as tool_calls,
          COALESCE(SUM(te.duration_ms), 0) as total_tool_duration_ms,
          COALESCE(SUM(CASE WHEN s.end IS NOT NULL THEN (julianday(s.end) - julianday(s.start)) * 86400000 ELSE 0 END), 0) as total_session_time_ms
        FROM tasks t
        LEFT JOIN sessions s ON s.task_id = t.id
        LEFT JOIN tool_executions te ON te.created_at >= s.start AND (s.end IS NULL OR te.created_at <= s.end)
        WHERE 1=1 ${projectFilter}
        GROUP BY t.id
        HAVING tool_calls > 0
        ORDER BY tool_calls DESC
        LIMIT 30
      `).all(...filterValues);

      return successResponse({ tasks });
    },
  );
}
