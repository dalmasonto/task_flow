# Agent Registry + Bidirectional Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents register by project path for stable identity. Messages flow user↔agent and agent↔agent. Inbox UI gets an agent sidebar with per-agent filtering and a compose box.

**Architecture:** New `agent_registry` SQLite table stores agent identities. `agent_messages` gains `sender_name`/`recipient_name` columns replacing `agent_pid`. MCP server auto-registers on startup, poller uses agent name for injection routing. Inbox UI splits into sidebar (agent list) + main panel (messages).

**Tech Stack:** SQLite (server), Dexie (client), React + shadcn/ui, SSE, tmux

---

## File Structure

### MCP Server (new files)
- `mcp-server/src/agent-registry.ts` — Agent registration logic (register, unregister, list, liveness check)

### MCP Server (modified files)
- `mcp-server/src/db.ts` — Add `agent_registry` table, migrate `agent_messages` columns
- `mcp-server/src/types.ts` — Add `AgentStatus` Zod enum, new activity actions
- `mcp-server/src/tools/agent-inbox.ts` — Update `ask_user` to use agent name, add `send_to_agent`, `check_messages`, `list_agents`, `register_agent`
- `mcp-server/src/index.ts` — Auto-register on startup, update poller to use agent name
- `mcp-server/src/sse.ts` — Add liveness checker interval, add `/api/agent-messages/send` endpoint for user→agent, add agents to `/sync`

### UI (new files)
- `src/components/inbox/agent-sidebar.tsx` — Agent list sidebar component
- `src/components/inbox/compose-box.tsx` — Message compose box for user→agent

### UI (modified files)
- `src/types/index.ts` — Add `AgentRegistryEntry`, update `AgentMessage` with sender/recipient
- `src/db/database.ts` — Add `agentRegistry` Dexie table (version 6)
- `src/hooks/use-sync.ts` — Add SSE listeners for `agent_connected`, `agent_disconnected`, sync `agentRegistry`
- `src/hooks/use-agent-messages.ts` — Add `useAgentRegistry`, `sendToAgent`, filter by agent name
- `src/routes/agent-inbox.tsx` — New layout with sidebar + main panel + compose box

---

### Task 1: Database — `agent_registry` table + `agent_messages` migration

**Files:**
- Modify: `mcp-server/src/db.ts`
- Modify: `mcp-server/src/types.ts`

- [ ] **Step 1: Add AgentStatus to types.ts**

In `mcp-server/src/types.ts`, add after `AgentMessageStatus`:

```typescript
export const AgentStatus = z.enum(['connected', 'disconnected']);
export type AgentStatus = z.infer<typeof AgentStatus>;
```

Add new activity actions to the `ActivityAction` enum — add `'agent_connected'` and `'agent_disconnected'` to the array.

- [ ] **Step 2: Add agent_registry table to db.ts**

In `mcp-server/src/db.ts`, inside `initSchema`, add after the `agent_messages` CREATE TABLE:

```sql
CREATE TABLE IF NOT EXISTS agent_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  project_path TEXT NOT NULL,
  pid INTEGER NOT NULL,
  tmux_pane TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  connected_at TEXT NOT NULL,
  disconnected_at TEXT
);
```

Add indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);
CREATE INDEX IF NOT EXISTS idx_agent_registry_name ON agent_registry(name);
```

- [ ] **Step 3: Add agent_messages migration for sender_name / recipient_name**

In the migrations section at the bottom of `initSchema`, add:

```typescript
// Migrate agent_messages: add sender_name and recipient_name
const msgCols = db.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string }>;
const msgColNames = new Set(msgCols.map(c => c.name));
if (!msgColNames.has('sender_name')) {
  db.exec("ALTER TABLE agent_messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT 'unknown'");
}
if (!msgColNames.has('recipient_name')) {
  db.exec("ALTER TABLE agent_messages ADD COLUMN recipient_name TEXT NOT NULL DEFAULT 'user'");
}
```

- [ ] **Step 4: Add agent_registry to /sync and clear-data in sse.ts**

In `mcp-server/src/sse.ts`, in the `/sync` GET handler, add:

```typescript
const agentRegistry = db.prepare('SELECT * FROM agent_registry ORDER BY connected_at DESC').all();
```

Include `agentRegistry` in the `jsonResponse`.

In the `/api/clear-data` handler, add:

```typescript
db.exec('DELETE FROM agent_registry');
```

- [ ] **Step 5: Verify MCP server compiles**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/db.ts mcp-server/src/types.ts mcp-server/src/sse.ts
git commit -m "feat(mcp): add agent_registry table and agent_messages migration

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Agent Registry Module

**Files:**
- Create: `mcp-server/src/agent-registry.ts`

- [ ] **Step 1: Create agent-registry.ts**

```typescript
import { execSync } from 'child_process';
import { getDb } from './db.js';
import { broadcast } from './sse.js';
import { logActivity } from './helpers.js';

interface AgentRow {
  id: number;
  name: string;
  project_path: string;
  pid: number;
  tmux_pane: string | null;
  status: string;
  connected_at: string;
  disconnected_at: string | null;
}

/** Check if a process is still alive */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/** Detect the tmux pane for a given PID */
function detectTmuxPane(pid: number): string | null {
  try {
    const ptsPath = execSync(`readlink /proc/${pid}/fd/0`).toString().trim();
    const panes = execSync('tmux list-panes -a -F "#{pane_id} #{pane_tty}"').toString().trim().split('\n');
    for (const line of panes) {
      const [paneId, paneTty] = line.split(' ');
      if (paneTty === ptsPath) return paneId;
    }
  } catch { /* tmux not available */ }
  return null;
}

/** Generate a unique agent name from the project folder, auto-suffixing on collision */
function generateName(folderName: string): string {
  const db = getDb();
  // Check if base name is free or taken by a dead agent
  const existing = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(folderName) as AgentRow | undefined;
  if (!existing || !isAlive(existing.pid)) {
    return folderName;
  }
  // Auto-suffix
  for (let i = 2; i < 100; i++) {
    const candidate = `${folderName}:${i}`;
    const row = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(candidate) as AgentRow | undefined;
    if (!row || !isAlive(row.pid)) return candidate;
  }
  return `${folderName}:${Date.now()}`;
}

/** Register an agent. Returns the assigned name. */
export function registerAgent(options?: { customName?: string }): string {
  const db = getDb();
  const agentPid = process.ppid; // Claude Code's PID
  const projectPath = process.cwd();
  const folderName = projectPath.split('/').pop() || 'unknown';

  const name = options?.customName || generateName(folderName);
  const tmuxPane = detectTmuxPane(agentPid);
  const ts = new Date().toISOString();

  // Upsert — if the name exists (stale), replace it
  const existing = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(name) as AgentRow | undefined;
  if (existing) {
    db.prepare(
      'UPDATE agent_registry SET project_path = ?, pid = ?, tmux_pane = ?, status = ?, connected_at = ?, disconnected_at = NULL WHERE name = ?'
    ).run(projectPath, agentPid, tmuxPane, 'connected', ts, name);
  } else {
    db.prepare(
      'INSERT INTO agent_registry (name, project_path, pid, tmux_pane, status, connected_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, projectPath, agentPid, tmuxPane, 'connected', ts);
  }

  const row = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(name);
  broadcast('agent_connected', { entity: 'agent', action: 'agent_connected', payload: row });
  logActivity('agent_connected', `Agent "${name}" connected`, { entityType: 'agent' });

  return name;
}

/** Mark an agent as disconnected */
export function unregisterAgent(name: string): void {
  const db = getDb();
  const ts = new Date().toISOString();
  db.prepare("UPDATE agent_registry SET status = 'disconnected', disconnected_at = ? WHERE name = ?").run(ts, name);

  const row = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(name);
  broadcast('agent_disconnected', { entity: 'agent', action: 'agent_disconnected', payload: row });
  logActivity('agent_disconnected', `Agent "${name}" disconnected`, { entityType: 'agent' });
}

/** Check all registered agents and mark dead ones as disconnected */
export function checkAgentLiveness(): void {
  const db = getDb();
  const liveAgents = db.prepare("SELECT * FROM agent_registry WHERE status = 'connected'").all() as AgentRow[];
  for (const agent of liveAgents) {
    if (!isAlive(agent.pid)) {
      unregisterAgent(agent.name);
    }
  }
}

/** Get a registered agent by name */
export function getAgent(name: string): AgentRow | undefined {
  return getDb().prepare('SELECT * FROM agent_registry WHERE name = ?').get(name) as AgentRow | undefined;
}

/** List all agents, optionally filtered by status */
export function listAgents(status?: string): AgentRow[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM agent_registry WHERE status = ? ORDER BY connected_at DESC').all(status) as AgentRow[];
  }
  return db.prepare('SELECT * FROM agent_registry ORDER BY connected_at DESC').all() as AgentRow[];
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/agent-registry.ts
git commit -m "feat(mcp): add agent registry module with registration and liveness checks

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Update MCP Tools — Registration + Messaging

**Files:**
- Modify: `mcp-server/src/tools/agent-inbox.ts`

- [ ] **Step 1: Rewrite agent-inbox.ts with all tools**

Replace the entire file with:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse, now, broadcastChange } from '../helpers.js';
import { registerAgent as doRegister, getAgent, listAgents } from '../agent-registry.js';

/** The name assigned to this agent after registration */
let myAgentName: string | null = null;

/** Get or auto-register the agent name */
function ensureRegistered(): string {
  if (!myAgentName) {
    myAgentName = doRegister();
  }
  return myAgentName;
}

export { myAgentName };

export function registerAgentInboxTools(server: McpServer) {
  server.tool(
    'register_agent',
    'Register this agent with a custom name. Optional — agents auto-register on startup using the project folder name. Call this only if you want a specific name.',
    {
      name: z.string().optional().describe('Custom agent name. If omitted, uses the project folder name.'),
    },
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
    async (params) => {
      const db = getDb();
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(params.project_id);
      if (!project) return errorResponse(`Project ${params.project_id} not found`, 'NOT_FOUND');

      const senderName = ensureRegistered();
      const ts = now();
      const result = db.prepare(
        `INSERT INTO agent_messages (project_id, question, context, choices, sender_name, recipient_name, agent_pid, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'user', ?, 'pending', ?)`
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
    'Check if the user has responded to a previously posted agent question. Returns the response if answered, or status "pending" if still waiting.',
    {
      message_id: z.number().describe('The agent message ID returned by ask_user'),
    },
    async (params) => {
      const db = getDb();
      const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(params.message_id) as Record<string, unknown> | undefined;
      if (!message) return errorResponse(`Message ${params.message_id} not found`, 'NOT_FOUND');

      if (message.status === 'answered') {
        return successResponse({
          id: message.id, status: 'answered', response: message.response,
          question: message.question, answered_at: message.answered_at,
        });
      }
      return successResponse({
        id: message.id, status: 'pending', question: message.question,
        message: 'User has not responded yet. Try again later or continue with other work.',
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
    async (params) => {
      const db = getDb();
      const senderName = ensureRegistered();

      const recipient = getAgent(params.recipient);
      if (!recipient) return errorResponse(`Agent "${params.recipient}" not found`, 'NOT_FOUND');

      const ts = now();
      const result = db.prepare(
        `INSERT INTO agent_messages (project_id, question, context, sender_name, recipient_name, status, created_at)
         VALUES (NULL, ?, ?, ?, ?, 'pending', ?)`
      ).run(params.message, params.context ?? null, senderName, params.recipient, ts);

      const id = result.lastInsertRowid as number;
      const msg = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
      broadcastChange('agent_message', 'agent_question', msg);

      return successResponse({ id, sender: senderName, recipient: params.recipient, status: 'pending' });
    },
  );

  server.tool(
    'check_messages',
    'Check for incoming messages from users or other agents addressed to this agent.',
    {},
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
    async (params) => {
      const agents = listAgents(params.status);
      return successResponse(agents);
    },
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/tools/agent-inbox.ts
git commit -m "feat(mcp): add register_agent, send_to_agent, check_messages, list_agents tools

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Update index.ts — Auto-register + Updated Poller

**Files:**
- Modify: `mcp-server/src/index.ts`

- [ ] **Step 1: Rewrite the post-transport section of index.ts**

Replace everything after `await server.connect(transport);` (line 75 onwards) with:

```typescript
  const { registerAgent, unregisterAgent, checkAgentLiveness } = await import('./agent-registry.js');
  const { myAgentName } = await import('./tools/agent-inbox.js');

  // Auto-register this agent
  const agentName = registerAgent();
  console.error(`[agent] registered as "${agentName}"`);

  // Graceful shutdown — mark agent as disconnected
  const cleanup = () => { unregisterAgent(agentName); process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('beforeExit', () => unregisterAgent(agentName));

  // Background poller: deliver messages to this agent's terminal via tmux
  const POLL_INTERVAL = 3000;
  const agentPid = process.ppid;

  let tmuxTarget: string | null = null;
  try {
    const { execSync: exec } = await import('child_process');
    const ptsPath = exec(`readlink /proc/${agentPid}/fd/0`).toString().trim();
    const panes = exec('tmux list-panes -a -F "#{pane_id} #{pane_tty}"').toString().trim().split('\n');
    for (const line of panes) {
      const [paneId, paneTty] = line.split(' ');
      if (paneTty === ptsPath) { tmuxTarget = paneId; break; }
    }
    if (tmuxTarget) console.error(`[inject] tmux pane ${tmuxTarget} for agent "${agentName}"`);
    else console.error('[inject] agent not in tmux — terminal injection disabled');
  } catch {
    console.error('[inject] tmux not available');
  }

  if (tmuxTarget) {
    const { execSync: exec } = await import('child_process');
    const target = tmuxTarget;

    setInterval(() => {
      try {
        const db = getDb();
        // Check for messages addressed to this agent (from user or other agents)
        const incoming = db.prepare(
          `SELECT * FROM agent_messages WHERE recipient_name = ? AND status IN ('pending', 'answered') AND delivered IS NULL`
        ).all(agentName) as Array<{ id: number; sender_name: string; question: string; response: string | null; status: string }>;

        for (const msg of incoming) {
          db.prepare('UPDATE agent_messages SET delivered = 1 WHERE id = ?').run(msg.id);

          let text: string;
          if (msg.sender_name === 'user' && msg.status === 'pending') {
            // User sent a message TO this agent
            text = `[Message from User]: ${msg.question}`;
          } else if (msg.sender_name !== 'user' && msg.status === 'pending') {
            // Another agent sent a message
            text = `[Message from ${msg.sender_name}]: ${msg.question}`;
          } else if (msg.status === 'answered' && msg.response) {
            // User answered a question this agent asked
            text = `[Inbox Response] to "${msg.question.slice(0, 60)}": ${msg.response}`;
          } else {
            continue;
          }

          try {
            exec(`tmux send-keys -t ${target} ${JSON.stringify(text)} Enter`, { stdio: 'ignore', timeout: 5000 });
            console.error(`[inject] delivered message ${msg.id} to tmux pane ${target}`);
          } catch (err) {
            console.error(`[inject] tmux send-keys failed for message ${msg.id}:`, err);
          }
        }
      } catch { /* ignore */ }
    }, POLL_INTERVAL);
  }
}
```

- [ ] **Step 2: Add liveness checker to the SSE server startup**

In `mcp-server/src/index.ts`, add BEFORE the `if (!httpOnly)` block (after `await startSSEServer();`):

```typescript
// Liveness checker — runs in both http-only and stdio mode
// Periodically checks registered agents and marks dead ones as disconnected
setInterval(async () => {
  try {
    const { checkAgentLiveness } = await import('./agent-registry.js');
    checkAgentLiveness();
  } catch { /* ignore */ }
}, 30_000);
```

- [ ] **Step 3: Verify compilation**

Run: `cd mcp-server && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/index.ts
git commit -m "feat(mcp): auto-register agent on startup, route messages by name

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: SSE Endpoint — User → Agent Messages

**Files:**
- Modify: `mcp-server/src/sse.ts`

- [ ] **Step 1: Add POST /api/agent-messages/send endpoint**

In `mcp-server/src/sse.ts`, add before the catch-all 404, after the dismiss endpoint:

```typescript
// POST /api/agent-messages/send — user sends a message to an agent
if (req.url === '/api/agent-messages/send' && req.method === 'POST') {
  const db = getDb();
  const body = JSON.parse(await readBody(req));
  const { recipient, message: msgText, projectId } = body as { recipient: string; message: string; projectId?: number };

  if (!recipient || !msgText) {
    jsonResponse(res, 400, { error: 'recipient and message are required' });
    return;
  }

  const ts = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO agent_messages (project_id, question, sender_name, recipient_name, status, created_at)
     VALUES (?, ?, 'user', ?, 'pending', ?)`
  ).run(projectId ?? null, msgText, recipient, ts);

  const id = (result as { lastInsertRowid: number }).lastInsertRowid;
  const msg = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
  broadcast('agent_question', { entity: 'agent_message', action: 'agent_question', payload: msg });

  jsonResponse(res, 200, msg);
  return;
}
```

- [ ] **Step 2: Update agent_messages project_id to be nullable**

The `send_to_agent` tool and user→agent messages may not have a project_id. The DB schema already has it as `NOT NULL REFERENCES projects(id)`. We need to make it nullable.

In `mcp-server/src/db.ts`, change the `agent_messages` CREATE TABLE `project_id` column from:

```sql
project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
```

to:

```sql
project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
```

For existing databases, this can't be done via ALTER TABLE (SQLite limitation on modifying constraints). Since `agent_messages` is a new feature with minimal data, add a migration that recreates the table if needed, or simply note that new installs get the nullable version and existing installs should still work since we'll handle NULL project_id in the INSERT.

Actually, the simpler approach: just don't insert NULL — use a default project or skip the constraint. Since the `send_to_agent` and user→agent flows may not have a project, use `project_id = NULL` in the INSERT and rely on the fact that the existing migration already added `sender_name` and `recipient_name` with ALTER TABLE (which doesn't enforce the NOT NULL on project_id for new rows added via ALTER).

Wait — the CREATE TABLE has `NOT NULL` on project_id. New rows MUST have a project_id. Let me fix this properly.

In `mcp-server/src/db.ts`, in the migrations section, add:

```typescript
// Make project_id nullable for agent-to-agent messages
// SQLite can't ALTER column constraints, so we recreate the table
try {
  const hasOldConstraint = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_messages'").get() as { sql: string } | undefined;
  if (hasOldConstraint?.sql?.includes('project_id INTEGER NOT NULL')) {
    db.exec(`
      CREATE TABLE agent_messages_new (
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
        created_at TEXT NOT NULL,
        answered_at TEXT
      );
      INSERT INTO agent_messages_new SELECT
        id, project_id, question, context, choices, response, agent_pid, delivered,
        COALESCE(sender_name, 'unknown'), COALESCE(recipient_name, 'user'),
        status, created_at, answered_at
      FROM agent_messages;
      DROP TABLE agent_messages;
      ALTER TABLE agent_messages_new RENAME TO agent_messages;
    `);
  }
} catch { /* table may not exist yet — fresh install */ }
```

Also update the CREATE TABLE to use the nullable version.

- [ ] **Step 3: Verify compilation**

Run: `cd mcp-server && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/sse.ts mcp-server/src/db.ts
git commit -m "feat(mcp): add user→agent send endpoint, make project_id nullable

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Client-Side Types + Dexie

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/db/database.ts`

- [ ] **Step 1: Add AgentRegistryEntry type and update AgentMessage**

In `src/types/index.ts`, add after the `AgentMessage` interface:

```typescript
export type AgentConnectionStatus = 'connected' | 'disconnected'

export interface AgentRegistryEntry {
  id?: number
  name: string
  projectPath: string
  pid: number
  tmuxPane?: string
  status: AgentConnectionStatus
  connectedAt: Date
  disconnectedAt?: Date
}
```

Update the `AgentMessage` interface to add sender/recipient:

```typescript
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
  createdAt: Date
  answeredAt?: Date
}
```

- [ ] **Step 2: Add agentRegistry Dexie table (version 6)**

In `src/db/database.ts`, add the table declaration:

```typescript
agentRegistry!: Table<AgentRegistryEntry>
```

Add the import for `AgentRegistryEntry`.

Add version 6:

```typescript
this.version(6).stores({
  agentRegistry: '++id, name, status, connectedAt',
  agentMessages: '++id, projectId, senderName, recipientName, status, createdAt',
})
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/db/database.ts
git commit -m "feat(ui): add AgentRegistryEntry type and Dexie table v6

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: SSE Sync for Agent Registry + Updated Message Parser

**Files:**
- Modify: `src/hooks/use-sync.ts`

- [ ] **Step 1: Add parseAgentRegistry function**

After `parseAgentMessage`, add:

```typescript
function parseAgentRegistry(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    name: raw.name as string,
    projectPath: raw.project_path as string,
    pid: raw.pid as number,
    tmuxPane: raw.tmux_pane != null ? (raw.tmux_pane as string) : undefined,
    status: raw.status as 'connected' | 'disconnected',
    connectedAt: new Date(raw.connected_at as string),
    disconnectedAt: raw.disconnected_at ? new Date(raw.disconnected_at as string) : undefined,
  }
}
```

- [ ] **Step 2: Update parseAgentMessage to include sender/recipient**

Update the existing `parseAgentMessage` function to include the new fields:

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
    createdAt: new Date(raw.created_at as string),
    answeredAt: raw.answered_at ? new Date(raw.answered_at as string) : undefined,
  }
}
```

- [ ] **Step 3: Add SSE listeners for agent_connected / agent_disconnected**

In `attachListeners`, add:

```typescript
source.addEventListener('agent_connected', (e) => {
  const { payload } = JSON.parse(e.data)
  if (payload) db.agentRegistry.put(parseAgentRegistry(payload))
})

source.addEventListener('agent_disconnected', (e) => {
  const { payload } = JSON.parse(e.data)
  if (payload) db.agentRegistry.put(parseAgentRegistry(payload))
})
```

- [ ] **Step 4: Add agentRegistry to initialSync**

After the agentMessages sync line, add:

```typescript
if (data.agentRegistry?.length) await db.agentRegistry.bulkPut(data.agentRegistry.map((r: Record<string, unknown>) => parseAgentRegistry(r)))
```

- [ ] **Step 5: Add agentRegistry to data_cleared handler**

```typescript
await db.agentRegistry.clear()
```

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit
git add src/hooks/use-sync.ts
git commit -m "feat(ui): sync agent registry and updated message format via SSE

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Agent Hooks + Updated Message Hooks

**Files:**
- Modify: `src/hooks/use-agent-messages.ts`

- [ ] **Step 1: Add agent registry hooks and sendToAgent**

Replace the entire file with:

```typescript
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'

export function useAgentMessages(agentFilter?: string) {
  return useLiveQuery(() => {
    const query = db.agentMessages.orderBy('createdAt').reverse()
    if (!agentFilter || agentFilter === 'all') return query.toArray()
    return query.filter(m =>
      m.senderName === agentFilter || m.recipientName === agentFilter
    ).toArray()
  }, [agentFilter])
}

export function usePendingCount(agentFilter?: string) {
  return useLiveQuery(async () => {
    if (!agentFilter || agentFilter === 'all') {
      return db.agentMessages.where('status').equals('pending').count()
    }
    const all = await db.agentMessages.where('status').equals('pending').toArray()
    return all.filter(m => m.senderName === agentFilter || m.recipientName === agentFilter).length
  }, [agentFilter])
}

export function useAgentRegistry() {
  return useLiveQuery(
    () => db.agentRegistry.orderBy('connectedAt').reverse().toArray()
  )
}

export function useLiveAgents() {
  return useLiveQuery(
    () => db.agentRegistry.where('status').equals('connected').toArray()
  )
}

export async function respondToMessage(id: number, response: string, port: number) {
  const res = await fetch(`http://localhost:${port}/api/agent-messages/${id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to respond')
  }
  return res.json()
}

export async function dismissMessage(id: number, port: number) {
  const res = await fetch(`http://localhost:${port}/api/agent-messages/${id}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to dismiss')
  }
  return res.json()
}

export async function sendToAgent(recipient: string, message: string, port: number, projectId?: number) {
  const res = await fetch(`http://localhost:${port}/api/agent-messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient, message, projectId }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to send')
  }
  return res.json()
}
```

- [ ] **Step 2: Verify and commit**

```bash
npx tsc --noEmit
git add src/hooks/use-agent-messages.ts
git commit -m "feat(ui): add agent registry hooks, sendToAgent, per-agent filtering

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Agent Sidebar Component

**Files:**
- Create: `src/components/inbox/agent-sidebar.tsx`

- [ ] **Step 1: Create the sidebar component**

```typescript
import { useAgentRegistry, usePendingCount } from '@/hooks/use-agent-messages'
import type { AgentRegistryEntry } from '@/types'

interface AgentSidebarProps {
  selected: string
  onSelect: (name: string) => void
}

export function AgentSidebar({ selected, onSelect }: AgentSidebarProps) {
  const agents = useAgentRegistry()
  const pendingAll = usePendingCount()

  if (!agents) return null

  const now = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000
  const live = agents.filter(a => a.status === 'connected')
  const recent = agents.filter(a => a.status === 'disconnected' && a.disconnectedAt && (now - a.disconnectedAt.getTime()) < DAY_MS)

  return (
    <div className="space-y-4">
      {/* All messages */}
      <button
        onClick={() => onSelect('all')}
        className={`w-full flex items-center gap-3 px-3 py-2 text-xs uppercase tracking-widest font-bold transition-colors border-l-2 ${
          selected === 'all'
            ? 'text-secondary border-secondary'
            : 'text-muted-foreground border-transparent hover:text-foreground'
        }`}
      >
        <span className="material-symbols-outlined text-sm">inbox</span>
        <span className="flex-1 text-left">All</span>
        {pendingAll != null && pendingAll > 0 && (
          <span className="bg-secondary text-secondary-foreground text-[10px] font-bold px-1.5 py-0.5 min-w-[1.25rem] text-center">
            {pendingAll}
          </span>
        )}
      </button>

      {/* Live agents */}
      {live.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest px-3 mb-2">Live</div>
          {live.map(a => (
            <AgentItem key={a.name} agent={a} selected={selected === a.name} onSelect={onSelect} />
          ))}
        </div>
      )}

      {/* Recent agents */}
      {recent.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest px-3 mb-2">Recent</div>
          {recent.map(a => (
            <AgentItem key={a.name} agent={a} selected={selected === a.name} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

function AgentItem({ agent, selected, onSelect }: { agent: AgentRegistryEntry; selected: boolean; onSelect: (name: string) => void }) {
  const isLive = agent.status === 'connected'

  return (
    <button
      onClick={() => onSelect(agent.name)}
      className={`w-full flex items-center gap-3 px-3 py-2 text-xs uppercase tracking-widest font-bold transition-colors border-l-2 ${
        selected
          ? 'text-secondary border-secondary'
          : 'text-muted-foreground border-transparent hover:text-foreground'
      }`}
    >
      <span className={`relative flex h-2 w-2 shrink-0`}>
        {isLive && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#69fd5d] opacity-75" />}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${isLive ? 'bg-[#69fd5d]' : 'bg-muted-foreground/30'}`} />
      </span>
      <span className="flex-1 text-left truncate">{agent.name}</span>
    </button>
  )
}
```

- [ ] **Step 2: Create the directory and verify**

```bash
mkdir -p src/components/inbox
npx tsc --noEmit
git add src/components/inbox/agent-sidebar.tsx
git commit -m "feat(ui): add agent sidebar component for inbox

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Compose Box Component

**Files:**
- Create: `src/components/inbox/compose-box.tsx`

- [ ] **Step 1: Create the compose box**

```typescript
import { useState } from 'react'
import { sendToAgent } from '@/hooks/use-agent-messages'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ComposeBoxProps {
  recipient: string
  port: number
}

export function ComposeBox({ recipient, port }: ComposeBoxProps) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    if (!input.trim()) return
    setSending(true)
    try {
      await sendToAgent(recipient, input.trim(), port)
      setInput('')
    } catch (err) {
      console.error('Failed to send:', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t border-border p-4 bg-card">
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleSend() }}
          placeholder={`Send message to ${recipient}...`}
          disabled={sending}
          className="bg-muted/30 border-border text-sm"
        />
        <Button
          onClick={handleSend}
          disabled={sending || !input.trim()}
          className="uppercase tracking-widest text-xs font-bold"
        >
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify and commit**

```bash
npx tsc --noEmit
git add src/components/inbox/compose-box.tsx
git commit -m "feat(ui): add compose box component for user→agent messaging

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Inbox Page — New Layout with Sidebar

**Files:**
- Modify: `src/routes/agent-inbox.tsx`

- [ ] **Step 1: Rewrite the inbox page layout**

Replace the `AgentInbox` default export function with:

```typescript
export default function AgentInbox() {
  const messages = useAgentMessages()
  const projects = useProjects()
  const port = Number(useSetting('serverPort'))
  const [agentFilter, setAgentFilter] = useState('all')
  const [showAnswered, setShowAnswered] = useState(false)

  const filteredMessages = useAgentMessages(agentFilter)

  if (!filteredMessages || !projects) return null

  const projectMap = new Map(projects.map(p => [p.id!, p]))

  const pending = filteredMessages.filter(m => m.status === 'pending')
  const answered = filteredMessages.filter(m => m.status === 'answered' || m.status === 'dismissed')

  const answeredByDate = answered.reduce<Record<string, AgentMessage[]>>((acc, m) => {
    const dateKey = m.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    if (!acc[dateKey]) acc[dateKey] = []
    acc[dateKey].push(m)
    return acc
  }, {})

  return (
    <div className="flex h-full">
      {/* Left sidebar — agent list */}
      <div className="w-48 shrink-0 border-r border-border py-4 overflow-y-auto">
        <AgentSidebar selected={agentFilter} onSelect={setAgentFilter} />
      </div>

      {/* Main panel */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full space-y-8">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="relative flex h-2 w-2">
                  {pending.length > 0 && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${pending.length > 0 ? 'bg-secondary' : 'bg-muted-foreground/30'}`} />
                </span>
                <span className="text-xs tracking-widest uppercase text-secondary font-bold">
                  Agent Comms
                </span>
              </div>
              <h1 className="text-3xl md:text-5xl font-bold tracking-tighter uppercase leading-none">
                Agent <span className="text-secondary">Inbox</span>
              </h1>
              <p className="text-xs text-muted-foreground uppercase tracking-widest mt-2">
                {agentFilter === 'all' ? `${pending.length} pending` : `${agentFilter} — ${pending.length} pending`}
              </p>
            </div>
          </div>

          {/* Pending */}
          {pending.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-xs tracking-widest uppercase font-bold text-secondary flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">pending</span>
                Awaiting Response
              </h2>
              {pending.map(m => (
                <MessageCard key={m.id} message={m} project={m.projectId ? projectMap.get(m.projectId) : undefined} port={port} />
              ))}
            </section>
          )}

          {/* Answered */}
          {answered.length > 0 && (
            <section className="space-y-4">
              <button
                onClick={() => setShowAnswered(!showAnswered)}
                className="text-xs tracking-widest uppercase font-bold text-muted-foreground flex items-center gap-2 hover:text-foreground transition-colors"
              >
                <span className="material-symbols-outlined text-sm">check_circle</span>
                Answered ({answered.length})
                <span className="material-symbols-outlined text-sm">
                  {showAnswered ? 'expand_less' : 'expand_more'}
                </span>
              </button>
              {showAnswered && Object.entries(answeredByDate).map(([date, msgs]) => (
                <div key={date} className="space-y-2">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1">{date}</div>
                  {msgs.map(m => (
                    <AnsweredCard key={m.id} message={m} project={m.projectId ? projectMap.get(m.projectId) : undefined} />
                  ))}
                </div>
              ))}
            </section>
          )}

          {/* Empty */}
          {filteredMessages.length === 0 && (
            <div className="text-center py-16">
              <span className="material-symbols-outlined text-5xl text-muted-foreground/30 mb-4 block">inbox</span>
              <p className="text-xs text-muted-foreground uppercase tracking-widest">
                {agentFilter === 'all' ? 'No agent questions yet' : `No messages for ${agentFilter}`}
              </p>
            </div>
          )}
        </div>

        {/* Compose box — only when a specific agent is selected */}
        {agentFilter !== 'all' && (
          <ComposeBox recipient={agentFilter} port={port} />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Update imports at the top of the file**

Add the new imports:

```typescript
import { useAgentMessages, respondToMessage, dismissMessage } from '@/hooks/use-agent-messages'
import { AgentSidebar } from '@/components/inbox/agent-sidebar'
import { ComposeBox } from '@/components/inbox/compose-box'
```

Remove the old `ProjectFilter` import since we replaced it with the agent sidebar.

- [ ] **Step 3: Add sender badge to MessageCard**

In the `MessageCard` component, after the project badge in the header, add a sender badge:

```typescript
<span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">
  {message.senderName === 'user' ? 'You →' : `${message.senderName} →`}
</span>
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit
npx vite build
git add src/routes/agent-inbox.tsx
git commit -m "feat(ui): inbox sidebar layout with agent list and compose box

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Build, Rebuild MCP, Restart, Verify

**Files:** None (verification only)

- [ ] **Step 1: Type check everything**

```bash
npx tsc --noEmit
cd mcp-server && npx tsc --noEmit
```

- [ ] **Step 2: Build MCP server**

```bash
cd mcp-server && npm run build
```

- [ ] **Step 3: Build frontend**

```bash
npx vite build
```

- [ ] **Step 4: Restart SSE server**

```bash
lsof -i :3456 -t | xargs kill; sleep 4; curl -s http://localhost:3456/healthz
```

- [ ] **Step 5: Verify agent registry endpoint**

```bash
curl -s http://localhost:3456/sync | python3 -c "import sys,json; d=json.load(sys.stdin); print('agentRegistry:', len(d.get('agentRegistry',[])))"
```

- [ ] **Step 6: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address verification findings

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
