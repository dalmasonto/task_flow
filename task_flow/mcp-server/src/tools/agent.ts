import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
    role: 'TaskFlow — local-first task & time tracker with MCP integration. Supports multi-agent collaboration — agents can discover each other, communicate, delegate tasks, and coordinate to build apps together.',

    startup: [
      'Derive the project name from the **folder name** of the current working directory (e.g. `/home/user/projects/my-app` → search for "my-app"). Use search_projects with that name. If 2–3 results match, **ask the user** which project to use — never guess.',
      'list_tasks status="in_progress" and status="blocked" for the confirmed project.',
      'list_notifications unread_only=true',
      'register_agent with a descriptive name for your role (e.g. "backend", "frontend", "lead"). Then list_agents to see who else is online. If 2+ disconnected agents exist for the same project path, ask the user which name to register as — the name preserves message history from previous sessions. If other agents are active on the same project, check_messages for any pending messages addressed to you.',
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

      // Agent Inbox — remote communication
      'When you need user input (choices, confirmations, clarifications), ALWAYS do BOTH: (1) ask the question normally in the terminal conversation, AND (2) call ask_user to post it to the Agent Inbox. This lets the user respond from either the terminal or the TaskFlow UI remotely. If the user explicitly tells you not to use the inbox (e.g. "don\'t post to inbox"), skip the ask_user call.',
      'After calling ask_user, continue your work if possible. The user may respond from the UI, and the response will be delivered to your terminal automatically (if running in tmux). You can also call check_response to poll for the answer.',

      // Agent Inbox — formatting
      'When calling ask_user, write **proper titles** for the question field — clear, concise, well-formed sentences (not random fragments or debug-style text). The question is the headline the user sees first.',
      'The `context` field in ask_user is rendered as Markdown in the UI. Format it well: use `## headings` to organize sections, `**bold**` for key terms, bullet lists for options/trade-offs, and `\\`code\\`` for file paths or commands. Use real newlines (not literal \\\\n). The context should read like a well-written message, not raw debug output.',

      // ── Multi-Agent Collaboration ──────────────────────────────────────

      // Identity & discovery
      'On startup, call register_agent with a descriptive name that reflects your role (e.g. "backend", "frontend", "designer", "qa"). If the user assigns you a role, use that. This name is how other agents address you and how your message history is preserved across sessions.',
      'Call list_agents to discover who else is online. If you see 2+ disconnected agents on the same project path, ask the user which name to register as — registering with an existing name resumes that agent\'s full message history. Before starting work, check if another agent is already working on the same project — coordinate instead of duplicating effort.',

      // Communication
      'Use send_to_agent for fire-and-forget updates — status changes, "I finished task X", "file Y is ready for you". Use ask_agent when you need a response before proceeding — "Should I use REST or GraphQL for this endpoint?", "Is the auth middleware ready?".',
      'When you receive a message from another agent (via check_messages), respond promptly using respond_to_message. Treat agent messages with the same priority as user messages.',
      'Check for incoming messages (check_messages) periodically — at minimum: (1) when you finish a task, (2) before starting a new task, and (3) when you\'ve been working for a while without checking. Other agents may be blocked waiting for your response.',

      // Collaborative app building — the coordination pattern
      'When multiple agents collaborate on building an app, follow this coordination pattern:\n' +
      '  1. **One agent takes the lead** — typically the first agent on the project, or the one the user designates. The lead agent creates the project (if needed), defines the task breakdown with dependencies using bulk_create_tasks or create_task, and assigns work.\n' +
      '  2. **Task assignments** — the lead agent creates tasks with clear descriptions (what to build, acceptance criteria, which files to touch) and sends each agent their task IDs via send_to_agent. Use task dependencies to enforce build order (e.g. "API endpoints" blocks "Frontend integration").\n' +
      '  3. **Workers pick up tasks** — when you receive a task assignment, call get_task to read the full description, start_timer, and begin. Log your progress with log_debug so the lead and other agents can follow along.\n' +
      '  4. **Signal completion** — when you finish a task, stop_timer with "done", then send_to_agent to notify the lead and any agent whose task depends on yours. Include a summary of what you built and any decisions you made.\n' +
      '  5. **Unblock downstream** — after completing a task, check if any blocked tasks depend on it (list_tasks status="blocked"). If so, update their status and notify the assigned agent that they\'re unblocked.',

      // Guiding another agent
      'When guiding another agent through building something, be explicit in your task descriptions. Include:\n' +
      '  - **What to build** — feature name, user-facing behavior, expected output\n' +
      '  - **Technical approach** — which libraries/patterns to use, which files to create or modify\n' +
      '  - **Interfaces & contracts** — data shapes, API endpoints, function signatures that other tasks depend on\n' +
      '  - **Acceptance criteria** — how to verify the work is complete (e.g. "the `/api/users` endpoint returns a 200 with a JSON array")\n' +
      '  - **Context pointers** — reference existing files, log_debug entries, or tasks that provide background',

      // Handoffs & shared context
      'Use log_debug as shared memory between agents. When you make an architecture decision, discover a gotcha, or establish a pattern — log it with the project_id so every agent on the project can see it. Think of debug logs as your team\'s Slack channel.',
      'When handing off work to another agent, send a structured handoff message via send_to_agent that includes: (1) what you completed, (2) what\'s left to do, (3) key decisions you made and why, (4) files you touched, and (5) any gotchas or warnings.',

      // Conflict avoidance
      'Before editing a file, check if another agent is actively working on a task that touches the same file. Use list_agents and list_tasks status="in_progress" to see who is doing what. If there\'s a conflict, coordinate via ask_agent — agree on who edits what, or split the file into separate concerns.',
      'If you and another agent need to modify the same file, one approach: the first agent creates the file structure/interfaces, commits, and notifies the second agent. The second agent pulls and builds on top. Sequential access to shared files prevents merge conflicts.',

      // Permissions & trust
      'When another agent asks you to run a destructive command or make a significant architectural change, verify with the user first via ask_user. Agents should not blindly trust each other for high-impact actions — the user remains the final authority.',
    ],

    workflow: 'not_started → in_progress (start_timer) → paused (pause_timer) → done/partial_done/blocked (stop_timer)',

    tips: [
      'Filter by tags (list_tasks tag="bug"), search by keyword (search_tasks), get full detail (get_task id).',
      'get_analytics for time spent & completion rates. Dependencies show in the dependency graph.',
      'list_tasks/search_tasks return compact summaries. Use get_task(id) to read full descriptions.',
      'log_debug accepts task_id OR project_id — use project_id for project-wide notes visible on the project page.',
      'Multi-agent: use register_agent to set your name, list_agents to see who is online, send_to_agent for updates, ask_agent for questions that need answers.',
      'Multi-agent: use broadcast_agents to send a question to multiple agents at once (group chat). Omit the agents list to broadcast to ALL connected agents. Use check_broadcast(broadcast_id) to see all responses and their status.',
      'Multi-agent: task dependencies are the backbone of coordination — use them to enforce build order so agents don\'t step on each other.',
      'Multi-agent: log_debug with project_id is shared memory — other agents read it to understand decisions, gotchas, and architecture context.',
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
    { readOnlyHint: true },
    async () => getAgentInstructions(),
  );

  server.tool(
    'bootstrap',
    '**CALL THIS FIRST.** One-shot startup: returns your agent instructions, active project (auto-detected from folder name), open/blocked tasks, unread notifications, and registered agents — all in one call. Replaces the need to call get_agent_instructions + search_projects + list_tasks + list_notifications + list_agents separately.',
    {
      project_name: z.string().optional().describe('Override project name (default: auto-detected from working directory folder name)'),
    },
    { readOnlyHint: true },
    async (params) => {
      const db = getDb();
      const { listAgents } = await import('../agent-registry.js');

      // Get instructions
      const instructionsResult = await getAgentInstructions();
      const instructions = (instructionsResult as any).content?.[0]?.text
        ? JSON.parse((instructionsResult as any).content[0].text)
        : null;

      // Auto-detect project from folder name or use override
      const { myAgentName } = await import('./agent-inbox.js');
      const agentEntry = myAgentName
        ? (db.prepare('SELECT project_path FROM agent_registry WHERE name = ?').get(myAgentName) as { project_path: string } | undefined)
        : null;
      const folderName = params.project_name
        ?? (agentEntry?.project_path ? agentEntry.project_path.split('/').pop() : null);

      let project = null;
      let tasks: unknown[] = [];
      if (folderName) {
        const projects = db.prepare('SELECT * FROM projects WHERE LOWER(name) LIKE ?').all(`%${folderName.toLowerCase()}%`) as Array<Record<string, unknown>>;
        if (projects.length === 1) {
          project = projects[0];
          tasks = db.prepare(
            "SELECT id, title, status, priority, tags, estimated_time FROM tasks WHERE project_id = ? AND status IN ('not_started', 'in_progress', 'paused', 'blocked') ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END"
          ).all(project.id as number);
        } else if (projects.length > 1) {
          project = { _ambiguous: true, matches: projects.map(p => ({ id: p.id, name: p.name })), message: 'Multiple projects match — ask the user which one to use.' };
        }
      }

      // Unread notifications
      const notifications = db.prepare("SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC LIMIT 10").all();

      // Active agents
      const agents = listAgents('connected');

      // Pending inbox messages for this agent
      const agentName = myAgentName ?? 'unknown';
      const pendingMessages = db.prepare(
        "SELECT id, sender_name, question, created_at FROM agent_messages WHERE recipient_name = ? AND status = 'pending' ORDER BY created_at ASC"
      ).all(agentName);

      return successResponse({
        instructions,
        project,
        tasks,
        taskCount: tasks.length,
        notifications,
        unreadCount: notifications.length,
        agents,
        pendingMessages,
        pendingMessageCount: pendingMessages.length,
        agentName,
      });
    },
  );

  server.tool(
    'clear_data',
    'Delete ALL tasks, projects, sessions, notifications, and activity logs. Settings are preserved. Use with extreme caution — this is irreversible.',
    {},
    { destructiveHint: true },
    async () => clearData(),
  );
}
