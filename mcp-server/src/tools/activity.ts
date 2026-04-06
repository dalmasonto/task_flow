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

// ─── compaction ──────────────────────────────────────────────────────

const DEFAULT_PRESERVE_RECENT = 50;
const DEFAULT_MAX_LOG_ENTRIES = 500;

/** Actions that are always preserved in full (never compacted) */
const MILESTONE_ACTIONS = new Set([
  'task_created', 'task_completed', 'task_partial_done',
  'project_created', 'project_deleted',
  'agent_connected', 'agent_disconnected',
]);

export async function compactActivityLog(params: {
  preserve_recent?: number;
  max_entries?: number;
  dry_run?: boolean;
}) {
  const db = getDb();
  const preserveRecent = params.preserve_recent ?? DEFAULT_PRESERVE_RECENT;
  const maxEntries = params.max_entries ?? DEFAULT_MAX_LOG_ENTRIES;

  const totalCount = (db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get() as { count: number }).count;

  if (totalCount <= maxEntries) {
    return successResponse({
      compacted: false,
      total_entries: totalCount,
      message: `Log has ${totalCount} entries (threshold: ${maxEntries}) — no compaction needed.`,
    });
  }

  // Get all entries sorted by date
  const allEntries = db.prepare('SELECT * FROM activity_logs ORDER BY created_at ASC').all() as ActivityLogRow[];

  // Split into: entries to compact vs entries to preserve
  const cutoffIndex = allEntries.length - preserveRecent;
  const toCompact = allEntries.slice(0, cutoffIndex);
  const toPreserve = allEntries.slice(cutoffIndex);

  if (toCompact.length === 0) {
    return successResponse({
      compacted: false,
      total_entries: totalCount,
      message: 'All entries are within the preserve window — nothing to compact.',
    });
  }

  // Generate summary of compacted entries
  const actionCounts: Record<string, number> = {};
  const milestones: string[] = [];
  const timeRange = {
    start: toCompact[0].created_at,
    end: toCompact[toCompact.length - 1].created_at,
  };

  for (const entry of toCompact) {
    actionCounts[entry.action] = (actionCounts[entry.action] || 0) + 1;
    if (MILESTONE_ACTIONS.has(entry.action)) {
      milestones.push(`[${entry.created_at.slice(0, 16)}] ${entry.action}: ${entry.title}`);
    }
  }

  const summaryDetail = [
    `## Compaction Summary`,
    `**Period:** ${timeRange.start} → ${timeRange.end}`,
    `**Entries compacted:** ${toCompact.length}`,
    ``,
    `### Action Counts`,
    ...Object.entries(actionCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([action, count]) => `- \`${action}\`: ${count}`),
    ``,
    `### Key Milestones`,
    ...(milestones.length > 0
      ? milestones.slice(-20).map(m => `- ${m}`)
      : ['- (none)']),
  ].join('\n');

  if (params.dry_run) {
    return successResponse({
      compacted: false,
      dry_run: true,
      would_compact: toCompact.length,
      would_preserve: toPreserve.length,
      summary_preview: summaryDetail,
    });
  }

  // Delete compacted entries and insert summary
  const compactIds = toCompact.map(e => e.id);
  const placeholders = compactIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM activity_logs WHERE id IN (${placeholders})`).run(...compactIds);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO activity_logs (action, title, detail, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    'compaction_summary',
    `Compacted ${toCompact.length} activity log entries (${timeRange.start.slice(0, 10)} → ${timeRange.end.slice(0, 10)})`,
    summaryDetail,
    null,
    null,
    now,
  );

  broadcastChange('activity', 'activity_compacted', { compacted: toCompact.length, preserved: toPreserve.length });

  return successResponse({
    compacted: true,
    entries_removed: toCompact.length,
    entries_preserved: toPreserve.length,
    summary_inserted: true,
    new_total: toPreserve.length + 1,
  });
}

export async function logDebug(params: {
  message: string;
  task_id?: number;
  project_id?: number;
  detail?: string;
}) {
  const db = getDb();
  const now = new Date().toISOString();

  // task_id takes priority; fall back to project_id
  const entityType = params.task_id ? 'task' : params.project_id ? 'project' : null;
  const entityId = params.task_id ?? params.project_id ?? null;

  const result = db.prepare(
    `INSERT INTO activity_logs (action, title, detail, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('debug_log', params.message, params.detail ?? null, entityType, entityId, now);

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
    { readOnlyHint: true },
    async (params) => getActivityLog(params),
  );

  server.tool(
    'clear_activity_log',
    'Delete all activity log entries. Use with caution — this is irreversible.',
    {},
    { destructiveHint: true },
    async () => clearActivityLog(),
  );

  server.tool(
    'log_debug',
    'Log a debug entry to the activity log. Use this to record your work process — what you investigated, commands you ran, decisions you made, and findings. Entries appear in the Activity Pulse and on the project page. Link to a task (task_id) or project (project_id) for context.',
    {
      message: z.string().describe('Short summary of what you are doing or found'),
      detail: z.string().optional().describe('Longer explanation — stack traces, error messages, hypotheses, commands run, what you tried'),
      task_id: z.number().optional().describe('Link this debug log to a specific task'),
      project_id: z.number().optional().describe('Link this debug log to a project (used when no specific task applies)'),
    },
    { readOnlyHint: false },
    async (params) => logDebug(params),
  );

  server.tool(
    'compact_activity_log',
    'Compact old activity log entries into a summary. Keeps the most recent entries (default 50) and summarizes the rest. Use dry_run=true to preview what would be compacted. Runs automatically when log exceeds max_entries threshold.',
    {
      preserve_recent: z.number().optional().describe('Number of recent entries to keep verbatim (default: 50)'),
      max_entries: z.number().optional().describe('Only compact if log exceeds this count (default: 500)'),
      dry_run: z.boolean().optional().describe('If true, show what would be compacted without doing it'),
    },
    { readOnlyHint: false },
    async (params) => compactActivityLog(params),
  );
}
