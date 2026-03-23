import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db.js';
import { logActivity, successResponse, broadcastChange } from '../helpers.js';

// ─── exported handler functions ───────────────────────────────────────

export async function getAgentInstructions() {
  const db = getDb();

  // Gather live context to include in the instructions
  const projectCount = (db.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c;
  const taskCount = (db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;
  const inProgressCount = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'in_progress'").get() as { c: number }).c;
  const blockedCount = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'blocked'").get() as { c: number }).c;
  const unreadNotifs = (db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE read = 0').get() as { c: number }).c;

  const instructions = {
    role: 'TaskFlow — local-first task & time tracker with MCP integration.',

    startup: [
      'search_projects to find the current project (try name variants; confirm with user if ambiguous)',
      'list_tasks status="in_progress" and status="blocked"',
      'list_notifications unread_only=true',
    ],

    state: {
      projects: projectCount,
      tasks: taskCount,
      in_progress: inProgressCount,
      blocked: blockedCount,
      unread: unreadNotifs,
    },

    rules: [
      // Task tracking
      'Proactively create tasks for ALL substantial work (features, bugs, refactors). search_tasks first to avoid duplicates. Link tasks to the confirmed project.',
      'Timer lifecycle: start_timer → work → stop_timer(final_status). Use "done"/"partial_done"/"blocked". pause_timer when waiting for input.',
      'MUST stop_timer with "done" when work is complete. Never leave finished tasks in "in_progress" or "paused".',
      // Dependencies
      'Check task dependencies before starting. If any dep is incomplete, set task to "blocked".',
      'After completing a task, check if blocked tasks depending on it can be unblocked.',
      // Prioritization
      'When user is unsure what to work on: list_tasks priority="critical"/"high" status="not_started".',
      // Logging
      'Use log_debug with task_id to record debugging steps, hypotheses, findings, decisions. Use Markdown formatting.',
      // Formatting
      'Use Markdown in descriptions — headings, bullets, code blocks, bold. The UI renders it.',
    ],

    workflow: 'not_started → in_progress (start_timer) → paused (pause_timer) → done/partial_done/blocked (stop_timer)',

    tips: [
      'Filter by tags (list_tasks tag="bug"), search by keyword (search_tasks), get full detail (get_task id).',
      'get_analytics for time spent & completion rates. Dependencies show in the dependency graph.',
      'list_tasks/search_tasks return compact summaries. Use get_task(id) to read full descriptions.',
    ],
  };

  return successResponse(instructions);
}

export async function clearData() {
  const db = getDb();
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM tasks');
  db.exec('DELETE FROM projects');
  db.exec('DELETE FROM notifications');
  db.exec('DELETE FROM activity_logs');
  logActivity('data_cleared', 'All data cleared', { entityType: 'system' });
  broadcastChange('system', 'data_cleared', {});
  return successResponse({ cleared: true, message: 'All tasks, projects, sessions, notifications, and activity logs deleted. Settings preserved.' });
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerAgentTools(server: McpServer) {
  server.tool(
    'get_agent_instructions',
    '**Call this at the start of every conversation.** Returns onboarding instructions, behavioral rules, and live project context for AI agents working with TaskFlow. This tool tells you how to proactively manage tasks, track time, and stay in sync with the project.',
    {},
    async () => getAgentInstructions(),
  );

  server.tool(
    'clear_data',
    'Delete ALL tasks, projects, sessions, notifications, and activity logs. Settings are preserved. Use with extreme caution — this is irreversible.',
    {},
    async () => clearData(),
  );
}
