import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFileSync } from 'child_process';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse } from '../helpers.js';

interface AgentRow {
  name: string;
  tmux_pane: string | null;
  status: string;
  pid: number;
}

const MAX_KEYS_LENGTH = 200;

// Patterns that should never be sent via remote key injection
const BLOCKED_PATTERNS = [
  /^\s*!/,              // Claude Code shell escape (! command)
  /;\s*!/,              // shell escape after semicolon
];

/** Validate keys before sending — blocks shell escape patterns */
export function validateKeys(keys: string): string | null {
  if (keys.length > MAX_KEYS_LENGTH) {
    return `Keys too long (${keys.length} chars, max ${MAX_KEYS_LENGTH}) — potential injection`;
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(keys)) {
      return 'Blocked: shell escape pattern detected (! prefix). Use the terminal directly for shell commands.';
    }
  }
  return null; // valid
}

function getAgentPane(agentName: string, requireConnected = false): { agent: AgentRow; error?: undefined } | { agent?: undefined; error: ReturnType<typeof errorResponse> } {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(agentName) as AgentRow | undefined;
  if (!agent) return { error: errorResponse(`Agent "${agentName}" not found`, 'NOT_FOUND') };
  if (!agent.tmux_pane) return { error: errorResponse(`Agent "${agentName}" has no tmux pane`, 'VALIDATION_ERROR') };
  if (requireConnected && agent.status !== 'connected') {
    return { error: errorResponse(`Agent "${agentName}" is disconnected — sending keys to a bare shell is blocked for security`, 'VALIDATION_ERROR') };
  }
  return { agent };
}

export function registerTerminalTools(server: McpServer) {
  server.tool(
    'capture_terminal',
    'Capture the current terminal content of an agent\'s tmux pane. Returns the visible text on screen. Useful for seeing what prompts or output an agent is displaying.',
    {
      agent_name: z.string().describe('Name of the agent whose terminal to capture'),
    },
    { readOnlyHint: true },
    async (params) => {
      const result = getAgentPane(params.agent_name);
      if (result.error) return result.error;

      try {
        const output = execFileSync('tmux', ['capture-pane', '-p', '-S', '-', '-t', result.agent.tmux_pane!], { timeout: 5000 }).toString();
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
      keys: z.string().describe('The keys/text to send (e.g. "yes", "1", "y") or tmux key names (e.g. "Escape", "Up", "Down", "BTab")'),
      enter: z.boolean().optional().describe('Whether to press Enter after the keys (default: true)'),
      literal: z.boolean().optional().describe('Send as literal text with -l flag (default: true). Set false for tmux key names like Escape, Up, Down, Left, Right, BTab'),
    },
    { destructiveHint: true },
    async (params) => {
      const result = getAgentPane(params.agent_name, true);
      if (result.error) return result.error;

      // Validate keys for injection attacks
      const violation = validateKeys(params.keys);
      if (violation) return errorResponse(violation, 'VALIDATION_ERROR');

      const sendEnter = params.enter !== false;
      const isLiteral = params.literal !== false;

      try {
        const pane = result.agent.tmux_pane!;
        if (isLiteral) {
          // Send as literal text (like typing on a keyboard)
          execFileSync('tmux', ['send-keys', '-t', pane, '-l', params.keys], { stdio: 'ignore', timeout: 5000 });
          if (sendEnter) {
            execFileSync('tmux', ['send-keys', '-t', pane, 'Enter'], { stdio: 'ignore', timeout: 5000 });
          }
        } else {
          // Send as tmux key names (Escape, Up, Down, etc.)
          const args = ['send-keys', '-t', pane, params.keys];
          if (sendEnter) args.push('Enter');
          execFileSync('tmux', args, { stdio: 'ignore', timeout: 5000 });
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
