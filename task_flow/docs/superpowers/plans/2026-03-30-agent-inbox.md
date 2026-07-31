# Agent Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable agents to ask users questions via MCP that appear in the TaskFlow UI, where users can respond remotely — even from their phone.

**Architecture:** New `agent_messages` SQLite table stores questions/responses. The `ask_user` MCP tool inserts a pending message and blocks via an in-memory Promise map until the UI responds via `POST /api/agent-messages/:id/respond`. SSE broadcasts keep the UI in sync. A new Dexie table + React page renders the inbox.

**Tech Stack:** SQLite (server), Dexie (client), Recharts n/a, React + shadcn/ui, SSE, MCP tool

---

## File Structure

### MCP Server (new files)
- `mcp-server/src/tools/agent-inbox.ts` — `ask_user` MCP tool + in-memory Promise map
- `mcp-server/src/pending-questions.ts` — Shared pending question resolver map (separated so SSE handler can access it)

### MCP Server (modified files)
- `mcp-server/src/db.ts` — Add `agent_messages` table to schema
- `mcp-server/src/sse.ts` — Add `POST /api/agent-messages/:id/respond` HTTP endpoint
- `mcp-server/src/index.ts` — Register `registerAgentInboxTools`
- `mcp-server/src/types.ts` — Add `AgentMessageStatus` Zod schema, new `ActivityAction` values

### UI (new files)
- `src/routes/agent-inbox.tsx` — Inbox page component
- `src/hooks/use-agent-messages.ts` — Dexie live query hooks

### UI (modified files)
- `src/types/index.ts` — Add `AgentMessage` interface
- `src/db/database.ts` — Add `agentMessages` Dexie table (version 5)
- `src/hooks/use-sync.ts` — Add SSE listeners for `agent_question` and `agent_question_answered`
- `src/App.tsx` — Add `/inbox` route
- `src/components/app-sidebar.tsx` — Add Inbox nav item with pending badge

---

### Task 1: Database Schema — `agent_messages` table

**Files:**
- Modify: `mcp-server/src/db.ts`
- Modify: `mcp-server/src/types.ts`

- [ ] **Step 1: Add AgentMessageStatus to types.ts**

In `mcp-server/src/types.ts`, add after the `NotificationType` definition:

```typescript
export const AgentMessageStatus = z.enum(['pending', 'answered']);
export type AgentMessageStatus = z.infer<typeof AgentMessageStatus>;
```

Also update the `ActivityAction` enum to include the new actions — add `'agent_question'` and `'agent_question_answered'` to the array:

```typescript
export const ActivityAction = z.enum([
  'task_created', 'task_deleted', 'task_status_changed', 'task_completed',
  'task_partial_done', 'timer_started', 'timer_paused', 'timer_stopped',
  'project_created', 'project_deleted', 'project_updated',
  'tasks_bulk_created', 'settings_saved', 'data_seeded', 'data_cleared',
  'task_linked', 'task_unlinked', 'dependency_added', 'dependency_removed',
  'link_added', 'tag_added', 'tag_removed', 'debug_log',
  'agent_question', 'agent_question_answered',
]);
```

And add a new error code to `ErrorCode`:

```typescript
export type ErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'VALIDATION_ERROR'
  | 'CYCLE_DETECTED'
  | 'SESSION_ALREADY_ACTIVE'
  | 'NO_ACTIVE_SESSION'
  | 'ALREADY_ANSWERED';
```

- [ ] **Step 2: Add agent_messages table to db.ts**

In `mcp-server/src/db.ts`, inside the `initSchema` function, add after the existing `CREATE TABLE IF NOT EXISTS` statements:

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  context TEXT,
  choices TEXT,
  response TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  answered_at TEXT
);
```

And add an index:

```sql
CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status);
CREATE INDEX IF NOT EXISTS idx_agent_messages_project_id ON agent_messages(project_id);
```

- [ ] **Step 3: Add agent_messages to the /sync endpoint in sse.ts**

In `mcp-server/src/sse.ts`, inside the `/sync` GET handler (around line 94-103), add `agentMessages` to the sync response:

```typescript
if (req.url === '/sync' && req.method === 'GET') {
  const db = getDb();
  const tasks = db.prepare('SELECT * FROM tasks').all();
  const projects = db.prepare('SELECT * FROM projects').all();
  const sessions = db.prepare('SELECT * FROM sessions').all();
  const settings = db.prepare('SELECT * FROM settings').all();
  const activityLogs = db.prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 200').all();
  const agentMessages = db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT 100').all();

  jsonResponse(res, 200, { tasks, projects, sessions, settings, activityLogs, agentMessages });
  return;
}
```

- [ ] **Step 4: Add agent_messages to clear-data handler**

In the `/api/clear-data` POST handler in `sse.ts`, add:

```typescript
db.exec('DELETE FROM agent_messages');
```

- [ ] **Step 5: Verify MCP server compiles**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: No errors (the new table is DDL only, no tool code yet)

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/db.ts mcp-server/src/types.ts mcp-server/src/sse.ts
git commit -m "feat(mcp): add agent_messages table schema and sync"
```

---

### Task 2: Pending Questions Resolver Map

**Files:**
- Create: `mcp-server/src/pending-questions.ts`

This module holds the in-memory `Map<number, { resolve }>` that bridges the MCP tool (which blocks) and the HTTP endpoint (which resolves). It's a separate module so both `tools/agent-inbox.ts` and `sse.ts` can import it without circular dependencies.

- [ ] **Step 1: Create pending-questions.ts**

Create `mcp-server/src/pending-questions.ts`:

```typescript
interface PendingQuestion {
  resolve: (response: string) => void;
}

const pending = new Map<number, PendingQuestion>();

export function addPending(id: number): Promise<string> {
  return new Promise<string>((resolve) => {
    pending.set(id, { resolve });
  });
}

export function resolvePending(id: number, response: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.resolve(response);
  pending.delete(id);
  return true;
}

export function hasPending(id: number): boolean {
  return pending.has(id);
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/pending-questions.ts
git commit -m "feat(mcp): add in-memory pending question resolver map"
```

---

### Task 3: `ask_user` MCP Tool

**Files:**
- Create: `mcp-server/src/tools/agent-inbox.ts`
- Modify: `mcp-server/src/index.ts`

- [ ] **Step 1: Create agent-inbox.ts tool module**

Create `mcp-server/src/tools/agent-inbox.ts`:

```typescript
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
```

- [ ] **Step 2: Register the tool in index.ts**

In `mcp-server/src/index.ts`, add the import alongside the other tool imports:

```typescript
const { registerAgentInboxTools } = await import('./tools/agent-inbox.js');
```

And add the registration call after the other `register*Tools` calls:

```typescript
registerAgentInboxTools(server);
```

- [ ] **Step 3: Verify compilation**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/agent-inbox.ts mcp-server/src/index.ts
git commit -m "feat(mcp): add ask_user tool that blocks until UI responds"
```

---

### Task 4: HTTP Response Endpoint

**Files:**
- Modify: `mcp-server/src/sse.ts`

- [ ] **Step 1: Add POST /api/agent-messages/:id/respond endpoint**

In `mcp-server/src/sse.ts`, add the import at the top:

```typescript
import { resolvePending } from './pending-questions.js';
```

Then add the endpoint handler before the catch-all 404, alongside the other mutation endpoints:

```typescript
// POST /api/agent-messages/:id/respond — user responds to an agent question
const agentRespondMatch = req.url?.match(/^\/api\/agent-messages\/(\d+)\/respond$/);
if (agentRespondMatch && req.method === 'POST') {
  const db = getDb();
  const id = Number(agentRespondMatch[1]);

  const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!message) {
    jsonResponse(res, 404, { error: 'Message not found' });
    return;
  }
  if (message.status === 'answered') {
    jsonResponse(res, 400, { error: 'Already answered' });
    return;
  }

  const body = JSON.parse(await readBody(req));
  const response = body.response as string;
  if (!response) {
    jsonResponse(res, 400, { error: 'Response is required' });
    return;
  }

  const ts = new Date().toISOString();
  db.prepare('UPDATE agent_messages SET response = ?, status = ?, answered_at = ? WHERE id = ?')
    .run(response, 'answered', ts, id);

  // Resolve the blocking MCP tool call
  resolvePending(id, response);

  const updated = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
  broadcast('agent_question_answered', { entity: 'agent_message', action: 'agent_question_answered', payload: updated });
  logActivity('agent_question_answered', `Responded to: ${message.question}`, { entityType: 'agent_message', entityId: id });

  jsonResponse(res, 200, updated);
  return;
}
```

Note: `broadcast` is already available in `sse.ts` via the local `broadcastLocal` function. Use the module-level `broadcast` function (check if it's exported or use `broadcastLocal` directly — it's defined in the same file).

- [ ] **Step 2: Verify compilation**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/sse.ts
git commit -m "feat(mcp): add HTTP endpoint for responding to agent questions"
```

---

### Task 5: Client-Side Types and Dexie Schema

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/db/database.ts`

- [ ] **Step 1: Add AgentMessage type**

In `src/types/index.ts`, add at the end of the file:

```typescript
export type AgentMessageStatus = 'pending' | 'answered'

export interface AgentMessage {
  id?: number
  projectId: number
  question: string
  context?: string
  choices?: string[]
  response?: string
  status: AgentMessageStatus
  createdAt: Date
  answeredAt?: Date
}
```

- [ ] **Step 2: Add agentMessages Dexie table**

In `src/db/database.ts`, add the table declaration in the class:

```typescript
agentMessages!: Table<AgentMessage>
```

And add a new version after version 4:

```typescript
this.version(5).stores({
  agentMessages: '++id, projectId, status, createdAt',
})
```

Don't forget to add the import at the top:

```typescript
import type { Task, Project, Session, Setting, AppNotification, ActivityLog, AgentMessage } from '@/types'
```

- [ ] **Step 3: Verify UI compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/db/database.ts
git commit -m "feat(ui): add AgentMessage type and Dexie table"
```

---

### Task 6: SSE Sync for Agent Messages

**Files:**
- Modify: `src/hooks/use-sync.ts`

- [ ] **Step 1: Add parseAgentMessage function**

In `src/hooks/use-sync.ts`, add after the existing `parseActivityLog` function:

```typescript
function parseAgentMessage(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    projectId: raw.project_id != null ? (raw.project_id as number) : undefined,
    question: raw.question as string,
    context: raw.context != null ? (raw.context as string) : undefined,
    choices: parseJsonField(raw.choices, undefined),
    response: raw.response != null ? (raw.response as string) : undefined,
    status: raw.status as 'pending' | 'answered',
    createdAt: new Date(raw.created_at as string),
    answeredAt: raw.answered_at ? new Date(raw.answered_at as string) : undefined,
  }
}
```

Note: For `choices`, we need to handle it differently since it can be `null` or a JSON array. Update the call to use:
```typescript
choices: raw.choices != null ? parseJsonField(raw.choices, []) : undefined,
```

- [ ] **Step 2: Add SSE event listeners in attachListeners**

In the `attachListeners` function, add after the `activity_cleared` listener:

```typescript
source.addEventListener('agent_question', (e) => {
  const { payload } = JSON.parse(e.data)
  if (payload) db.agentMessages.put(parseAgentMessage(payload))
})

source.addEventListener('agent_question_answered', (e) => {
  const { payload } = JSON.parse(e.data)
  if (payload) db.agentMessages.put(parseAgentMessage(payload))
})
```

- [ ] **Step 3: Add agentMessages to initialSync**

In the `initialSync` function, after the `activityLogs` sync line, add:

```typescript
if (data.agentMessages?.length) await db.agentMessages.bulkPut(data.agentMessages.map((m: Record<string, unknown>) => parseAgentMessage(m)))
```

- [ ] **Step 4: Add agentMessages to data_cleared handler**

In the `data_cleared` listener, add:

```typescript
await db.agentMessages.clear()
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-sync.ts
git commit -m "feat(ui): sync agent messages via SSE events"
```

---

### Task 7: Agent Messages Hook

**Files:**
- Create: `src/hooks/use-agent-messages.ts`

- [ ] **Step 1: Create the hook**

Create `src/hooks/use-agent-messages.ts`:

```typescript
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import { useSetting } from '@/hooks/use-settings'

export function useAgentMessages() {
  return useLiveQuery(
    () => db.agentMessages.orderBy('createdAt').reverse().toArray()
  )
}

export function usePendingCount() {
  return useLiveQuery(async () => {
    return db.agentMessages.where('status').equals('pending').count()
  })
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
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-agent-messages.ts
git commit -m "feat(ui): add useAgentMessages hook and respond function"
```

---

### Task 8: Agent Inbox Page

**Files:**
- Create: `src/routes/agent-inbox.tsx`

- [ ] **Step 1: Create the inbox page**

Create `src/routes/agent-inbox.tsx`:

```typescript
import { useState } from 'react'
import { useAgentMessages, usePendingCount, respondToMessage } from '@/hooks/use-agent-messages'
import { useProjects } from '@/hooks/use-projects'
import { useSetting } from '@/hooks/use-settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProjectFilter } from '@/components/charts/project-filter'
import type { AgentMessage } from '@/types'

export default function AgentInbox() {
  const messages = useAgentMessages()
  const projects = useProjects()
  const port = Number(useSetting('serverPort'))
  const [projectFilter, setProjectFilter] = useState('all')

  if (!messages || !projects) return null

  const projectMap = new Map(projects.map(p => [p.id!, p]))

  const filtered = projectFilter === 'all'
    ? messages
    : messages.filter(m => m.projectId === Number(projectFilter))

  const pending = filtered.filter(m => m.status === 'pending')
  const answered = filtered.filter(m => m.status === 'answered')

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
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
            {pending.length} pending {pending.length === 1 ? 'question' : 'questions'}
          </p>
        </div>
        <ProjectFilter value={projectFilter} onChange={setProjectFilter} />
      </div>

      {/* Pending Questions */}
      {pending.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xs tracking-widest uppercase font-bold text-secondary flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">pending</span>
            Awaiting Response
          </h2>
          {pending.map(m => (
            <MessageCard key={m.id} message={m} project={projectMap.get(m.projectId)} port={port} />
          ))}
        </section>
      )}

      {/* Answered */}
      {answered.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xs tracking-widest uppercase font-bold text-muted-foreground flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">check_circle</span>
            Answered
          </h2>
          {answered.map(m => (
            <AnsweredCard key={m.id} message={m} project={projectMap.get(m.projectId)} />
          ))}
        </section>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="text-center py-16">
          <span className="material-symbols-outlined text-5xl text-muted-foreground/30 mb-4 block">inbox</span>
          <p className="text-xs text-muted-foreground uppercase tracking-widest">
            No agent questions yet
          </p>
        </div>
      )}
    </div>
  )
}

function MessageCard({
  message,
  project,
  port,
}: {
  message: AgentMessage
  project?: { name: string; color: string }
  port: number
}) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const handleRespond = async (response: string) => {
    if (!response.trim() || !message.id) return
    setSending(true)
    try {
      await respondToMessage(message.id, response.trim(), port)
    } catch (err) {
      console.error('Failed to respond:', err)
    } finally {
      setSending(false)
      setInput('')
    }
  }

  const timeAgo = getTimeAgo(message.createdAt)

  return (
    <div className="bg-card border border-secondary/20 shadow-[0_0_15px_rgba(222,142,255,0.05)] p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {project && (
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 border" style={{ borderColor: project.color, color: project.color }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: project.color }} />
              {project.name}
            </span>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground uppercase tracking-widest">{timeAgo}</span>
      </div>

      {/* Context (markdown rendered as pre-formatted for now) */}
      {message.context && (
        <div className="bg-muted/50 border border-border p-4 text-sm whitespace-pre-wrap font-mono text-muted-foreground max-h-64 overflow-y-auto">
          {message.context}
        </div>
      )}

      {/* Question */}
      <p className="text-lg font-bold">{message.question}</p>

      {/* Choice buttons */}
      {message.choices && message.choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {message.choices.map((choice) => (
            <Button
              key={choice}
              variant="outline"
              disabled={sending}
              className="uppercase tracking-widest text-xs font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary"
              onClick={() => handleRespond(choice)}
            >
              {choice}
            </Button>
          ))}
        </div>
      )}

      {/* Free-text input */}
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleRespond(input) }}
          placeholder="Type a response..."
          disabled={sending}
          className="bg-muted/30 border-border text-sm"
        />
        <Button
          onClick={() => handleRespond(input)}
          disabled={sending || !input.trim()}
          className="uppercase tracking-widest text-xs font-bold"
        >
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </div>
    </div>
  )
}

function AnsweredCard({
  message,
  project,
}: {
  message: AgentMessage
  project?: { name: string; color: string }
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className="bg-card border border-border p-4 cursor-pointer hover:border-muted-foreground/30 transition-colors"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {project && (
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
          )}
          <span className="text-sm font-bold truncate">{message.question}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {getTimeAgo(message.createdAt)}
          </span>
          <span className="material-symbols-outlined text-sm text-muted-foreground">
            {expanded ? 'expand_less' : 'expand_more'}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          {message.context && (
            <div className="bg-muted/50 border border-border p-3 text-xs whitespace-pre-wrap font-mono text-muted-foreground max-h-48 overflow-y-auto">
              {message.context}
            </div>
          )}
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-sm text-secondary mt-0.5">reply</span>
            <span className="text-sm">{message.response}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/routes/agent-inbox.tsx
git commit -m "feat(ui): add Agent Inbox page with pending/answered sections"
```

---

### Task 9: Route and Navigation Integration

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/app-sidebar.tsx`

- [ ] **Step 1: Add route to App.tsx**

In `src/App.tsx`, add the import:

```typescript
import AgentInbox from '@/routes/agent-inbox'
```

Add the route inside `<Route element={<RootLayout />}>`, before the catch-all:

```typescript
<Route path="inbox" element={<AgentInbox />} />
```

- [ ] **Step 2: Add nav item with pending badge to sidebar**

In `src/components/app-sidebar.tsx`, add the import:

```typescript
import { usePendingCount } from '@/hooks/use-agent-messages'
```

Update the `navItems` array — add after the "Activity Pulse" entry:

```typescript
{ label: "Agent Inbox", to: "/inbox", icon: "inbox" },
```

Now update `SidebarNavLink` to support an optional badge. Change the component signature and body:

```typescript
function SidebarNavLink({ to, icon, label, badge }: { to: string; icon: string; label: string; badge?: number }) {
  const resolved = useResolvedPath(to)
  const match = useMatch({ path: resolved.pathname, end: true })
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <SidebarMenuItem>
      <NavLink
        to={to}
        onClick={() => { if (isMobile) setOpenMobile(false) }}
        className={`flex items-center gap-4 px-3 py-2 uppercase text-sm tracking-widest font-headline transition-all duration-200 border-l-2 ${
          match
            ? "text-secondary border-secondary"
            : "text-gray-500 border-transparent hover:text-secondary/80"
        }`}
      >
        <span className="material-symbols-outlined text-lg">{icon}</span>
        <span className="flex-1">{label}</span>
        {badge != null && badge > 0 && (
          <span className="bg-secondary text-secondary-foreground text-[10px] font-bold px-1.5 py-0.5 min-w-[1.25rem] text-center animate-pulse">
            {badge}
          </span>
        )}
      </NavLink>
    </SidebarMenuItem>
  )
}
```

Then update `AppSidebar` to pass the badge to the inbox nav item. Replace the simple `.map()` with one that injects the pending count:

```typescript
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const operatorName = useSetting('operatorName')
  const systemName = useSetting('systemName')
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobile = () => { if (isMobile) setOpenMobile(false) }
  const pendingCount = usePendingCount()

  return (
    <Sidebar variant="sidebar" {...props}>
      {/* ... header unchanged ... */}

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu className="gap-2">
            {navItems.map((item) => (
              <SidebarNavLink
                key={item.to}
                {...item}
                badge={item.to === '/inbox' ? pendingCount : undefined}
              />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      {/* ... footer unchanged ... */}
    </Sidebar>
  )
}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Verify Vite build**

Run: `npx vite build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/app-sidebar.tsx
git commit -m "feat(ui): add Agent Inbox route and sidebar nav with pending badge"
```

---

### Task 10: End-to-End Smoke Test

**Files:** None (manual verification)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (or however the dev server starts)

- [ ] **Step 2: Verify inbox page loads**

Navigate to `/inbox` in the browser. Should see the empty state: "No agent questions yet"

- [ ] **Step 3: Verify sidebar shows Inbox**

Check sidebar has "Agent Inbox" with the inbox icon. Badge should not show (0 pending).

- [ ] **Step 4: Test ask_user via MCP (if possible)**

If you can trigger an `ask_user` call from Claude Code or the MCP inspector:
1. Call `ask_user({ project_id: 13, question: "Test question?", choices: ["Yes", "No"] })`
2. Verify the question appears in the inbox UI via SSE
3. Click "Yes" in the UI
4. Verify the MCP tool call returns `{ response: "Yes" }`

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address smoke test findings"
```
