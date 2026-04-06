import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse } from '../helpers.js';

interface AgentRow {
  name: string;
  tmux_pane: string | null;
  status: string;
  pid: number;
}

function getAgentPane(agentName: string): { agent: AgentRow; error?: undefined } | { agent?: undefined; error: ReturnType<typeof errorResponse> } {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(agentName) as AgentRow | undefined;
  if (!agent) return { error: errorResponse(`Agent "${agentName}" not found`, 'NOT_FOUND') };
  if (!agent.tmux_pane) return { error: errorResponse(`Agent "${agentName}" has no tmux pane`, 'VALIDATION_ERROR') };
  return { agent };
}

export function registerTerminalTools(server: McpServer) {
  server.tool(
    'capture_terminal',
    'Capture the current terminal content of an agent\'s tmux pane. Returns the visible text on screen. Useful for seeing what prompts or output an agent is displaying.',
    {
      agent_name: z.string().describe('Name of the agent whose terminal to capture'),
    },
    async (params) => {
      const result = getAgentPane(params.agent_name);
      if (result.error) return result.error;

      try {
        const output = execSync(`tmux capture-pane -p -t ${result.agent.tmux_pane}`, { timeout: 5000 }).toString();
        return successResponse({
          agent: params.agent_name,
          pane: result.agent.tmux_pane,
          content: output,
        });
      } catch (err: any) {
        return errorResponse(`Failed to capture pane: ${err.message}`, 'VALIDATION_ERROR');
      }
    },
  );

  server.tool(
    'send_keys',
    'Send raw keystrokes to an agent\'s tmux pane. Use this to respond to interactive prompts (yes/no, numbered choices, permission approvals) displayed in an agent\'s terminal. By default appends Enter after the keys.',
    {
      agent_name: z.string().describe('Name of the agent whose terminal to send keys to'),
      keys: z.string().describe('The keys/text to send (e.g. "yes", "1", "y")'),
      enter: z.boolean().optional().describe('Whether to press Enter after the keys (default: true)'),
    },
    async (params) => {
      const result = getAgentPane(params.agent_name);
      if (result.error) return result.error;

      const sendEnter = params.enter !== false;

      try {
        if (sendEnter) {
          execSync(`tmux send-keys -t ${result.agent.tmux_pane} ${JSON.stringify(params.keys)} Enter`, { stdio: 'ignore', timeout: 5000 });
        } else {
          execSync(`tmux send-keys -t ${result.agent.tmux_pane} ${JSON.stringify(params.keys)}`, { stdio: 'ignore', timeout: 5000 });
        }

        logActivity('terminal_send_keys', `Sent keys to ${params.agent_name}: ${params.keys.slice(0, 50)}`, { entityType: 'agent' });

        return successResponse({
          agent: params.agent_name,
          pane: result.agent.tmux_pane,
          keys: params.keys,
          enter: sendEnter,
          sent: true,
        });
      } catch (err: any) {
        return errorResponse(`Failed to send keys: ${err.message}`, 'VALIDATION_ERROR');
      }
    },
  );
}
