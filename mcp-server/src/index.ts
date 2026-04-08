#!/usr/bin/env node
import 'dotenv/config';
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
  const { registerTerminalTools } = await import('./tools/terminal.js');
  const { registerResources } = await import('./resources.js');
  const { registerCheckpointTools } = await import('./tools/checkpoint.js');

  const server = new McpServer({
    name: 'taskflow',
    version: '1.0.22',
  });

  // Wrap server.tool() to track execution time and log failures
  const originalTool = server.tool.bind(server);
  (server as any).tool = function (...args: any[]) {
    const toolName = args[0] as string;
    // Find the callback (always the last argument, and it's a function)
    const cbIndex = args.length - 1;
    const originalCb = args[cbIndex];
    if (typeof originalCb === 'function') {
      args[cbIndex] = async (...cbArgs: any[]) => {
        // Check task-scoped tool allowlists if a timer is active
        try {
          const db = getDb();
          const activeSession = db.prepare("SELECT task_id FROM sessions WHERE end IS NULL ORDER BY start DESC LIMIT 1").get() as { task_id: number } | undefined;
          if (activeSession) {
            const task = db.prepare("SELECT allowed_tools, denied_tools FROM tasks WHERE id = ?").get(activeSession.task_id) as { allowed_tools: string | null; denied_tools: string | null } | undefined;
            if (task) {
              if (task.denied_tools) {
                const denied = JSON.parse(task.denied_tools) as string[];
                if (denied.includes(toolName)) {
                  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `Tool "${toolName}" is denied for task #${activeSession.task_id}`, code: 'TOOL_DENIED' }) }] };
                }
              }
              if (task.allowed_tools) {
                const allowed = JSON.parse(task.allowed_tools) as string[];
                if (!allowed.includes(toolName)) {
                  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `Tool "${toolName}" is not in the allowlist for task #${activeSession.task_id}`, code: 'TOOL_NOT_ALLOWED' }) }] };
                }
              }
            }
          }
        } catch { /* don't break tool execution on allowlist check failure */ }

        const start = Date.now();
        try {
          const result = await originalCb(...cbArgs);
          const duration = Date.now() - start;
          // Record execution and broadcast event
          try {
            const ts = new Date().toISOString();
            const db = getDb();
            db.prepare('INSERT INTO tool_executions (tool_name, duration_ms, success, created_at) VALUES (?, ?, 1, ?)').run(toolName, duration, ts);
            broadcast('tool_executed', { entity: 'tool', action: 'tool_executed', payload: { tool_name: toolName, duration_ms: duration, success: true, created_at: ts } });
          } catch { /* don't break tool execution */ }
          return result;
        } catch (err: any) {
          const duration = Date.now() - start;
          try {
            const ts = new Date().toISOString();
            const db = getDb();
            db.prepare('INSERT INTO tool_executions (tool_name, duration_ms, success, error_message, created_at) VALUES (?, ?, 0, ?, ?)').run(toolName, duration, err.message ?? String(err), ts);
            broadcast('tool_failed', { entity: 'tool', action: 'tool_failed', payload: { tool_name: toolName, duration_ms: duration, success: false, error: err.message, created_at: ts } });
          } catch { /* don't break tool execution */ }
          throw err;
        }
      };
    }
    return (originalTool as Function).apply(server, args);
  };

  registerAgentTools(server);
  registerTaskTools(server);
  registerProjectTools(server);
  registerTimerTools(server);
  registerAnalyticsTools(server);
  registerActivityTools(server);
  registerNotificationTools(server);
  registerSettingsTools(server);
  registerAgentInboxTools(server);
  registerTerminalTools(server);
  registerCheckpointTools(server);
  registerResources(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const { registerAgent, unregisterAgent } = await import('./agent-registry.js');
  const { setAgentName } = await import('./tools/agent-inbox.js');

  // Auto-register this agent and sync name to agent-inbox tools
  const agentName = registerAgent();
  setAgentName(agentName);
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
