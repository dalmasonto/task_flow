#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startSSEServer } from './sse.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTimerTools } from './tools/timer.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerActivityTools } from './tools/activity.js';
import { registerNotificationTools } from './tools/notifications.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerAgentTools } from './tools/agent.js';

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

startSSEServer();

const transport = new StdioServerTransport();
await server.connect(transport);
