import { execSync } from 'child_process';
import { getDb } from './db.js';
import { getActivePort } from './sse.js';
import http from 'http';

interface BridgeOptions {
  agentName: string;
  agentPid: number;
  tmuxPane: string;
}

// ─── SSE Listener (replaces the 3s poller) ───────────────────────────

function startSSEListener(options: BridgeOptions): void {
  const { agentName, agentPid, tmuxPane } = options;
  const port = getActivePort();

  function connect() {
    const req = http.get(`http://localhost:${port}/events`, (res) => {
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSEEvent(eventType, data, options);
            } catch { /* malformed JSON */ }
            eventType = '';
          }
        }
      });

      res.on('end', () => {
        console.error('[bridge] SSE connection closed, reconnecting in 3s...');
        setTimeout(connect, 3000);
      });

      res.on('error', () => {
        console.error('[bridge] SSE connection error, reconnecting in 3s...');
        setTimeout(connect, 3000);
      });
    });

    req.on('error', () => {
      console.error('[bridge] SSE connect failed, retrying in 3s...');
      setTimeout(connect, 3000);
    });
  }

  // Initial sweep: deliver any undelivered messages from before SSE connected
  deliverUndelivered(options);

  connect();
}

function handleSSEEvent(event: string, data: { payload?: Record<string, unknown> }, options: BridgeOptions): void {
  const { agentName, agentPid, tmuxPane } = options;
  const payload = data.payload;
  if (!payload) return;

  if (event === 'agent_question') {
    const recipient = payload.recipient_name as string;
    const sender = payload.sender_name as string;
    const status = payload.status as string;
    const id = payload.id as number;
    const delivered = payload.delivered as number | null;

    if (recipient !== agentName || status !== 'pending' || delivered === 1) return;

    let text: string;
    if (sender === 'user') {
      text = `[Message from User]: ${payload.question}`;
    } else {
      text = `[Message from ${sender}]: ${payload.question}`;
    }

    injectAndMarkDelivered(id, text, tmuxPane);
  }

  if (event === 'agent_question_answered') {
    const sender = payload.sender_name as string;
    const recipient = payload.recipient_name as string;
    const status = payload.status as string;
    const id = payload.id as number;
    const delivered = payload.delivered as number | null;
    const agentPidField = payload.agent_pid as number | null;

    const isOurs = sender === agentName || agentPidField === agentPid;
    if (!isOurs || status !== 'answered' || delivered === 1) return;

    const question = (payload.question as string || '').slice(0, 60);
    const response = payload.response as string;
    const text = `[Inbox Response] to "${question}": ${response}`;

    injectAndMarkDelivered(id, text, tmuxPane);
  }
}

function injectAndMarkDelivered(id: number, text: string, tmuxPane: string): void {
  const db = getDb();
  db.prepare('UPDATE agent_messages SET delivered = 1 WHERE id = ?').run(id);
  try {
    execSync(`tmux send-keys -t ${tmuxPane} ${JSON.stringify(text)} Enter`, { stdio: 'ignore', timeout: 5000 });
    // Long text triggers tmux bracketed paste — send extra Enter to confirm
    execSync(`tmux send-keys -t ${tmuxPane} Enter`, { stdio: 'ignore', timeout: 2000 });
    console.error(`[bridge] delivered message ${id} to tmux pane ${tmuxPane}`);
  } catch (err) {
    console.error(`[bridge] tmux send-keys failed for message ${id}:`, err);
  }
}

function deliverUndelivered(options: BridgeOptions): void {
  const { agentName, agentPid, tmuxPane } = options;
  const db = getDb();

  const incoming = db.prepare(
    `SELECT * FROM agent_messages WHERE delivered IS NULL AND (
      (recipient_name = ? AND status = 'pending') OR
      (sender_name = ? AND status = 'answered') OR
      (agent_pid = ? AND status = 'answered')
    )`
  ).all(agentName, agentName, agentPid) as Array<{
    id: number; sender_name: string; recipient_name: string;
    question: string; response: string | null; status: string;
  }>;

  for (const msg of incoming) {
    let text: string;
    if (msg.recipient_name === agentName && msg.sender_name === 'user') {
      text = `[Message from User]: ${msg.question}`;
    } else if (msg.recipient_name === agentName && msg.sender_name !== 'user') {
      text = `[Message from ${msg.sender_name}]: ${msg.question}`;
    } else if (msg.status === 'answered' && msg.response) {
      text = `[Inbox Response] to "${msg.question.slice(0, 60)}": ${msg.response}`;
    } else {
      continue;
    }
    injectAndMarkDelivered(msg.id, text, tmuxPane);
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Start the tmux bridge: SSE listener for instant message delivery.
 * Returns a cleanup function for graceful shutdown.
 */
export function startTmuxBridge(options: BridgeOptions): () => void {
  startSSEListener(options);

  console.error(`[bridge] tmux bridge active for agent "${options.agentName}" on pane ${options.tmuxPane}`);

  return () => {
    // SSE connection will close when process exits
  };
}
