import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { getDb } from '../db.js';
import { successResponse, errorResponse } from '../helpers.js';
import { getConfig } from '../config.js';

const CHECKPOINTS_DIR = resolve(homedir(), '.taskflow/checkpoints');
const MAX_CHECKPOINTS_PER_TASK = 10;

interface CheckpointData {
  task_id: number;
  timestamp: string;
  task: Record<string, unknown>;
  dependencies: number[];
  recent_activity: Array<Record<string, unknown>>;
  active_session: Record<string, unknown> | null;
  total_time_ms: number;
  tool_stats: Array<Record<string, unknown>>;
}

function getTaskDir(taskId: number): string {
  const dir = resolve(CHECKPOINTS_DIR, String(taskId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function createCheckpoint(params: { task_id: number }) {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.task_id) as Record<string, unknown> | undefined;
  if (!task) return errorResponse(`Task ${params.task_id} not found`, 'NOT_FOUND');

  // Gather task state
  const deps = db.prepare('SELECT dependency_id FROM task_dependencies WHERE task_id = ?').all(params.task_id) as Array<{ dependency_id: number }>;
  const recentActivity = db.prepare(
    'SELECT * FROM activity_logs WHERE entity_id = ? AND entity_type = ? ORDER BY created_at DESC LIMIT 20'
  ).all(params.task_id, 'task') as Array<Record<string, unknown>>;
  const activeSession = db.prepare('SELECT * FROM sessions WHERE task_id = ? AND end IS NULL').get(params.task_id) as Record<string, unknown> | null;
  const totalTime = db.prepare(
    'SELECT SUM(CASE WHEN end IS NOT NULL THEN (julianday(end) - julianday(start)) * 86400000 ELSE 0 END) as total FROM sessions WHERE task_id = ?'
  ).get(params.task_id) as { total: number | null };

  // Tool stats during this task's sessions
  const toolStats = db.prepare(`
    SELECT te.tool_name, COUNT(*) as calls, ROUND(AVG(te.duration_ms)) as avg_ms
    FROM tool_executions te
    JOIN sessions s ON s.task_id = ? AND te.created_at >= s.start AND (s.end IS NULL OR te.created_at <= s.end)
    GROUP BY te.tool_name ORDER BY calls DESC LIMIT 10
  `).all(params.task_id) as Array<Record<string, unknown>>;

  const checkpoint: CheckpointData = {
    task_id: params.task_id,
    timestamp: new Date().toISOString(),
    task,
    dependencies: deps.map(d => d.dependency_id),
    recent_activity: recentActivity,
    active_session: activeSession,
    total_time_ms: totalTime.total ?? 0,
    tool_stats: toolStats,
  };

  // Write checkpoint file
  const taskDir = getTaskDir(params.task_id);
  const filename = `${checkpoint.timestamp.replace(/[:.]/g, '-')}.json`;
  const filepath = resolve(taskDir, filename);
  writeFileSync(filepath, JSON.stringify(checkpoint, null, 2), 'utf-8');

  // Prune old checkpoints
  const files = readdirSync(taskDir).filter(f => f.endsWith('.json')).sort();
  while (files.length > MAX_CHECKPOINTS_PER_TASK) {
    const oldest = files.shift()!;
    try { unlinkSync(resolve(taskDir, oldest)); } catch { /* ignore */ }
  }

  return successResponse({
    task_id: params.task_id,
    checkpoint: filename,
    path: filepath,
    total_checkpoints: Math.min(files.length, MAX_CHECKPOINTS_PER_TASK),
  });
}

export async function getCheckpoint(params: { task_id: number; latest?: boolean }) {
  const taskDir = resolve(CHECKPOINTS_DIR, String(params.task_id));
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(f => f.endsWith('.json')).sort();
  } catch {
    return errorResponse(`No checkpoints found for task ${params.task_id}`, 'NOT_FOUND');
  }

  if (files.length === 0) {
    return errorResponse(`No checkpoints found for task ${params.task_id}`, 'NOT_FOUND');
  }

  // Return latest by default
  const file = files[files.length - 1];
  const data = JSON.parse(readFileSync(resolve(taskDir, file), 'utf-8')) as CheckpointData;

  return successResponse({
    checkpoint: file,
    data,
    available_checkpoints: files.length,
  });
}

export async function listCheckpoints(params: { task_id: number }) {
  const taskDir = resolve(CHECKPOINTS_DIR, String(params.task_id));
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(f => f.endsWith('.json')).sort();
  } catch {
    return successResponse({ task_id: params.task_id, checkpoints: [] });
  }

  return successResponse({
    task_id: params.task_id,
    checkpoints: files.map(f => ({
      filename: f,
      timestamp: f.replace('.json', '').replace(/-/g, (m, offset) => offset <= 9 ? '-' : offset <= 15 ? ':' : '.'),
    })),
  });
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerCheckpointTools(server: McpServer) {
  server.tool(
    'create_checkpoint',
    'Create a checkpoint snapshot of a task\'s current state. Captures: task data, dependencies, recent activity, active timer, tool stats. Useful before context switches or at key milestones.',
    { task_id: z.number().describe('The task ID to checkpoint') },
    { readOnlyHint: false },
    async (params) => createCheckpoint(params),
  );

  server.tool(
    'get_checkpoint',
    'Get the latest checkpoint for a task. Returns the full task snapshot — useful for resuming work after an interruption.',
    { task_id: z.number().describe('The task ID to get checkpoint for') },
    { readOnlyHint: true },
    async (params) => getCheckpoint(params),
  );

  server.tool(
    'list_checkpoints',
    'List all available checkpoints for a task.',
    { task_id: z.number().describe('The task ID to list checkpoints for') },
    { readOnlyHint: true },
    async (params) => listCheckpoints(params),
  );
}
