import { execFileSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getDb } from './db.js';
import { getActivePort } from './sse.js';
import http from 'http';

const LOG_FILE = join(homedir(), '.taskflow', 'bridge.log');
try { mkdirSync(join(homedir(), '.taskflow'), { recursive: true }); } catch {}

function blogLog(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  console.error(`[bridge] ${msg}`);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

interface BridgeOptions {
  /** Returns the current agent name — must be a getter so renames are picked up */
  getAgentName: () => string;
  agentPid: number;
  /** Null when not running inside tmux — falls back to stderr delivery */
  tmuxPane: string | null;
}

// ─── SSE Listener (replaces the 3s poller) ───────────────────────────

function startSSEListener(options: BridgeOptions): void {
  const port = getActivePort();

  function connect() {
    const req = http.get(`http://localhost:${port}/events`, (res) => {
      let buffer = '';
      let eventType = '';  // persists across chunks — SSE fields may split across TCP segments

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSEEvent(eventType, data, options);
            } catch { /* malformed JSON */ }
            eventType = '';
          } else if (line === '') {
            // SSE event delimiter — reset state for next event
            eventType = '';
          }
        }
      });

      res.on('end', () => {
        blogLog('SSE connection closed, reconnecting in 3s...');
        setTimeout(connect, 3000);
      });

      res.on('error', () => {
        blogLog('SSE connection error, reconnecting in 3s...');
        setTimeout(connect, 3000);
      });
    });

    req.on('error', () => {
      blogLog('SSE connect failed, retrying in 3s...');
      setTimeout(connect, 3000);
    });
  }

  // Initial sweep: deliver any undelivered messages from before SSE connected
  deliverUndelivered(options);

  connect();
}

function handleSSEEvent(event: string, data: { payload?: Record<string, unknown> }, options: BridgeOptions): void {
  const { getAgentName, agentPid, tmuxPane } = options;
  const agentName = getAgentName();
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

// TIOCSTI Python script — injects each character of `text` + newline into the
// controlling terminal's input queue via ioctl(TIOCSTI). Passed as a CLI arg
// (not inline) so special characters in the message are never shell-interpreted.
const TIOCSTI_SCRIPT = `
import fcntl, sys
TIOCSTI = 0x5412
with open('/dev/tty', 'rb+', buffering=0) as tty:
    for c in (sys.argv[1] + '\\n').encode():
        fcntl.ioctl(tty, TIOCSTI, bytes([c]))
`.trim();

function injectViaTiocsti(text: string): string | null {
  try {
    execFileSync('python3', ['-c', TIOCSTI_SCRIPT, text], { timeout: 5000 });
    return null;
  } catch (err: any) {
    // Capture stderr from the Python process (where the real error lives)
    const stderr = err?.stderr?.toString().trim() || '';
    const stdout = err?.stdout?.toString().trim() || '';
    const msg = err?.message || String(err);
    return [msg, stderr, stdout].filter(Boolean).join(' | ');
  }
}

function injectAndMarkDelivered(id: number, text: string, tmuxPane: string | null): void {
  const db = getDb();
  db.prepare('UPDATE agent_messages SET delivered = 1 WHERE id = ?').run(id);

  if (tmuxPane) {
    try {
      // Send text literally (-l) so special chars are safe and tmux doesn't interpret them
      execFileSync('tmux', ['send-keys', '-t', tmuxPane, '-l', text], { stdio: 'ignore', timeout: 5000 });

      // Delay before Enter — gives the CLI time to fully process the bracketed paste.
      // Without this, Codex (and similar TUIs) may only show partial text because
      // the Enter arrives inside the paste bracket and gets swallowed.
      setTimeout(() => {
        try {
          execFileSync('tmux', ['send-keys', '-t', tmuxPane, 'Enter'], { stdio: 'ignore', timeout: 5000 });
        } catch { /* pane may have closed */ }
        // Second Enter after another delay — catches CLIs that need an extra nudge
        // after bracketed paste ends (e.g. long messages that trigger paste mode)
        setTimeout(() => {
          try {
            execFileSync('tmux', ['send-keys', '-t', tmuxPane, 'Enter'], { stdio: 'ignore', timeout: 5000 });
          } catch { /* pane may have closed */ }
        }, 500);
      }, 300);

      blogLog(`delivered message ${id} to tmux pane ${tmuxPane}`);
    } catch (err) {
      blogLog(`tmux send-keys failed for message ${id}: ${err}`);
    }
  } else {
    // Non-tmux: try TIOCSTI to inject text into the controlling terminal's input
    // queue. TIOCSTI (0x5412) works when the caller shares the controlling terminal
    // with the target process — which is true here since the MCP server is a child
    // of Claude Code and inherits its tty session.
    // Falls back to stderr if python3 is unavailable or the ioctl is denied.
    const tiocError = injectViaTiocsti(text);
    if (tiocError !== null) {
      blogLog(`TIOCSTI failed for message ${id}: ${tiocError}`);
      // Last-resort visual: at least make the message visible in the terminal output.
      // The tool-response piggyback in index.ts will also deliver it on the next call.
      process.stderr.write(`\n\x1b[33m[INBOX #${id}]: ${text}\x1b[0m\n`);
      blogLog(`message ${id} visible in stderr, will appear in next tool response`);
    } else {
      blogLog(`delivered message ${id} via TIOCSTI`);
    }
  }
}

function deliverUndelivered(options: BridgeOptions): void {
  const { getAgentName, agentPid, tmuxPane } = options;
  const agentName = getAgentName();
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

  const pane = options.tmuxPane;
  blogLog(`bridge active for agent "${options.getAgentName()}"${pane ? ` on tmux pane ${pane}` : ' (TIOCSTI mode — no tmux pane)'}`);

  return () => {
    // SSE connection will close when process exits
  };
}
