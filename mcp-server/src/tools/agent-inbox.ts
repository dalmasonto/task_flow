import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse, now, broadcastChange } from '../helpers.js';
import { addPending } from '../pending-questions.js';

export function registerAgentInboxTools(server: McpServer) {
  server.tool(
    'ask_user',
    'Post a question to the TaskFlow Agent Inbox and wait for the user to respond. By default blocks until the user replies from the UI — the response is returned directly. Set wait=false to return immediately and use check_response later. The question appears in the Agent Inbox UI with full context and optional quick-tap choices.',
    {
      project_id: z.number().describe('Project ID to attach the question to'),
      question: z.string().describe('The question to ask the user'),
      context: z.string().optional().describe('Markdown context — proposals, trade-offs, code snippets shown before the question'),
      choices: z.array(z.string()).optional().describe('Optional quick-tap choices, e.g. ["Yes", "No", "Skip"]'),
      wait: z.boolean().optional().default(true).describe('If true (default), block until the user responds. If false, return immediately with the message ID.'),
    },
    async (params) => {
      const db = getDb();

      // Validate project exists
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(params.project_id);
      if (!project) {
        return errorResponse(`Project ${params.project_id} not found`, 'NOT_FOUND');
      }

      const ts = now();
      const result = db.prepare(
        `INSERT INTO agent_messages (project_id, question, context, choices, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      ).run(
        params.project_id,
        params.question,
        params.context ?? null,
        params.choices ? JSON.stringify(params.choices) : null,
        ts,
      );

      const id = result.lastInsertRowid as number;
      const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);

      // Broadcast to UI
      broadcastChange('agent_message', 'agent_question', message);
      logActivity('agent_question', params.question, { entityType: 'agent_message', entityId: id });

      if (params.wait === false) {
        return successResponse({
          id,
          status: 'pending',
          message: `Question posted to Agent Inbox (id: ${id}). Use check_response(${id}) to check for their answer.`,
        });
      }

      // Block until user responds from the UI
      const response = await addPending(id);

      return successResponse({ id, response });
    },
  );

  server.tool(
    'check_response',
    'Check if the user has responded to a previously posted agent question. Returns the response if answered, or status "pending" if still waiting.',
    {
      message_id: z.number().describe('The agent message ID returned by ask_user'),
    },
    async (params) => {
      const db = getDb();

      const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(params.message_id) as Record<string, unknown> | undefined;
      if (!message) {
        return errorResponse(`Message ${params.message_id} not found`, 'NOT_FOUND');
      }

      if (message.status === 'answered') {
        return successResponse({
          id: message.id,
          status: 'answered',
          response: message.response,
          question: message.question,
          answered_at: message.answered_at,
        });
      }

      return successResponse({
        id: message.id,
        status: 'pending',
        question: message.question,
        message: 'User has not responded yet. Try again later or continue with other work.',
      });
    },
  );
}
