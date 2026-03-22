#!/usr/bin/env node
import { startSSEServer } from './sse.js';
import { getDb } from './db.js';
import { broadcast } from './sse.js';

const httpOnly = process.argv.includes('--http-only');

// Close any orphaned sessions left from a previous crash
// If the server died while sessions were active, they'll have no `end` timestamp
function cleanupOrphanedSessions() {
  const db = getDb();
  const now = new Date().toISOString();
  const orphaned = db.prepare('SELECT * FROM sessions WHERE end IS NULL').all() as Array<{ id: number; task_id: number }>;

  if (orphaned.length === 0) return;

  db.prepare('UPDATE sessions SET end = ? WHERE end IS NULL').run(now);

  // Set orphaned in_progress tasks back to paused
  const taskIds = [...new Set(orphaned.map(s => s.task_id))];
  for (const taskId of taskIds) {
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
    if (task?.status === 'in_progress') {
      db.prepare("UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ?").run(now, taskId);
      broadcast('task_updated', { entity: 'task', action: 'task_status_changed', payload: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) });
    }
  }
}

cleanupOrphanedSessions();

// Always start the HTTP/SSE server
startSSEServer();

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
