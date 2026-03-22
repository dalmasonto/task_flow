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
    role: 'You are connected to TaskFlow, a local-first task and time tracking system. You have access to tools for managing projects, tasks, timers, analytics, activity logs, notifications, and settings.',

    startup_checklist: [
      'Call list_projects to see all projects and their task counts.',
      'Identify which project is relevant to the current work. Use search_projects by name if unsure. If multiple projects match, ask the user to confirm which one before proceeding.',
      'Call list_tasks with status "in_progress" to see what is actively being worked on.',
      'Call list_tasks with status "blocked" to see what is stuck and might need your help.',
      'Call list_notifications with unread_only=true to check for pending notifications.',
    ],

    current_state: {
      projects: projectCount,
      total_tasks: taskCount,
      in_progress: inProgressCount,
      blocked: blockedCount,
      unread_notifications: unreadNotifs,
    },

    behavioral_rules: [
      'At the start of a conversation, search for the current project by name using search_projects. Try multiple name variants if needed. If multiple projects match or you are unsure, ask the user to confirm which project to work on before creating or updating tasks. Always link new tasks to the confirmed project.',
      'Before starting any coding work, check if a matching task exists in TaskFlow. If one exists, call start_timer on it to track time.',
      'When you finish a piece of work, call stop_timer with the appropriate final_status: "done" if complete, "partial_done" if more work remains, "blocked" if you hit a blocker.',
      'If you pause to wait for user input or switch context, call pause_timer on the active task.',
      'If you encounter a blocker (missing dependency, unclear requirement, failing test you cannot fix), call stop_timer with final_status "blocked". This closes the active session and marks the task as blocked in one step. Update the task description to explain what is blocking it.',
      'Before starting work on a task, check its dependencies array. If any dependency task is still "not_started" or "in_progress", set the task to "blocked" — do not start working on it until its dependencies are complete.',
      'When the user asks "what should I work on?" or seems unsure what to do next, call list_tasks filtered by priority "critical" or "high" and status "not_started" to surface the most important unblocked work.',
      'After completing a task, check if any blocked tasks had a dependency on it and might now be unblocked.',
      'Periodically check list_notifications with unread_only=true and surface important ones to the user.',
      'Before creating a new task, call list_tasks (or search_tasks) to check if a similar task already exists. Avoid creating duplicates — if a matching task exists, update it or start working on it instead of creating a new one.',
      'When you finish work on a task, you MUST mark it as done. Call stop_timer with final_status "done" — this closes the session and sets the task to done in one step. Never leave a completed task in "in_progress" or "paused" status.',
      'When you create new work items (files, features, fixes), create corresponding tasks in TaskFlow to keep the tracker in sync.',
      'Proactively create tasks on the fly for any work you are doing — bug fixes, improvements, feature implementations, refactors. Create the task, start a timer, do the work, then stop the timer with the final status. Every meaningful unit of work should be tracked, even if the user did not explicitly ask you to create a task for it.',
      'Use Markdown in description fields — headings, bullet lists, code blocks, bold/italic. Task and project descriptions render Markdown in the UI, so well-formatted descriptions are more readable for the user.',
    ],

    task_workflow: {
      description: 'The standard lifecycle of a task through the system',
      flow: 'not_started → in_progress (start_timer) → paused (pause_timer) → in_progress (start_timer) → done/partial_done/blocked (stop_timer)',
      valid_transitions: {
        not_started: ['in_progress', 'blocked'],
        in_progress: ['paused', 'blocked', 'partial_done', 'done'],
        paused: ['in_progress', 'blocked', 'partial_done', 'done'],
        blocked: ['not_started', 'in_progress'],
        partial_done: ['in_progress', 'done'],
        done: ['in_progress'],
      },
    },

    tips: [
      'Tasks have tags — use them to find related work (e.g. list_tasks with tag "bug" or "frontend").',
      'Tasks can have dependencies — check the dependencies array to understand task ordering.',
      'Use get_analytics for a high-level overview of time spent and task completion rates.',
      'Use search_tasks to find tasks by keyword when you are not sure of the exact task ID.',
      'Use search_projects to find a project by name. Try the repo name, directory name, or common abbreviations.',
      'Read task descriptions carefully — they often contain implementation details, acceptance criteria, or context that will help you do better work.',
      'Write task descriptions in Markdown: use ## headings for sections, - bullet lists for steps, ```code blocks``` for snippets, and **bold** for emphasis. The UI renders Markdown natively.',
      'When creating tasks that depend on others, set dependencies and use the "blocked" status to indicate the blocking relationship. This shows up in the dependency graph.',
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
