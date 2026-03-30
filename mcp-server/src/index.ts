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

  // Background poller: watch for answered inbox messages and inject into terminal
  const agentPid = process.ppid; // Claude Code's PID
  const POLL_INTERVAL = 3000; // Check every 3 seconds

  setInterval(() => {
    try {
      const db = getDb();
      // Find messages answered since we last checked, for our agent
      const answered = db.prepare(
        `SELECT * FROM agent_messages WHERE agent_pid = ? AND status = 'answered' AND delivered IS NULL`
      ).all(agentPid) as Array<{ id: number; question: string; response: string }>;

      for (const msg of answered) {
        // Mark as delivered first to prevent re-injection
        db.prepare('UPDATE agent_messages SET delivered = 1 WHERE id = ?').run(msg.id);

        // Find our agent's PTY
        let ptsPath: string;
        try {
          ptsPath = require('child_process').execSync(`readlink /proc/${agentPid}/fd/0`).toString().trim();
        } catch { continue; }

        if (!ptsPath.startsWith('/dev/pts/')) continue;

        // Inject via TIOCSTI
        const text = `[Inbox Response] to "${msg.question.slice(0, 60)}": ${msg.response}`;
        try {
          require('child_process').execSync(
            `python3 -c "import os,fcntl,sys;fd=os.open(sys.argv[1],os.O_RDWR)\nfor c in sys.argv[2]+'\\\\n':fcntl.ioctl(fd,0x5412,c.encode())\nos.close(fd)" ${JSON.stringify(ptsPath)} ${JSON.stringify(text)}`,
            { stdio: 'ignore', timeout: 10000 }
          );
          console.error(`[inject] delivered response for message ${msg.id} to ${ptsPath}`);
        } catch (err) {
          console.error(`[inject] TIOCSTI failed for message ${msg.id}:`, err);
        }
      }
    } catch {
      // Silently ignore polling errors
    }
  }, POLL_INTERVAL);
}
