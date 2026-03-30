import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse, now, broadcastChange } from '../helpers.js';
import { addPending } from '../pending-questions.js';

export function registerAgentInboxTools(server: McpServer) {
  server.tool(
    'ask_user',
    'Ask the user a question and block until they respond via the TaskFlow UI. Use this when you need user input and they may not be at their terminal. The question appears in the Agent Inbox with full context and optional quick-tap choices.',
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

      // Block until user responds
      const response = await addPending(id);

      return successResponse({ id, response });
    },
  );
}
