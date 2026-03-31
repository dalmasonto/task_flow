# Tmux Capture & SSE Listener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3s polling mechanism with an event-driven SSE listener and auto-capture tmux agent output into the TaskFlow chat system.

**Architecture:** The MCP process (`index.ts`) connects to its own SSE server as a client for instant message delivery. Simultaneously, `tmux pipe-pane` streams pane output to a temp file, which is tailed via `fs.watch` and flushed to the chat API after 2s of silence. A new `source` column on `agent_messages` distinguishes `mcp`/`terminal`/`ui` origins.

**Tech Stack:** Node.js native `http` (SSE client), `fs.watch`/`fs.createReadStream` (file tailing), `tmux pipe-pane` (capture), better-sqlite3 (migration), Dexie (frontend)

**Spec:** `docs/superpowers/specs/2026-03-31-tmux-capture-to-chat-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `mcp-server/src/db.ts` | Modify | Add `source` column migration |
| `mcp-server/src/sse.ts` | Modify | Accept `source` field in `/api/agent-messages/send` |
| `mcp-server/src/tools/agent-inbox.ts` | Modify | Set `source = 'mcp'` explicitly in `ask_user`/`send_to_agent` |
| `mcp-server/src/tmux-bridge.ts` | Create | SSE listener + tmux capture logic (extracted from `index.ts`) |
| `mcp-server/src/index.ts` | Modify | Remove poller, call `startTmuxBridge()` |
| `src/types/index.ts` | Modify | Add `source` field to `AgentMessage` |
| `src/hooks/use-sync.ts` | Modify | Parse `source` in `parseAgentMessage` |
| `src/db/database.ts` | Modify | Bump Dexie version for `source` index |
| `src/routes/agent-inbox.tsx` | Modify | Terminal message styling |

---

### Task 1: Add `source` column to SQLite schema

**Files:**
- Modify: `mcp-server/src/db.ts:98` (schema) and `mcp-server/src/db.ts:139-153` (migrations)

- [ ] **Step 1: Add `source` to the CREATE TABLE schema**

In `mcp-server/src/db.ts`, in the `agent_messages` CREATE TABLE statement (line 98), add the `source` column after `status`:

```sql
source TEXT NOT NULL DEFAULT 'mcp',
```

The full column list becomes:
```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  context TEXT,
  choices TEXT,
  response TEXT,
  agent_pid INTEGER,
  delivered INTEGER,
  sender_name TEXT NOT NULL DEFAULT 'unknown',
  recipient_name TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'mcp',
  created_at TEXT NOT NULL,
  answered_at TEXT
);
```

- [ ] **Step 2: Add migration for existing databases**

In `mcp-server/src/db.ts`, after the existing `recipient_name` migration (line 153), add:

```typescript
if (!colNames.has('source')) {
  db.exec("ALTER TABLE agent_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'mcp'");
}
```

- [ ] **Step 3: Update the nullable migration table recreation**

In `mcp-server/src/db.ts`, the table recreation migration (lines 160-184) also needs `source`. Update `agent_messages_new` CREATE TABLE to include:

```sql
source TEXT NOT NULL DEFAULT 'mcp',
```

And update the INSERT SELECT to include `source`:

```sql
INSERT INTO agent_messages_new SELECT
  id, project_id, question, context, choices, response, agent_pid, delivered,
  COALESCE(sender_name, 'unknown'), COALESCE(recipient_name, 'user'),
  status, COALESCE(source, 'mcp'), created_at, answered_at
FROM agent_messages;
```

- [ ] **Step 4: Verify build**

Run: `cd mcp-server && npm run build`
Expected: Clean compile, no errors

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/db.ts
git commit -m "feat(db): add source column to agent_messages schema"
```

---

### Task 2: Accept `source` in the HTTP API

**Files:**
- Modify: `mcp-server/src/sse.ts:358-381`

- [ ] **Step 1: Update `/api/agent-messages/send` to accept `source` and `senderName`**

In `mcp-server/src/sse.ts`, modify the send endpoint (line 359). Update the body destructuring and INSERT to accept optional `source` and `senderName` fields. The `senderName` override is needed so the capture system can post as the agent (not as `'user'`):

```typescript
// POST /api/agent-messages/send — send a message (from user UI or capture system)
if (req.url === '/api/agent-messages/send' && req.method === 'POST') {
  const db = getDb();
  const body = JSON.parse(await readBody(req));
  const { recipient, message: msgText, projectId, source: msgSource, senderName } = body as {
    recipient: string; message: string; projectId?: number; source?: string; senderName?: string
  };

  if (!recipient || !msgText) {
    jsonResponse(res, 400, { error: 'recipient and message are required' });
    return;
  }

  const source = msgSource || 'ui';
  const sender = senderName || 'user';
  const ts = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO agent_messages (project_id, question, sender_name, recipient_name, source, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(projectId ?? null, msgText, sender, recipient, source, ts);

  const id = (result as { lastInsertRowid: number }).lastInsertRowid;
  const msg = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
  broadcast('agent_question', { entity: 'agent_message', action: 'agent_question', payload: msg });

  jsonResponse(res, 200, msg);
  return;
}
```

- [ ] **Step 2: Verify build**

Run: `cd mcp-server && npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/sse.ts
git commit -m "feat(api): accept source field in agent-messages/send endpoint"
```

---

### Task 3: Set `source = 'mcp'` in MCP tools

**Files:**
- Modify: `mcp-server/src/tools/agent-inbox.ts:49-51` (ask_user INSERT) and `mcp-server/src/tools/agent-inbox.ts:116-119` (send_to_agent INSERT)

- [ ] **Step 1: Update `ask_user` INSERT to include source**

In `mcp-server/src/tools/agent-inbox.ts`, update the ask_user INSERT (line 49):

```typescript
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
```

- [ ] **Step 2: Update `send_to_agent` INSERT to include source**

In `mcp-server/src/tools/agent-inbox.ts`, update the send_to_agent INSERT (line 116):

```typescript
const result = db.prepare(
  `INSERT INTO agent_messages (project_id, question, context, sender_name, recipient_name, source, status, created_at)
   VALUES (NULL, ?, ?, ?, ?, 'mcp', 'pending', ?)`
).run(params.message, params.context ?? null, senderName, params.recipient, ts);
```

- [ ] **Step 3: Verify build**

Run: `cd mcp-server && npm run build`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/agent-inbox.ts
git commit -m "feat(mcp): set source='mcp' explicitly in ask_user and send_to_agent"
```

---

### Task 4: Create the tmux bridge module

**Files:**
- Create: `mcp-server/src/tmux-bridge.ts`

This module exports a single `startTmuxBridge()` function that handles both:
1. SSE listener for instant UI→terminal message delivery
2. Tmux pipe-pane capture for terminal→chat

- [ ] **Step 1: Create `mcp-server/src/tmux-bridge.ts`**

```typescript
import { execSync, exec as execCb } from 'child_process';
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

// ─── Strip ANSI escape codes ─────────────────────────────────────────
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
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
    stream.on('data', (chunk: string) => { newData += chunk; });
    stream.on('end', () => {
      if (!newData) return;
      readPosition += Buffer.byteLength(newData);

      const cleaned = stripAnsi(newData);
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
```

- [ ] **Step 2: Verify build**

Run: `cd mcp-server && npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/tmux-bridge.ts
git commit -m "feat: add tmux-bridge module for SSE listener and terminal capture"
```

---

### Task 5: Replace the poller in `index.ts` with the bridge

**Files:**
- Modify: `mcp-server/src/index.ts:96-157`

- [ ] **Step 1: Remove the poller and tmux detection, replace with bridge call**

Replace everything from line 96 (`// Background poller:`) to line 156 (end of `if (tmuxTarget)`) with the bridge integration. The new code at that location:

```typescript
  // Tmux bridge: SSE listener for instant delivery + capture for terminal→chat
  let tmuxTarget: string | null = null;
  try {
    const { execSync: exec } = await import('child_process');
    const ptsPath = exec(`readlink /proc/${agentPid}/fd/0`).toString().trim();
    const panes = exec('tmux list-panes -a -F "#{pane_id} #{pane_tty}"').toString().trim().split('\n');
    for (const line of panes) {
      const [paneId, paneTty] = line.split(' ');
      if (paneTty === ptsPath) { tmuxTarget = paneId; break; }
    }
  } catch {
    console.error('[bridge] tmux not available');
  }

  if (tmuxTarget) {
    const { startTmuxBridge } = await import('./tmux-bridge.js');
    const stopBridge = startTmuxBridge({
      agentName,
      agentPid,
      tmuxPane: tmuxTarget,
    });

    // Update cleanup to also stop the bridge
    const originalCleanup = cleanup;
    const cleanupWithBridge = () => { stopBridge(); originalCleanup(); };
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
    process.on('SIGINT', cleanupWithBridge);
    process.on('SIGTERM', cleanupWithBridge);
  } else {
    console.error('[bridge] agent not in tmux — bridge disabled');
  }
```

Note: The `cleanup` variable is defined on line 92. We need to change it from `const` to `let` so we can reassign the signal handlers:

Line 92, change:
```typescript
const cleanup = () => { try { unregisterAgent(agentName); } catch {} process.exit(0); };
```

to:

```typescript
let cleanup = () => { try { unregisterAgent(agentName); } catch {} process.exit(0); };
```

Also remove the `agentPid` declaration from line 98 since we already have it. The `const agentPid = process.ppid;` on line 98 should be moved up before the cleanup declaration (or reuse the existing `process.ppid` reference). Actually, looking more carefully, `agentPid` is only used in the poller block, so just define it before the tmux detection:

```typescript
const agentPid = process.ppid;
```

This should be placed right after the `agentName` registration (line 88), before cleanup.

- [ ] **Step 2: Verify the full updated `index.ts`**

The MCP section (lines 54-end) should now look like:

```typescript
if (!httpOnly) {
  // ... imports and server setup (unchanged) ...

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const { registerAgent, unregisterAgent } = await import('./agent-registry.js');

  const agentName = registerAgent();
  const agentPid = process.ppid;
  console.error(`[agent] registered as "${agentName}"`);

  let cleanup = () => { try { unregisterAgent(agentName); } catch {} process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Tmux bridge
  let tmuxTarget: string | null = null;
  try {
    const { execSync: exec } = await import('child_process');
    const ptsPath = exec(`readlink /proc/${agentPid}/fd/0`).toString().trim();
    const panes = exec('tmux list-panes -a -F "#{pane_id} #{pane_tty}"').toString().trim().split('\n');
    for (const line of panes) {
      const [paneId, paneTty] = line.split(' ');
      if (paneTty === ptsPath) { tmuxTarget = paneId; break; }
    }
  } catch {
    console.error('[bridge] tmux not available');
  }

  if (tmuxTarget) {
    const { startTmuxBridge } = await import('./tmux-bridge.js');
    const stopBridge = startTmuxBridge({
      agentName,
      agentPid,
      tmuxPane: tmuxTarget,
    });

    const originalCleanup = cleanup;
    cleanup = () => { stopBridge(); originalCleanup(); };
    process.removeListener('SIGINT', originalCleanup);
    process.removeListener('SIGTERM', originalCleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } else {
    console.error('[bridge] agent not in tmux — bridge disabled');
  }
}
```

- [ ] **Step 3: Verify build**

Run: `cd mcp-server && npm run build`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/index.ts
git commit -m "feat: replace 3s poller with event-driven tmux bridge"
```

---

### Task 6: Add `source` to the frontend type and Dexie schema

**Files:**
- Modify: `src/types/index.ts:119-131`
- Modify: `src/db/database.ts:40-43`
- Modify: `src/hooks/use-sync.ts:312-326`

- [ ] **Step 1: Add `source` to the `AgentMessage` interface**

In `src/types/index.ts`, add `source` to the `AgentMessage` interface (after `status` on line 128):

```typescript
export type AgentMessageSource = 'mcp' | 'terminal' | 'ui'

export interface AgentMessage {
  id?: number
  projectId?: number
  senderName: string
  recipientName: string
  question: string
  context?: string
  choices?: string[]
  response?: string
  status: AgentMessageStatus
  source?: AgentMessageSource
  createdAt: Date
  answeredAt?: Date
}
```

- [ ] **Step 2: Bump Dexie version to add `source` index**

In `src/db/database.ts`, add version 7 after the version 6 block (line 43):

```typescript
this.version(7).stores({
  agentMessages: '++id, projectId, senderName, recipientName, status, source, createdAt',
})
```

- [ ] **Step 3: Update `parseAgentMessage` in use-sync.ts**

In `src/hooks/use-sync.ts`, update `parseAgentMessage` (line 312) to include `source`:

```typescript
function parseAgentMessage(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    projectId: raw.project_id != null ? (raw.project_id as number) : undefined,
    senderName: (raw.sender_name as string) ?? 'unknown',
    recipientName: (raw.recipient_name as string) ?? 'user',
    question: raw.question as string,
    context: raw.context != null ? (raw.context as string) : undefined,
    choices: raw.choices != null ? parseJsonField(raw.choices, []) : undefined,
    response: raw.response != null ? (raw.response as string) : undefined,
    status: raw.status as 'pending' | 'answered' | 'dismissed',
    source: (raw.source as string | undefined) ?? 'mcp',
    createdAt: new Date(raw.created_at as string),
    answeredAt: raw.answered_at ? new Date(raw.answered_at as string) : undefined,
  }
}
```

- [ ] **Step 4: Verify frontend build**

Run: `npm run build` (from project root)
Expected: Clean compile

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/db/database.ts src/hooks/use-sync.ts
git commit -m "feat(frontend): add source field to AgentMessage type and Dexie schema"
```

---

### Task 7: Style terminal messages in the inbox UI

**Files:**
- Modify: `src/routes/agent-inbox.tsx:107-178` (ChatBubble component)

- [ ] **Step 1: Add terminal source detection and styling to ChatBubble**

In `src/routes/agent-inbox.tsx`, update the `ChatBubble` component. Add terminal detection and a badge:

```typescript
function ChatBubble({
  message,
  project,
  port,
}: {
  message: AgentMessage
  project?: { name: string; color: string }
  port: number
}) {
  const isFromUser = message.senderName === 'user'
  const isPending = message.status === 'pending'
  const isTerminal = message.source === 'terminal'

  return (
    <div className={`flex flex-col ${isFromUser ? 'items-end' : 'items-start'}`}>
      {/* Sender label + timestamp */}
      <div className={`flex items-center gap-2 mb-1 ${isFromUser ? 'flex-row-reverse' : ''}`}>
        {project && (
          <span
            className="text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 border"
            style={{ borderColor: project.color, color: project.color }}
          >
            {project.name}
          </span>
        )}
        <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">
          {isFromUser ? 'You' : message.senderName}
        </span>
        {isTerminal && (
          <span className="text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 border border-emerald-500/40 text-emerald-500">
            terminal
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/60">{getTimeAgo(message.createdAt)}</span>
        {isPending && !isFromUser && (
          <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" title="Unread" />
        )}
      </div>

      {/* Bubble */}
      <div className={`max-w-[85%] space-y-3 ${
        isFromUser
          ? 'bg-secondary/10 border border-secondary/20'
          : isTerminal
            ? 'bg-emerald-500/5 border border-emerald-500/20'
            : isPending
              ? 'bg-card border-l-2 border-l-secondary border border-secondary/30 shadow-[0_0_12px_rgba(222,142,255,0.08)]'
              : 'bg-card border border-border opacity-80'
      } px-4 py-3`}>
        {/* Context */}
        {message.context && (
          <div className="text-sm text-muted-foreground prose prose-sm dark:prose-invert max-w-none prose-headings:text-muted-foreground prose-headings:text-sm prose-headings:font-bold prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1 prose-ul:my-1 prose-li:my-0">
            <ReactMarkdown>{unescapeMarkdown(message.context)}</ReactMarkdown>
          </div>
        )}

        {/* Message text */}
        {isTerminal ? (
          <pre className="text-xs font-mono whitespace-pre-wrap break-words text-emerald-300/90 overflow-x-auto">{message.question}</pre>
        ) : (
          <p className={isFromUser ? 'text-sm' : 'font-bold text-base'}>{message.question}</p>
        )}

        {/* Pending: show choices + input (only for agent messages, not user-sent) */}
        {isPending && !isFromUser && !isTerminal && <PendingActions message={message} port={port} />}

        {/* Answered: show response */}
        {message.status === 'answered' && message.response && (
          <div className="flex items-start gap-2 pt-2 border-t border-border/50">
            <span className="material-symbols-outlined text-sm text-secondary mt-0.5">reply</span>
            <span className="text-sm">{message.response}</span>
          </div>
        )}

        {/* Dismissed */}
        {message.status === 'dismissed' && (
          <div className="flex items-center gap-2 pt-2 border-t border-border/50 text-muted-foreground/50">
            <span className="material-symbols-outlined text-sm">do_not_disturb</span>
            <span className="text-[10px] uppercase tracking-widest">Answered in terminal</span>
          </div>
        )}
      </div>
    </div>
  )
}
```

Key changes:
- `isTerminal` flag from `message.source === 'terminal'`
- Green `terminal` badge next to sender name
- Green-tinted bubble background for terminal messages (`bg-emerald-500/5 border-emerald-500/20`)
- Monospace `<pre>` for terminal message content instead of `<p>`
- No `PendingActions` for terminal messages (they're informational, not questions)

- [ ] **Step 2: Verify frontend build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/routes/agent-inbox.tsx
git commit -m "feat(ui): style terminal-sourced messages with monospace and green tint"
```

---

### Task 8: Manual integration test

- [ ] **Step 1: Build the MCP server**

Run: `cd mcp-server && npm run build`
Expected: Clean compile, all files in `dist/`

- [ ] **Step 2: Start a tmux session and run Claude Code**

```bash
tmux new -s test-capture
claude
```

- [ ] **Step 3: Verify the bridge starts**

Check MCP server stderr output for:
```
[bridge] tmux bridge active for agent "task_flow" on pane %N
[capture] started pipe-pane for %N → /tmp/taskflow-capture-task_flow.pipe
```

- [ ] **Step 4: Interact with the agent and check the inbox**

Open the TaskFlow UI, go to the Agent Inbox. Interact with Claude in the terminal — type messages, let the agent respond. Verify:
- Terminal output appears in the chat as green-tinted monospace messages with `terminal` badge
- Messages sent from the UI (`[Message from User]: ...`) do NOT appear as captured terminal messages (no loop)
- UI responses are delivered instantly (no 3s delay)

- [ ] **Step 5: Verify cleanup on exit**

Exit Claude Code (`/exit`). Verify:
- `tmux pipe-pane` stopped (run `tmux show -p pipe-pane` — should be empty)
- Temp file `/tmp/taskflow-capture-task_flow.pipe` is deleted

- [ ] **Step 6: Commit any fixes**

If any fixes were needed during testing:
```bash
git add -A
git commit -m "fix: address issues found during tmux bridge integration testing"
```
