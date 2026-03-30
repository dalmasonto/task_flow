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
      'Derive the project name from the **folder name** of the current working directory (e.g. `/home/user/projects/my-app` → search for "my-app"). Use search_projects with that name. If 2–3 results match, **ask the user** which project to use — never guess.',
      'list_tasks status="in_progress" and status="blocked" for the confirmed project.',
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
      // Project discovery
      'The project name should be derived from the working directory folder name. Always search_projects first. If no match, create the project using create_project with the folder name. If multiple matches, present them to the user and ask which one to use.',

      // Task tracking
      'Proactively create tasks for ALL substantial work — features, bugs, refactors, AND debugging/investigation. Debugging is real work: create a task for it (e.g. "Debug: SSE connection dropping"), start a timer, and track it the same way you would a feature. search_tasks first to avoid duplicates. Link tasks to the confirmed project.',
      'Timer lifecycle: start_timer → work → stop_timer(final_status). Use "done"/"partial_done"/"blocked". pause_timer when waiting for input. This applies equally to debugging tasks — start a timer before investigating, stop it when resolved or blocked.',
      'MUST stop_timer with "done" when work is complete. Never leave finished tasks in "in_progress" or "paused". This includes debugging tasks — when the bug is fixed or the investigation concludes, stop the timer.',

      // Bugs & post-build debugging
      'When a user reports a bug or you discover one while testing/building: FIRST search_tasks for an existing related task. If found (even if "done"), move it back to in_progress (update_task_status) — this reopens the task and auto-starts a timer. Then log_debug on that task to document the new bug. If no related task exists, create a new one (e.g. "Bug: sidebar not rendering in light mode") with tag "bug", start the timer, and begin debugging.',
      'This also applies to post-build issues: after running a build/test and seeing failures, do NOT silently fix them. Open or reopen a task first, log what failed, then fix. The task becomes the paper trail — the user and future agents can see what broke, what was tried, and how it was resolved.',

      // Dependencies
      'Check task dependencies before starting. If any dep is incomplete, set task to "blocked".',
      'After completing a task, check if blocked tasks depending on it can be unblocked.',

      // Prioritization
      'When user is unsure what to work on: list_tasks priority="critical"/"high" status="not_started".',

      // Transparency — CRITICAL
      'ALWAYS tell the user what commands you are running and why. Before executing a shell command, state: "Running: `<command>`". After significant actions (file edits, installs, config changes), summarize what changed. The user must be able to reconstruct what happened from your messages alone — they should never wonder "what did the agent do?".',
      'When starting work, briefly state the approach: what you plan to do, which files you expect to touch, and what commands you will run. This gives the user a chance to course-correct before you act.',

      // Debug logging — comprehensive
      'ALWAYS log your work using log_debug. Log with a task_id when working on a specific task, or with project_id for project-level observations. Use log_debug as a running journal — it shows up in the Activity Pulse and on the project page so the user (and future agents) can follow your reasoning.',
      'What to log: **every stage** of your process. When you start investigating, when you form a hypothesis, when you read/edit a file, the exact commands you run (with output snippets), errors encountered, fixes attempted, and the resolution. Log the **path you took**, not just the destination.',
      'Log early and often — not just at the end. A debug log entry per significant step (e.g. "Read `sse.ts:57` — found the healthz route exists but is unreachable because..."). Use Markdown: `## headings` for stages, `` `code blocks` `` for errors/paths/commands, **bold** for key findings.',
      'For project-level notes (architecture decisions, setup gotchas, "how to run the app"), use log_debug with project_id instead of task_id. These appear on the project page and serve as living documentation.',

      // Formatting
      'Use Markdown in descriptions — headings, bullets, code blocks, bold. The UI renders it.',
    ],

    workflow: 'not_started → in_progress (start_timer) → paused (pause_timer) → done/partial_done/blocked (stop_timer)',

    tips: [
      'Filter by tags (list_tasks tag="bug"), search by keyword (search_tasks), get full detail (get_task id).',
      'get_analytics for time spent & completion rates. Dependencies show in the dependency graph.',
      'list_tasks/search_tasks return compact summaries. Use get_task(id) to read full descriptions.',
      'log_debug accepts task_id OR project_id — use project_id for project-wide notes visible on the project page.',
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
