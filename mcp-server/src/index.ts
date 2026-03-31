#!/usr/bin/env node
import { startSSEServer } from './sse.js';
import { getDb } from './db.js';
import { broadcast } from './sse.js';

const httpOnly = process.argv.includes('--http-only');

// Close orphaned sessions left from a previous crash.
// Uses a grace period so that sessions from the current conversation
// (stdio transport restarts the server on each tool call) are preserved.
const ORPHAN_GRACE_MS = 5 * 60 * 1000; // 5 minutes

function cleanupOrphanedSessions() {
  const db = getDb();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - ORPHAN_GRACE_MS).toISOString();

  // Only close sessions that started more than ORPHAN_GRACE_MS ago
  const orphaned = db.prepare('SELECT * FROM sessions WHERE end IS NULL AND start < ?').all(cutoff) as Array<{ id: number; task_id: number; start: string }>;

  if (orphaned.length === 0) return;

  // Close each orphaned session with end = now (preserves the real elapsed time)
  for (const session of orphaned) {
    db.prepare('UPDATE sessions SET end = ? WHERE id = ?').run(nowIso, session.id);
  }

  // Set orphaned in_progress tasks back to paused
  const taskIds = [...new Set(orphaned.map(s => s.task_id))];
  for (const taskId of taskIds) {
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
    if (task?.status === 'in_progress') {
      db.prepare("UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ?").run(nowIso, taskId);
      broadcast('task_updated', { entity: 'task', action: 'task_status_changed', payload: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) });
    }
  }
}

cleanupOrphanedSessions();

// Always start the HTTP/SSE server (probes for existing instances, finds fallback port)
await startSSEServer();

// Liveness checker — periodically check registered agents and mark dead ones
setInterval(async () => {
  try {
    const { checkAgentLiveness } = await import('./agent-registry.js');
    checkAgentLiveness();
  } catch { /* ignore */ }
}, 30_000);

// Only start MCP stdio transport when not in http-only mode
if (!httpOnly) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { registerTaskTools } = await import('./tools/tasks.js');
  const { registerProjectTools } = await import('./tools/projects.js');
  const { registerTimerTools } = await import('./tools/timer.js');
  const { registerAnalyticsTools } = await import('./tools/analytics.js');
  const { registerActivityTools } = await import('./tools/activity.js');
  const { registerNotificationTools } = await import('./tools/notifications.js');
  const { registerSettingsTools } = await import('./tools/settings.js');
  const { registerAgentTools } = await import('./tools/agent.js');
  const { registerAgentInboxTools } = await import('./tools/agent-inbox.js');

  const server = new McpServer({
    name: 'taskflow',
    version: '1.0.0',
  });

  registerAgentTools(server);
  registerTaskTools(server);
  registerProjectTools(server);
  registerTimerTools(server);
  registerAnalyticsTools(server);
  registerActivityTools(server);
  registerNotificationTools(server);
  registerSettingsTools(server);
  registerAgentInboxTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const { registerAgent, unregisterAgent } = await import('./agent-registry.js');

  // Auto-register this agent
  const agentName = registerAgent();
  console.error(`[agent] registered as "${agentName}"`);

  // Graceful shutdown — mark agent as disconnected
  const cleanup = () => { try { unregisterAgent(agentName); } catch {} process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Background poller: deliver messages to this agent's terminal via tmux
  const POLL_INTERVAL = 3000;
  const agentPid = process.ppid;

  let tmuxTarget: string | null = null;
  try {
    const { execSync: exec } = await import('child_process');
    const ptsPath = exec(`readlink /proc/${agentPid}/fd/0`).toString().trim();
    const panes = exec('tmux list-panes -a -F "#{pane_id} #{pane_tty}"').toString().trim().split('\n');
    for (const line of panes) {
      const [paneId, paneTty] = line.split(' ');
      if (paneTty === ptsPath) { tmuxTarget = paneId; break; }
    }
    if (tmuxTarget) console.error(`[inject] tmux pane ${tmuxTarget} for agent "${agentName}"`);
    else console.error('[inject] agent not in tmux — terminal injection disabled');
  } catch {
    console.error('[inject] tmux not available');
  }

  if (tmuxTarget) {
    const { execSync: exec } = await import('child_process');
    const target = tmuxTarget;

    setInterval(() => {
      try {
        const db = getDb();
        // Check for messages addressed to this agent (from user or other agents)
        // AND for answered questions this agent sent (inbox responses)
        // Check by agent name AND by agent_pid (backward compat with old messages)
        const incoming = db.prepare(
          `SELECT * FROM agent_messages WHERE delivered IS NULL AND (
            (recipient_name = ? AND status = 'pending') OR
            (sender_name = ? AND recipient_name = 'user' AND status = 'answered') OR
            (agent_pid = ? AND recipient_name = 'user' AND status = 'answered')
          )`
        ).all(agentName, agentName, agentPid) as Array<{ id: number; sender_name: string; recipient_name: string; question: string; response: string | null; status: string }>;

        for (const msg of incoming) {
          db.prepare('UPDATE agent_messages SET delivered = 1 WHERE id = ?').run(msg.id);

          let text: string;
          if (msg.recipient_name === agentName && msg.sender_name === 'user') {
            text = `[Message from User]: ${msg.question}`;
          } else if (msg.recipient_name === agentName && msg.sender_name !== 'user') {
            text = `[Message from ${msg.sender_name}]: ${msg.question}`;
          } else if (msg.status === 'answered' && msg.response) {
            text = `[Inbox Response] to "${msg.question.slice(0, 60)}": ${msg.response}`;
          } else {
            continue;
          }

          try {
            exec(`tmux send-keys -t ${target} ${JSON.stringify(text)} Enter`, { stdio: 'ignore', timeout: 5000 });
            console.error(`[inject] delivered message ${msg.id} to tmux pane ${target}`);
          } catch (err) {
            console.error(`[inject] tmux send-keys failed for message ${msg.id}:`, err);
          }
        }
      } catch { /* ignore */ }
    }, POLL_INTERVAL);
  }
}
