import { execSync } from 'child_process';
import { createReadStream, writeFileSync, unlinkSync, watchFile, unwatchFile, existsSync } from 'fs';
import { getDb } from './db.js';
import { getActivePort } from './sse.js';
import http from 'http';

interface BridgeOptions {
  agentName: string;
  agentPid: number;
  tmuxPane: string;
}

// ─── UI-injected message prefixes (skip these in capture) ────────────
const INJECTED_PREFIXES = [
  '[Message from ',
  '[Inbox Response]',
];

function isInjectedLine(line: string): boolean {
  return INJECTED_PREFIXES.some(prefix => line.startsWith(prefix));
}

// ─── Clean terminal output ───────────────────────────────────────────
function cleanTerminalOutput(text: string): string {
  // 1. Replace cursor-forward sequences (ESC[NC) with N spaces — these represent word gaps
  let cleaned = text.replace(/\x1B\[(\d+)C/g, (_m, n) => ' '.repeat(Number(n)));

  // 2. Strip remaining ANSI escape codes (colors, styles, cursor moves, etc.)
  cleaned = cleaned.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

  // 3. Normalize line endings: \r\n → \n, lone \r → \n, collapse 3+ newlines to 2
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');

  return cleaned;
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
    // Incoming message addressed to this agent
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
    // A question this agent sent got answered
    const sender = payload.sender_name as string;
    const recipient = payload.recipient_name as string;
    const status = payload.status as string;
    const id = payload.id as number;
    const delivered = payload.delivered as number | null;
    const agentPidField = payload.agent_pid as number | null;

    const isOurs = (sender === agentName || agentPidField === agentPid) && recipient === 'user';
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
      (sender_name = ? AND recipient_name = 'user' AND status = 'answered') OR
      (agent_pid = ? AND recipient_name = 'user' AND status = 'answered')
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

// ─── Tmux Capture (terminal output → chat) ───────────────────────────

const MAX_MESSAGE_LENGTH = 10000;
const FLUSH_DELAY_MS = 2000;

function startCapture(options: BridgeOptions): () => void {
  const { agentName, tmuxPane } = options;
  const tmpFile = `/tmp/taskflow-capture-${agentName}.pipe`;
  const port = getActivePort();

  // Truncate/create the temp file
  writeFileSync(tmpFile, '');

  // Start tmux pipe-pane
  try {
    execSync(`tmux pipe-pane -t ${tmuxPane} -o "cat >> ${tmpFile}"`, { stdio: 'ignore' });
    console.error(`[capture] started pipe-pane for ${tmuxPane} → ${tmpFile}`);
  } catch (err) {
    console.error('[capture] failed to start pipe-pane:', err);
    return () => {};
  }

  let buffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let readPosition = 0;

  function flushBuffer(): void {
    flushTimer = null;
    if (!buffer.trim()) { buffer = ''; return; }

    // Split into chunks if needed
    const chunks: string[] = [];
    let remaining = buffer;
    while (remaining.length > MAX_MESSAGE_LENGTH) {
      chunks.push(remaining.slice(0, MAX_MESSAGE_LENGTH));
      remaining = remaining.slice(MAX_MESSAGE_LENGTH);
    }
    if (remaining.trim()) chunks.push(remaining);
    buffer = '';

    for (const chunk of chunks) {
      postToChat(agentName, chunk, port);
    }
  }

  function processNewData(): void {
    if (!existsSync(tmpFile)) return;

    const stream = createReadStream(tmpFile, {
      start: readPosition,
      encoding: 'utf-8',
    });

    let newData = '';
    stream.on('data', (chunk: string | Buffer) => { newData += chunk.toString(); });
    stream.on('end', () => {
      if (!newData) return;
      readPosition += Buffer.byteLength(newData);

      const cleaned = cleanTerminalOutput(newData);
      const lines = cleaned.split('\n');
      const filtered = lines.filter(line => !isInjectedLine(line.trim()));
      const text = filtered.join('\n');

      if (text.trim()) {
        buffer += text;
        // Reset the flush timer on each new data
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flushBuffer, FLUSH_DELAY_MS);
      }
    });
    stream.on('error', () => { /* file may be gone */ });
  }

  // Watch for file changes
  watchFile(tmpFile, { interval: 500 }, () => {
    processNewData();
  });

  // Cleanup function
  return () => {
    if (flushTimer) clearTimeout(flushTimer);
    // Flush any remaining buffer
    if (buffer.trim()) {
      const chunks: string[] = [];
      let remaining = buffer;
      while (remaining.length > MAX_MESSAGE_LENGTH) {
        chunks.push(remaining.slice(0, MAX_MESSAGE_LENGTH));
        remaining = remaining.slice(MAX_MESSAGE_LENGTH);
      }
      if (remaining.trim()) chunks.push(remaining);
      buffer = '';
      for (const chunk of chunks) {
        postToChat(agentName, chunk, port);
      }
    }
    unwatchFile(tmpFile);
    try { execSync(`tmux pipe-pane -t ${tmuxPane}`, { stdio: 'ignore' }); } catch {}
    try { unlinkSync(tmpFile); } catch {}
    console.error(`[capture] stopped for ${tmuxPane}`);
  };
}

function postToChat(agentName: string, text: string, port: number): void {
  const body = JSON.stringify({
    recipient: 'user',
    message: text,
    source: 'terminal',
    senderName: agentName,
  });

  const req = http.request({
    hostname: 'localhost',
    port,
    path: '/api/agent-messages/send',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    // Drain the response
    res.resume();
    if (res.statusCode !== 200) {
      console.error(`[capture] POST failed with status ${res.statusCode}`);
    }
  });
  req.on('error', (err) => {
    console.error('[capture] POST error:', err.message);
  });
  req.write(body);
  req.end();
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Start the tmux bridge: SSE listener for instant delivery + capture for terminal→chat.
 * Returns a cleanup function for graceful shutdown.
 */
export function startTmuxBridge(options: BridgeOptions): () => void {
  startSSEListener(options);
  const stopCapture = startCapture(options);

  console.error(`[bridge] tmux bridge active for agent "${options.agentName}" on pane ${options.tmuxPane}`);

  return () => {
    stopCapture();
  };
}
