#!/usr/bin/env node
import { getConfig } from './config.js';
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
const cfg = getConfig();
setInterval(async () => {
  try {
    const { checkAgentLiveness } = await import('./agent-registry.js');
    checkAgentLiveness();
  } catch { /* ignore */ }
}, cfg.agentLivenessInterval);

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
  const agentPid = process.ppid;
  console.error(`[agent] registered as "${agentName}"`);

  let cleanup: () => void = () => { try { unregisterAgent(agentName); } catch {} process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Tmux bridge: SSE listener for instant delivery + capture for terminal→chat
  let tmuxTarget: string | null = null;
  try {
    const { execSync: exec } = await import('child_process');
    const ptsPath = exec(`readlink /proc/${agentPid}/fd/0`).toString().trim();
    const panes = exec('tmux list-panes -a -F "#{pane_id} #{pane_tty}"').toString().trim().split('\n');
    for (const line of panes) {
      const [paneId, paneTty] = line.split(' ');
      if (paneTty === ptsPath) { tmuxTarget = paneId; break; }
    }
  } catch {
    console.error('[bridge] tmux not available');
  }

  if (tmuxTarget) {
    const { startTmuxBridge } = await import('./tmux-bridge.js');
    const stopBridge = startTmuxBridge({
      agentName,
      agentPid,
      tmuxPane: tmuxTarget,
    });

    const originalCleanup = cleanup;
    cleanup = () => { stopBridge(); originalCleanup(); };
    process.removeListener('SIGINT', originalCleanup);
    process.removeListener('SIGTERM', originalCleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } else {
    console.error('[bridge] agent not in tmux — bridge disabled');
  }
}
