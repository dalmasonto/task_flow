import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import crypto from 'crypto';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse, now, broadcastChange } from '../helpers.js';
import { registerAgent as doRegister, getAgent, listAgents } from '../agent-registry.js';

/** The name assigned to this agent after registration */
let myAgentName: string | null = null;

/** Set the agent name from external registration (index.ts).
 *  This prevents double-registration when index.ts registers at startup
 *  and ensureRegistered() would register again on first tool call.
 */
export function setAgentName(name: string): void {
  myAgentName = name;
}

/** Get or auto-register the agent name.
 *  Verifies the cached registration is still valid — if the liveness
 *  checker disconnected us while sleeping, re-register to reclaim identity.
 */
function ensureRegistered(): string {
  if (myAgentName) {
    // Verify our registration is still active
    const agent = getAgent(myAgentName);
    if (agent && agent.status === 'connected' && agent.pid === process.ppid) {
      return myAgentName;
    }
    // Stale — re-register
    myAgentName = null;
  }
  myAgentName = doRegister();
  return myAgentName;
}

export { myAgentName };

/** Get the current agent name — used by tmux bridge to track renames */
export function getAgentName(): string {
  return myAgentName || 'unknown';
}

export function registerAgentInboxTools(server: McpServer) {
  server.tool(
    'register_agent',
    'Register this agent with a custom name. Optional — agents auto-register on startup using the project folder name. Call this only if you want a specific name.',
    {
      name: z.string().optional().describe('Custom agent name. If omitted, uses the project folder name.'),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (params) => {
      myAgentName = doRegister({ customName: params.name });
      return successResponse({ name: myAgentName, message: `Registered as "${myAgentName}"` });
    },
  );

  server.tool(
    'ask_user',
    'Post a question to the TaskFlow Agent Inbox for the user to answer remotely. Returns immediately with the message ID. The question appears in the Agent Inbox UI with full context and optional quick-tap choices. After posting, use check_response to retrieve the user\'s answer. Always tell the user you posted a question so they know to check the inbox.',
    {
      project_id: z.number().describe('Project ID to attach the question to'),
      question: z.string().describe('The question to ask the user'),
      context: z.string().optional().describe('Markdown context — proposals, trade-offs, code snippets shown before the question'),
      choices: z.array(z.string()).optional().describe('Optional quick-tap choices, e.g. ["Yes", "No", "Skip"]'),
    },
    { readOnlyHint: false },
    async (params) => {
      const db = getDb();
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(params.project_id);
      if (!project) return errorResponse(`Project ${params.project_id} not found`, 'NOT_FOUND');

      const senderName = ensureRegistered();
      const ts = now();
      const result = db.prepare(
        `INSERT INTO agent_messages (project_id, question, context, choices, sender_name, recipient_name, agent_pid, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'user', ?, 'mcp', 'pending', ?)`
      ).run(
        params.project_id,
        params.question,
        params.context ?? null,
        params.choices ? JSON.stringify(params.choices) : null,
        senderName,
        process.ppid,
        ts,
      );

      const id = result.lastInsertRowid as number;
      const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
      broadcastChange('agent_message', 'agent_question', message);
      logActivity('agent_question', params.question, { entityType: 'agent_message', entityId: id });

      return successResponse({
        id,
        status: 'pending',
        sender: senderName,
        message: `Question posted to Agent Inbox (id: ${id}). Use check_response(${id}) to retrieve the user's answer.`,
      });
    },
  );

  server.tool(
    'check_response',
    'Check if a previously posted question (via ask_user or ask_agent) has been answered. Returns the response if answered, or status "pending" if still waiting.',
    {
      message_id: z.number().describe('The message ID returned by ask_user or ask_agent'),
    },
    { readOnlyHint: true },
    async (params) => {
      const db = getDb();
      const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(params.message_id) as Record<string, unknown> | undefined;
      if (!message) return errorResponse(`Message ${params.message_id} not found`, 'NOT_FOUND');

      if (message.status === 'answered') {
        return successResponse({
          id: message.id, status: 'answered', response: message.response,
          respondedBy: message.recipient_name,
          question: message.question, answered_at: message.answered_at,
        });
      }
      return successResponse({
        id: message.id, status: 'pending', question: message.question,
        recipient: message.recipient_name,
        message: 'No response yet. Try again later or continue with other work.',
      });
    },
  );

  server.tool(
    'send_to_agent',
    'Send a message to another agent by name. Returns immediately. The recipient agent will receive the message in their terminal (if running in tmux).',
    {
      recipient: z.string().describe('Name of the target agent (e.g. "backend", "task_flow:2")'),
      message: z.string().describe('The message to send'),
      context: z.string().optional().describe('Optional markdown context'),
    },
    { readOnlyHint: false },
    async (params) => {
      const db = getDb();
      const senderName = ensureRegistered();

      const recipient = getAgent(params.recipient);
      if (!recipient) return errorResponse(`Agent "${params.recipient}" not found`, 'NOT_FOUND');

      const ts = now();
      const result = db.prepare(
        `INSERT INTO agent_messages (project_id, question, context, sender_name, recipient_name, source, status, created_at)
         VALUES (NULL, ?, ?, ?, ?, 'mcp', 'pending', ?)`
      ).run(params.message, params.context ?? null, senderName, params.recipient, ts);

      const id = result.lastInsertRowid as number;
      const msg = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
      broadcastChange('agent_message', 'agent_question', msg);

      return successResponse({ id, sender: senderName, recipient: params.recipient, status: 'pending' });
    },
  );

  server.tool(
    'ask_agent',
    'Ask another agent a question and wait for their response. Like ask_user but targets an agent. Returns the message ID — use check_response to poll for the answer. The recipient agent receives the question in their terminal (if in tmux) and can respond with respond_to_message.',
    {
      recipient: z.string().describe('Name of the target agent (e.g. "backend", "task_flow:2")'),
      question: z.string().describe('The question to ask'),
      context: z.string().optional().describe('Markdown context — background info, code snippets, proposals'),
      choices: z.array(z.string()).optional().describe('Optional quick-tap choices, e.g. ["Yes", "No", "Skip"]'),
      project_id: z.number().optional().describe('Optional project ID to attach the question to'),
    },
    { readOnlyHint: false },
    async (params) => {
      const db = getDb();
      const senderName = ensureRegistered();

      const recipient = getAgent(params.recipient);
      if (!recipient) return errorResponse(`Agent "${params.recipient}" not found or not connected`, 'NOT_FOUND');

      const ts = now();
      const result = db.prepare(
        `INSERT INTO agent_messages (project_id, question, context, choices, sender_name, recipient_name, agent_pid, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'mcp', 'pending', ?)`
      ).run(
        params.project_id ?? null,
        params.question,
        params.context ?? null,
        params.choices ? JSON.stringify(params.choices) : null,
        senderName,
        params.recipient,
        process.ppid,
        ts,
      );

      const id = result.lastInsertRowid as number;
      const msg = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
      broadcastChange('agent_message', 'agent_question', msg);
      logActivity('agent_question', `Asked ${params.recipient}: ${params.question}`, { entityType: 'agent_message', entityId: id });

      return successResponse({
        id,
        status: 'pending',
        sender: senderName,
        recipient: params.recipient,
        message: `Question sent to "${params.recipient}" (id: ${id}). Use check_response(${id}) to retrieve their answer.`,
      });
    },
  );

  server.tool(
    'respond_to_message',
    'Respond to a pending message addressed to this agent. Use check_messages to see incoming messages, then respond by message ID.',
    {
      message_id: z.number().describe('The message ID to respond to (from check_messages)'),
      response: z.string().describe('Your response text'),
    },
    { readOnlyHint: false },
    async (params) => {
      const db = getDb();
      const name = ensureRegistered();

      const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(params.message_id) as Record<string, unknown> | undefined;
      if (!message) return errorResponse(`Message ${params.message_id} not found`, 'NOT_FOUND');
      if (message.recipient_name !== name) return errorResponse(`Message ${params.message_id} is not addressed to you`, 'VALIDATION_ERROR');
      if (message.status !== 'pending') return errorResponse(`Message ${params.message_id} is already ${message.status}`, 'VALIDATION_ERROR');

      const ts = now();
      db.prepare('UPDATE agent_messages SET response = ?, status = ?, answered_at = ?, delivered = NULL WHERE id = ?')
        .run(params.response, 'answered', ts, params.message_id);

      const updated = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(params.message_id);
      broadcastChange('agent_message', 'agent_question_answered', updated);
      logActivity('agent_question_answered', `Responded to ${message.sender_name}: ${params.response.slice(0, 80)}`, { entityType: 'agent_message', entityId: params.message_id });

      return successResponse({
        id: params.message_id,
        status: 'answered',
        sender: message.sender_name,
        message: `Response sent to "${message.sender_name}".`,
      });
    },
  );

  server.tool(
    'check_messages',
    'Check for incoming messages from users or other agents addressed to this agent.',
    {},
    { readOnlyHint: true },
    async () => {
      const db = getDb();
      const name = ensureRegistered();
      const messages = db.prepare(
        `SELECT * FROM agent_messages WHERE recipient_name = ? AND status = 'pending' ORDER BY created_at ASC`
      ).all(name) as Array<Record<string, unknown>>;

      return successResponse({
        agent: name,
        count: messages.length,
        messages: messages.map(m => ({
          id: m.id, sender: m.sender_name, question: m.question,
          context: m.context, choices: m.choices ? JSON.parse(m.choices as string) : null,
          created_at: m.created_at,
        })),
      });
    },
  );

  server.tool(
    'list_agents',
    'List registered agents with their status, project path, and connection info.',
    {
      status: z.enum(['connected', 'disconnected']).optional().describe('Filter by status. Omit for all agents.'),
    },
    { readOnlyHint: true },
    async (params) => {
      const agents = listAgents(params.status);
      return successResponse(agents);
    },
  );

  server.tool(
    'broadcast_agents',
    'Send a question to multiple agents simultaneously. Creates a group message — each agent gets their own copy linked by a shared broadcast ID. Use check_broadcast to see all responses. Optional: omit agents list to broadcast to ALL connected agents.',
    {
      question: z.string().describe('The question to broadcast'),
      agents: z.array(z.string()).optional().describe('Agent names to send to. If omitted, sends to all connected agents.'),
      context: z.string().optional().describe('Markdown context shown before the question'),
      choices: z.array(z.string()).optional().describe('Optional quick-tap choices'),
      project_id: z.number().optional().describe('Optional project ID to attach the messages to'),
    },
    { readOnlyHint: false },
    async (params) => {
      const db = getDb();
      const senderName = ensureRegistered();

      // Resolve recipients
      let recipients: string[];
      if (params.agents && params.agents.length > 0) {
        for (const name of params.agents) {
          const agent = getAgent(name);
          if (!agent) return errorResponse(`Agent "${name}" not found`, 'NOT_FOUND');
        }
        recipients = params.agents;
      } else {
        const connected = listAgents('connected');
        recipients = connected
          .map((a) => a.name)
          .filter((n: string) => n !== senderName);
        if (recipients.length === 0) return errorResponse('No other connected agents to broadcast to', 'VALIDATION_ERROR');
      }

      if (params.project_id) {
        const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(params.project_id);
        if (!project) return errorResponse(`Project ${params.project_id} not found`, 'NOT_FOUND');
      }

      const broadcastId = crypto.randomUUID();
      const ts = now();
      const messageIds: number[] = [];

      for (const recipient of recipients) {
        const result = db.prepare(
          `INSERT INTO agent_messages (project_id, question, context, choices, sender_name, recipient_name, agent_pid, source, status, broadcast_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'mcp', 'pending', ?, ?)`
        ).run(
          params.project_id ?? null,
          params.question,
          params.context ?? null,
          params.choices ? JSON.stringify(params.choices) : null,
          senderName,
          recipient,
          process.ppid,
          broadcastId,
          ts,
        );
        const id = result.lastInsertRowid as number;
        messageIds.push(id);

        const msg = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
        broadcastChange('agent_message', 'agent_question', msg);
      }

      logActivity('agent_broadcast', `Broadcast to ${recipients.length} agents: ${params.question.slice(0, 80)}`, { entityType: 'agent_message' });

      return successResponse({
        broadcastId,
        recipients,
        messageIds,
        count: recipients.length,
        message: `Broadcast sent to ${recipients.length} agents. Use check_broadcast("${broadcastId}") to see responses.`,
      });
    },
  );

  server.tool(
    'check_broadcast',
    'Check the status of a broadcast message — shows which agents have responded and their answers.',
    {
      broadcast_id: z.string().describe('The broadcast ID returned by broadcast_agents'),
    },
    { readOnlyHint: true },
    async (params) => {
      const db = getDb();
      const messages = db.prepare(
        'SELECT * FROM agent_messages WHERE broadcast_id = ? ORDER BY created_at ASC'
      ).all(params.broadcast_id) as Array<Record<string, unknown>>;

      if (messages.length === 0) return errorResponse(`No messages found for broadcast ${params.broadcast_id}`, 'NOT_FOUND');

      const total = messages.length;
      const answered = messages.filter(m => m.status === 'answered').length;
      const pending = messages.filter(m => m.status === 'pending').length;

      return successResponse({
        broadcastId: params.broadcast_id,
        question: messages[0].question,
        total,
        answered,
        pending,
        responses: messages.map(m => ({
          id: m.id,
          recipient: m.recipient_name,
          status: m.status,
          response: m.response ?? null,
          answered_at: m.answered_at ?? null,
        })),
      });
    },
  );
}
