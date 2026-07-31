# Agent Inbox — Remote Agent Communication via MCP

## Summary

A bidirectional communication channel between AI agents and the user, delivered through the TaskFlow UI. Agents ask questions via the `ask_user` MCP tool (which blocks until answered), and users respond from the Agent Inbox page — even from a phone away from their machine.

## Motivation

Claude Code (and similar agents) block on stdin when they need user input — permissions, choices, clarifications. If the user is away from their machine, the agent is stuck. This feature gives users a **remote input channel** through the TaskFlow UI, so they can respond from any device.

## New MCP Tool: `ask_user`

```typescript
ask_user({
  project_id: number,          // required — attaches question to a project
  question: string,            // the actual question
  context?: string,            // markdown — proposals, trade-offs, code snippets
  choices?: string[],          // optional quick-tap buttons
})
// Returns: { response: string } — blocks until user responds
```

### Behavior

- Creates a pending message in the database
- Broadcasts via SSE to the UI
- MCP tool handler holds a Promise that resolves only when the user responds via HTTP POST
- **No timeout** — mirrors terminal stdin behavior (waits indefinitely)
- The agent is blocked on the tool call until the response arrives

## Database: `agent_messages` table

| Column | Type | Purpose |
|--------|------|---------|
| id | INTEGER PK | Auto-increment |
| project_id | INTEGER FK | Links to project (required) |
| question | TEXT NOT NULL | The question text |
| context | TEXT | Markdown context/proposals |
| choices | TEXT (JSON) | Optional choice array, e.g. `["Yes","No"]` |
| response | TEXT | User's answer (NULL while pending) |
| status | TEXT NOT NULL | `pending` / `answered` |
| created_at | DATETIME | When asked |
| answered_at | DATETIME | When responded (NULL while pending) |

## Server-Side Flow

### Ask (MCP tool → server → UI)

1. Agent calls `ask_user` MCP tool
2. Tool handler inserts row with `status: "pending"` into `agent_messages`
3. Stores `{ resolve }` function in an in-memory `Map<messageId, PromiseResolver>`
4. Broadcasts SSE event `agent_question` with the full message payload
5. Tool handler `await`s the Promise (blocks the agent)

### Respond (UI → server → agent)

1. User responds in the UI
2. UI sends `POST /api/agent-messages/:id/respond` with `{ response: string }`
3. SSE endpoint handler updates the DB row (`response`, `status: "answered"`, `answered_at`)
4. Resolves the stored Promise with the response string
5. MCP tool returns `{ response: "user's answer" }` to the agent
6. Broadcasts SSE event `agent_question_answered`

### Edge Cases

- **Server restart while question pending**: The in-memory Promise map is lost. The DB still has `status: "pending"`. On restart, pending questions remain visible in the UI but the original agent connection is gone. The agent would need to re-ask. Consider logging a warning when pending questions exist on startup.
- **Multiple agents**: Each `ask_user` call gets its own message ID and Promise. Multiple agents can have pending questions simultaneously — they each block independently.

## SSE Events

| Event | Payload | Purpose |
|-------|---------|---------|
| `agent_question` | Full message object | New question posted — UI adds to inbox |
| `agent_question_answered` | `{ id, response }` | Question answered — UI updates card |

## UI: Agent Inbox Page

### Route

`/inbox`

### Layout

- **Header**: "Agent Inbox" with pending count badge
- **Project filter** at the top (all projects or specific)
- **Pending section** (top, visually prominent):
  - Each card shows:
    - Project badge (color dot + name)
    - Timestamp (relative, e.g., "2 minutes ago")
    - Context rendered as markdown (collapsible if long)
    - Question text (prominent, larger font)
    - Choice buttons (if provided) — styled as primary action buttons
    - Free-text input with send button (always available)
  - Pulse/glow indicator on pending cards
- **Answered section** (below, collapsed by default):
  - Shows question + response pairs
  - Expandable to see full context
  - Grouped by date

### Navigation

- Add "Inbox" to the sidebar navigation
- Badge count showing number of pending questions
- Badge should pulse/glow when new questions arrive

### Responsive Design

- Must work well on mobile — this is a primary use case (responding from phone)
- Choice buttons should be large enough to tap
- Free-text input should be comfortable on mobile keyboards

## MCP Tool Listing

Add to the existing tool registry alongside the 31 existing tools:

### New Tools (1)

- `ask_user` — Ask the user a question and block until they respond via the UI

### Supporting HTTP Endpoints (1)

- `POST /api/agent-messages/:id/respond` — Submit a response to a pending question

### Supporting SSE Events (2)

- `agent_question` — Broadcast when a new question is posted
- `agent_question_answered` — Broadcast when a question is answered

## Dexie (Client-Side)

Add `agentMessages` table to the Dexie schema to mirror server data for the UI:

```typescript
agentMessages: '++id, projectId, status, createdAt'
```

Sync via SSE events — when `agent_question` arrives, insert into Dexie. When `agent_question_answered` arrives, update the row.

## Future: Agent-to-Agent Communication

> **Deferred — build after the user-facing inbox proves out.**
>
> Once the inbox message queue exists, agent-to-agent is a thin layer on top:
>
> ### Schema Changes
> - Add `sender_type: "agent" | "user"` and `sender_id?: string` to `agent_messages`
> - Add `target_type: "user" | "agent"` and `target_session?: string`
> - Agents register with session names on startup via a `register_agent({ name })` tool
>
> ### New MCP Tools
> - `register_agent({ name: string })` — register this agent session with a name
> - `ask_agent({ session: string, project_id, question, context?, choices? })` — same as ask_user but targeted at another agent
> - `list_agent_sessions()` — discover running agents
> - `get_my_messages()` — agent checks for incoming questions from other agents
>
> ### Flow
> - Agent A calls `ask_agent({ session: "backend-agent", ... })`
> - Message stored with `target_type: "agent"`, `target_session: "backend-agent"`
> - Agent B periodically checks `get_my_messages()` or subscribes via a long-poll tool
> - Agent B responds, resolving Agent A's blocking call
>
> ### Open Questions
> - Should agents auto-discover each other or be explicitly addressed?
> - How to handle agent crashes mid-conversation?
> - Should there be a routing layer (topic-based) or direct addressing only?
>
> **Build this after real usage patterns emerge from the user-facing inbox.**
