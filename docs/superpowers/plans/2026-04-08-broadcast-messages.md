# Broadcast Messages (Group Chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional broadcast messaging — send one question to multiple agents simultaneously, grouped as a "group chat" thread via a shared `broadcast_id`.

**Architecture:** Add an optional `broadcast_id` column to `agent_messages`. A new `broadcast_agents` MCP tool inserts one message per recipient sharing the same `broadcast_id` (a UUID). The frontend groups messages by `broadcast_id` when present, showing a single question with per-agent response status. Fully backward-compatible — all existing single-agent messaging is unchanged.

**Tech Stack:** SQLite (better-sqlite3), Zod, Dexie.js, React, TypeScript

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `mcp-server/src/db.ts` | Add `broadcast_id` column + index |
| Modify | `mcp-server/src/tools/agent-inbox.ts` | Add `broadcast_agents` + `check_broadcast` tools |
| Modify | `src/types/index.ts` | Add `broadcastId` to `AgentMessage` interface |
| Modify | `src/db/database.ts` | Dexie v8 schema with `broadcastId` index |
| Modify | `src/hooks/use-sync.ts` | Parse `broadcast_id` in `parseAgentMessage` |
| Modify | `src/routes/agent-inbox.tsx` | Group broadcast messages in chat view |

---

### Task 1: Add `broadcast_id` column to SQLite

**Files:**
- Modify: `mcp-server/src/db.ts:97-112`

- [ ] **Step 1: Add column and index to schema**

In `mcp-server/src/db.ts`, add `broadcast_id TEXT` to the `agent_messages` CREATE TABLE and add an index. Find this block:

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  ...
  answered_at TEXT
);
```

Add `broadcast_id TEXT` before `answered_at TEXT`:

```sql
  broadcast_id TEXT,
  answered_at TEXT
```

Add after the existing agent_messages indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_agent_messages_broadcast_id ON agent_messages(broadcast_id);
```

- [ ] **Step 2: Add migration for existing databases**

After the CREATE TABLE statements (around line 134, after all CREATE INDEX statements), add an ALTER TABLE migration wrapped in a try-catch since the column may already exist:

```typescript
// In the initDb function, after the db.exec(...) block:
try {
  db.exec(`ALTER TABLE agent_messages ADD COLUMN broadcast_id TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_broadcast_id ON agent_messages(broadcast_id)`);
} catch {
  // Column already exists — ignore
}
```

- [ ] **Step 3: Verify MCP server starts without errors**

Run: `cd mcp-server && npx tsx src/index.ts --help` or just check that it compiles:
```bash
cd /home/dalmas/E/projects/local_task_tracker/task_flow/mcp-server && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/db.ts
git commit -m "feat: add broadcast_id column to agent_messages table"
```

---

### Task 2: Add `broadcast_agents` and `check_broadcast` MCP tools

**Files:**
- Modify: `mcp-server/src/tools/agent-inbox.ts`

- [ ] **Step 1: Add `broadcast_agents` tool**

In `mcp-server/src/tools/agent-inbox.ts`, inside the `registerAgentInboxTools` function (after the `list_agents` tool registration, before the closing `}`), add:

```typescript
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
      // Validate all agents exist
      for (const name of params.agents) {
        const agent = getAgent(name);
        if (!agent) return errorResponse(`Agent "${name}" not found`, 'NOT_FOUND');
      }
      recipients = params.agents;
    } else {
      // Broadcast to all connected agents (excluding self)
      const connected = listAgents('connected');
      recipients = connected
        .map((a: Record<string, unknown>) => a.name as string)
        .filter((n: string) => n !== senderName);
      if (recipients.length === 0) return errorResponse('No other connected agents to broadcast to', 'VALIDATION_ERROR');
    }

    // Validate project if provided
    if (params.project_id) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(params.project_id);
      if (!project) return errorResponse(`Project ${params.project_id} not found`, 'NOT_FOUND');
    }

    // Generate broadcast ID
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
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /home/dalmas/E/projects/local_task_tracker/task_flow/mcp-server && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/tools/agent-inbox.ts
git commit -m "feat: add broadcast_agents and check_broadcast MCP tools"
```

---

### Task 3: Add `broadcastId` to frontend types, Dexie schema, and sync parser

**Files:**
- Modify: `src/types/index.ts:125-138`
- Modify: `src/db/database.ts:44-46`
- Modify: `src/hooks/use-sync.ts:355-370`

- [ ] **Step 1: Add `broadcastId` to AgentMessage interface**

In `src/types/index.ts`, add `broadcastId` to the `AgentMessage` interface:

```typescript
export interface AgentMessage {
  id?: number
  projectId?: number
  broadcastId?: string          // ← add this line
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

- [ ] **Step 2: Add Dexie v8 schema with broadcastId index**

In `src/db/database.ts`, add a new version after v7:

```typescript
this.version(8).stores({
  agentMessages: '++id, projectId, senderName, recipientName, status, source, broadcastId, createdAt',
})
```

- [ ] **Step 3: Parse `broadcast_id` in sync hook**

In `src/hooks/use-sync.ts`, in the `parseAgentMessage` function, add `broadcastId`:

```typescript
function parseAgentMessage(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    projectId: raw.project_id != null ? (raw.project_id as number) : undefined,
    broadcastId: raw.broadcast_id != null ? (raw.broadcast_id as string) : undefined,  // ← add this line
    senderName: (raw.sender_name as string) ?? 'unknown',
    // ... rest unchanged
  }
}
```

- [ ] **Step 4: Verify frontend compiles**

```bash
cd /home/dalmas/E/projects/local_task_tracker/task_flow && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/db/database.ts src/hooks/use-sync.ts
git commit -m "feat: add broadcastId to frontend types, Dexie schema, and sync parser"
```

---

### Task 4: Group broadcast messages in chat UI

**Files:**
- Modify: `src/routes/agent-inbox.tsx`

- [ ] **Step 1: Add broadcast grouping logic**

In `src/routes/agent-inbox.tsx`, after the `sorted` / `visible` computation (around line 46), add grouping logic. Replace the message rendering section inside the scrollable div (the `visible.map(m => ...)` block) with logic that groups broadcast messages:

Before the `ChatBubble` component definition, add a helper to group messages:

```typescript
/** Group consecutive broadcast messages by broadcastId */
function groupMessages(messages: AgentMessage[]): Array<{ type: 'single'; message: AgentMessage } | { type: 'broadcast'; broadcastId: string; messages: AgentMessage[] }> {
  const groups: Array<{ type: 'single'; message: AgentMessage } | { type: 'broadcast'; broadcastId: string; messages: AgentMessage[] }> = []
  const broadcastMap = new Map<string, AgentMessage[]>()

  for (const m of messages) {
    if (m.broadcastId) {
      const existing = broadcastMap.get(m.broadcastId)
      if (existing) {
        existing.push(m)
      } else {
        const group: AgentMessage[] = [m]
        broadcastMap.set(m.broadcastId, group)
        groups.push({ type: 'broadcast', broadcastId: m.broadcastId, messages: group })
      }
    } else {
      groups.push({ type: 'single', message: m })
    }
  }

  return groups
}
```

- [ ] **Step 2: Update the message list rendering**

Replace the `visible.map(m => ...)` block with:

```tsx
{groupMessages(visible).map((group) => {
  if (group.type === 'single') {
    return (
      <ChatBubble
        key={group.message.id}
        message={group.message}
        project={group.message.projectId ? projectMap.get(group.message.projectId) : undefined}
        port={port}
      />
    )
  }
  return (
    <BroadcastGroup
      key={group.broadcastId}
      messages={group.messages}
      projectMap={projectMap}
      port={port}
    />
  )
})}
```

- [ ] **Step 3: Add `BroadcastGroup` component**

Add this component in the same file, after the `ChatBubble` component:

```tsx
function BroadcastGroup({
  messages,
  projectMap,
  port,
}: {
  messages: AgentMessage[]
  projectMap: Map<number, { name: string; color: string }>
  port: number
}) {
  const first = messages[0]
  const project = first.projectId ? projectMap.get(first.projectId) : undefined
  const answered = messages.filter(m => m.status === 'answered').length
  const total = messages.length

  return (
    <div className="flex flex-col items-start">
      {/* Broadcast header */}
      <div className="flex items-center gap-2 mb-1">
        {project && (
          <span
            className="text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 border"
            style={{ borderColor: project.color, color: project.color }}
          >
            {project.name}
          </span>
        )}
        <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">
          {first.senderName}
        </span>
        <span className="text-[9px] text-muted-foreground/50 uppercase tracking-widest flex items-center gap-1">
          <span className="material-symbols-outlined text-xs">group</span>
          broadcast · {answered}/{total} replied
        </span>
        <span className="text-[10px] text-muted-foreground/60">{getTimeAgo(first.createdAt)}</span>
      </div>

      {/* Shared question bubble */}
      <div className="max-w-[85%] bg-card border-l-2 border-l-secondary border border-secondary/30 px-4 py-3 space-y-3">
        {first.context && (
          <div className="text-sm text-muted-foreground prose prose-sm dark:prose-invert max-w-none prose-headings:text-muted-foreground prose-headings:text-sm prose-headings:font-bold prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-pre:overflow-x-auto prose-code:break-all">
            <ReactMarkdown>{unescapeMarkdown(first.context)}</ReactMarkdown>
          </div>
        )}
        <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-sm prose-headings:font-bold prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-pre:overflow-x-auto prose-code:break-all">
          <ReactMarkdown>{unescapeMarkdown(first.question)}</ReactMarkdown>
        </div>

        {/* Per-agent responses */}
        <div className="border-t border-border/50 pt-2 space-y-2">
          {messages.map(m => (
            <div key={m.id} className="flex items-start gap-2">
              <span className={`text-[10px] uppercase tracking-widest font-bold min-w-[80px] ${
                m.status === 'answered' ? 'text-emerald-400' : m.status === 'dismissed' ? 'text-muted-foreground/50' : 'text-secondary'
              }`}>
                {m.recipientName}
              </span>
              {m.status === 'pending' && (
                <span className="text-[10px] text-muted-foreground/50 uppercase tracking-widest flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse" />
                  waiting
                </span>
              )}
              {m.status === 'answered' && m.response && (
                <div className="text-sm prose prose-sm dark:prose-invert max-w-none min-w-0 prose-p:my-0">
                  <ReactMarkdown>{unescapeMarkdown(m.response)}</ReactMarkdown>
                </div>
              )}
              {m.status === 'dismissed' && (
                <span className="text-[10px] text-muted-foreground/50 uppercase tracking-widest">dismissed</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify it compiles and renders**

```bash
cd /home/dalmas/E/projects/local_task_tracker/task_flow && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/routes/agent-inbox.tsx
git commit -m "feat: group broadcast messages in inbox chat UI"
```

---

## Summary

4 tasks, ~6 files modified. The feature is fully optional — `broadcast_id` is nullable, existing tools are untouched, and single messages render exactly as before. The new `broadcast_agents` tool creates linked messages, and the UI groups them into a clean "group chat" view showing per-agent response status.
