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
      'Before starting any coding work, check if a matching task exists in TaskFlow. If one exists, call start_timer on it to track time.',
      'When you finish a piece of work, call stop_timer with the appropriate final_status: "done" if complete, "partial_done" if more work remains, "blocked" if you hit a blocker.',
      'If you pause to wait for user input or switch context, call pause_timer on the active task.',
      'If you encounter a blocker (missing dependency, unclear requirement, failing test you cannot fix), call update_task_status to set the task to "blocked" and describe the issue in the task description.',
      'When the user asks "what should I work on?" or seems unsure what to do next, call list_tasks filtered by priority "critical" or "high" and status "not_started" to surface the most important unblocked work.',
      'After completing a task, check if any blocked tasks had a dependency on it and might now be unblocked.',
      'Periodically check list_notifications with unread_only=true and surface important ones to the user.',
      'When you create new work items (files, features, fixes), create corresponding tasks in TaskFlow to keep the tracker in sync.',
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
      'Read task descriptions carefully — they often contain implementation details, acceptance criteria, or context that will help you do better work.',
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
