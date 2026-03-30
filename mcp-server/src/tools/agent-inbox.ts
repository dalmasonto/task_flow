import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse, now, broadcastChange } from '../helpers.js';

export function registerAgentInboxTools(server: McpServer) {
  server.tool(
    'ask_user',
    'Post a question to the TaskFlow Agent Inbox for the user to answer remotely. Returns immediately with the message ID. The question appears in the Agent Inbox UI with full context and optional quick-tap choices. After posting, use check_response to retrieve the user\'s answer. Always tell the user you posted a question so they know to check the inbox.',
    {
      project_id: z.number().describe('Project ID to attach the question to'),
      question: z.string().describe('The question to ask the user'),
      context: z.string().optional().describe('Markdown context — proposals, trade-offs, code snippets shown before the question'),
      choices: z.array(z.string()).optional().describe('Optional quick-tap choices, e.g. ["Yes", "No", "Skip"]'),
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

      return successResponse({
        id,
        status: 'pending',
        message: `Question posted to Agent Inbox (id: ${id}). Use check_response(${id}) to retrieve the user's answer.`,
      });
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
