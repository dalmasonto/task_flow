# Agent Registry + Bidirectional Messaging

## Summary

Agents register themselves by project path (stable identity instead of ephemeral PIDs). Messages flow in all directions: agent→user, user→agent, agent→agent. The inbox UI gets a sidebar showing live/recent agents with per-agent filtering and a compose box for sending instructions to agents.

## Agent Registration

### Auto-registration on startup

When the MCP server starts in stdio mode (not `--http-only`), it auto-registers:

1. Extract folder name from `process.cwd()` (e.g., `/home/dalmas/.../task_flow` → `task_flow`)
2. Query `agent_registry` for an existing live agent with that name
3. If name is taken by a live agent (PID still running), auto-suffix: `task_flow:2`, `task_flow:3`, etc.
4. Insert/update the registry row with current PID, tmux pane, CWD, `status = 'connected'`
5. On process exit (SIGINT, SIGTERM, beforeExit), mark `status = 'disconnected'`

### Custom names

Agents can call `register_agent({ name: "frontend" })` to override the auto-generated name. Same collision logic applies — if "frontend" is taken by a live agent, it fails with an error suggesting a different name.

### Liveness checks

An agent is considered live if its PID is still running: `process.kill(pid, 0)` returns without error. The SSE server periodically checks registered agents and marks dead ones as disconnected. Simple PID check — no heartbeat protocol.

## Database

### New table: `agent_registry`

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

### Modified table: `agent_messages`

Replace `agent_pid` column with `sender_name` and `recipient_name`:

| Column | Type | Purpose |
|--------|------|---------|
| id | INTEGER PK | Auto-increment |
| project_id | INTEGER FK | Links to project |
| sender_name | TEXT NOT NULL | Who sent: agent name or `"user"` |
| recipient_name | TEXT NOT NULL | Who receives: agent name, `"user"`, or `"all"` |
| question | TEXT NOT NULL | The message text |
| context | TEXT | Markdown context |
| choices | TEXT (JSON) | Optional quick-tap choices |
| response | TEXT | Reply text (null while pending) |
| status | TEXT NOT NULL | `pending` / `answered` / `dismissed` |
| delivered | INTEGER | 1 if injected into terminal |
| created_at | TEXT NOT NULL | When sent |
| answered_at | TEXT | When responded |

Migration: rename `agent_pid` → drop it, add `sender_name` and `recipient_name`. Existing messages get `sender_name = 'unknown'`, `recipient_name = 'user'`.

### Message direction examples

| Direction | sender_name | recipient_name |
|-----------|-------------|----------------|
| Agent → User | `task_flow` | `user` |
| User → Agent | `user` | `task_flow` |
| Agent → Agent | `task_flow` | `backend:2` |

## MCP Tools

### New tools

| Tool | Params | Description |
|------|--------|-------------|
| `register_agent` | `name?: string` | Register with custom name. Optional — auto-registers on startup with folder name. Returns the assigned name. |
| `send_to_agent` | `recipient: string, message: string, context?: string` | Send a message to another agent by name. Returns immediately. |
| `check_messages` | `since?: string` | Check for incoming messages (from users or other agents). Returns undelivered messages for this agent. |
| `list_agents` | `status?: 'connected' \| 'disconnected'` | List registered agents with their status, project path, and last seen time. |

### Modified tools

| Tool | Changes |
|------|---------|
| `ask_user` | Uses `sender_name` (agent's registered name) instead of `agent_pid`. Falls back to auto-registering if not yet registered. |
| `check_response` | No change — still checks by message ID. |

## Terminal Injection

### User → Agent

When a user sends a message to an agent from the UI:
1. Insert message with `sender_name = 'user'`, `recipient_name = '<agent_name>'`
2. The MCP server's background poller detects messages where `recipient_name` matches its own registered name and `delivered IS NULL`
3. Injects via `tmux send-keys` (same mechanism as inbox responses)
4. Marks `delivered = 1`

### Agent → Agent

Same mechanism — if the recipient agent is live and has a tmux pane, the recipient's MCP poller picks it up and injects.

## Agent Lifecycle

```
MCP server starts (stdio mode)
  → auto-register (folder name, PID, tmux pane)
  → start background poller (check for incoming messages every 3s)
  → start liveness checker in SSE server (check registered PIDs every 30s)

MCP server stops
  → mark agent as 'disconnected', set disconnected_at

SSE server liveness check (every 30s)
  → for each 'connected' agent, check if PID is alive
  → if dead, mark 'disconnected'
```

## Inbox UI Changes

### Layout

```
┌──────────────────────────────────────────────────────┐
│ Agent Inbox                           [Project ▾]    │
├────────────┬─────────────────────────────────────────┤
│            │                                         │
│ ● All (3)  │  Messages for selected filter           │
│            │                                         │
│ LIVE       │  Pending: choice buttons + input        │
│ ● task_flow│  Answered/dismissed: collapsed           │
│ ● backend  │                                         │
│            │                                         │
│ RECENT     │                                         │
│ ○ frontend │                                         │
│            │                                         │
├────────────┴─────────────────────────────────────────┤
│ [Type a message to send to agent...]        [Send]   │
└──────────────────────────────────────────────────────┘
```

### Left sidebar

- **All** (default): shows all messages, current behavior
- **Live agents**: green dot, name, unread message count
- **Recent agents** (last 24h): gray dot, name, last seen time
- Clicking an agent filters messages to/from that agent

### Compose box

- Appears at the bottom when a specific agent is selected (not "All")
- Text input + Send button
- Sends a message with `sender_name = 'user'`, `recipient_name = '<selected_agent>'`
- The message appears in the main panel as a sent message
- If the agent is live + has tmux, it gets injected into their terminal

### Message cards

- Show sender badge: "task_flow →" or "You →"
- Incoming (from agent): current style with response input
- Outgoing (to agent): simpler card, no response input, shows delivery status

### SSE events

- `agent_connected` — new agent registered (UI adds to sidebar)
- `agent_disconnected` — agent went offline (UI grays out)
- `agent_message` — reuse existing event for all message directions

### Dexie

Add `agentRegistry` table:
```
agentRegistry: '++id, name, status, connectedAt'
```

Sync via SSE events.

## Future considerations (not in this spec)

- **Broadcast messages**: `recipient_name = 'all'` — send to every live agent
- **Automatic dependency notifications**: when a task is completed, auto-message agents blocked on it
- **Message threading**: group related messages into conversations
- **Agent capabilities**: register what tools/skills an agent has, so other agents can discover who to ask for help
