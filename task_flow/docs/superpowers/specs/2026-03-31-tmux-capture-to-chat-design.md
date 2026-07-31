# Tmux Output Capture → TaskFlow Chat

**Date:** 2026-03-31
**Status:** Approved

## Summary

Capture full terminal output from tmux agent sessions and pipe it into the TaskFlow chat system. Simultaneously, replace the 3-second polling mechanism for UI→terminal message delivery with an event-driven SSE listener. The result is a fully event-driven, zero-polling messaging bridge between the terminal and the TaskFlow UI.

## Goals

1. Terminal output from agents appears in the TaskFlow inbox chat as messages
2. UI-injected messages (`[Message from ...]`, `[Inbox Response]`) are filtered out to prevent echo loops
3. The 3s `setInterval` poller is replaced with an SSE event listener for instant delivery
4. A `source` field on `agent_messages` distinguishes message origins (`mcp`, `terminal`, `ui`)

## Architecture

### Approach: SSE listener + pipe-to-file in the MCP process

Everything lives in the existing MCP process (`index.ts`). No new processes or sidecars.

```
┌──────────────────────────────────────────────────────┐
│  MCP Process (index.ts)                              │
│                                                      │
│  ┌─────────────┐    ┌──────────────────────────────┐ │
│  │ SSE Listener │    │ Capture System               │ │
│  │              │    │                              │ │
│  │ /events ───────►  │ tmux pipe-pane → tmpfile     │ │
│  │              │    │ fs.watch → tail → buffer     │ │
│  │ On event:    │    │ 2s pause → flush to API      │ │
│  │  inject via  │    │ filter [Message from ...]    │ │
│  │  send-keys   │    │ filter [Inbox Response]      │ │
│  └─────────────┘    │ POST /api/agent-messages/send │ │
│                      └──────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

## Section 1: SSE Listener (replacing the 3s poller)

### What changes

- Remove the `setInterval` poller in `index.ts:119-155`
- Replace with an HTTP GET to `/events` (SSE stream) that listens for events
- On `agent_question_answered` event — check if it's for this agent, inject via `tmux send-keys`
- On `agent_question` event — check if `recipient_name` matches this agent, inject `[Message from ...]`

### Delivery logic

- Event matching logic stays the same as the current poller — react to events instead of polling the DB
- Still mark messages as `delivered = 1` after injection to prevent re-delivery on reconnect

### Reconnection

- If the SSE connection drops, reconnect with a simple retry
- The existing `delivered` flag prevents duplicates

### Fallback

- On initial connect, do one DB query for any undelivered messages
- Covers messages that arrived before the SSE listener was ready

## Section 2: Tmux Capture (terminal → chat)

### Mechanism

1. `tmux pipe-pane -t <pane_id> -o "cat >> <tmpfile>"` — streams pane output to a temp file
2. MCP process watches `<tmpfile>` with `fs.watch` + tailing read
3. Buffers incoming text, strips ANSI escape codes
4. Filters out lines matching `^\[Message from ` or `^\[Inbox Response\]`
5. On a 2-second pause in output (no new data), flushes the buffer as a single message
6. POSTs to `/api/agent-messages/send` with `sender_name = agentName`, `recipient_name = "user"`, `source = "terminal"`

### Temp file

- Location: `/tmp/taskflow-capture-<agentName>.pipe`
- Truncated on startup before starting pipe-pane (prevents re-reading stale output from a previous session)
- Deleted on shutdown

### Flush rules

- Flush after 2 seconds of no new output (natural pause detection)
- Cap individual messages at ~10,000 characters; split if needed
- Skip flush if buffer only contains filtered-out lines (empty after filtering)

## Section 3: Message schema change + UI display

### Schema — add `source` column

```sql
ALTER TABLE agent_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'mcp'
```

Values:
- `"mcp"` — sent via MCP tools (`ask_user`, `send_to_agent`) — default, backward compatible
- `"terminal"` — captured from tmux output
- `"ui"` — sent from the TaskFlow UI compose box

### Where each source is set

- `ask_user` / `send_to_agent` MCP tools → `source = 'mcp'` (default)
- `/api/agent-messages/send` HTTP endpoint (compose box) → `source = 'ui'`
- Capture system POSTing terminal output → `source = 'terminal'`

### API change

Extend `/api/agent-messages/send` to accept an optional `source` field. When omitted, defaults to `'ui'` (compose box behavior). The capture system explicitly passes `source: 'terminal'`.

### UI changes in `agent-inbox.tsx`

- Terminal-sourced messages get a subtle visual distinction — monospace font or a small `terminal` badge next to the sender name
- No functional difference otherwise — they appear in the same chat thread

### Loop prevention

- Messages with `source = 'ui'` injected into the terminal via `tmux send-keys` appear as `[Message from User]: ...`
- The capture system skips these lines via prefix matching — no loop

## Section 4: Integration and lifecycle

### Startup sequence in `index.ts`

1. SSE server starts (existing)
2. MCP transport connects (existing)
3. Agent registers, tmux pane detected (existing)
4. **New:** Connect SSE listener to `http://localhost:<port>/events`
5. **New:** One-time DB sweep for undelivered messages (covers gap between startup and SSE connect)
6. **New:** Start `tmux pipe-pane` to temp file
7. **New:** Start `fs.watch` on temp file, begin tailing

### Shutdown (SIGINT/SIGTERM)

1. Stop `tmux pipe-pane` for the pane (`tmux pipe-pane -t <pane_id>` with no command)
2. Delete temp file
3. Unregister agent (existing)

### Edge cases

- **Agent restarts:** Truncate old temp file on startup before starting pipe-pane
- **SSE server not ready:** MCP process starts SSE server itself, so always ready. If connecting to existing instance on another port, retry with backoff
- **Large output bursts** (e.g. `npm install`): 2-second pause buffer accumulates everything until burst stops, sends as one message. Split at ~10,000 chars
- **Empty flushes:** If buffer only contains filtered lines, don't send

## Files touched

- `mcp-server/src/index.ts` — replace poller with SSE listener + add capture setup/teardown
- `mcp-server/src/sse.ts` — extend `/api/agent-messages/send` to accept `source` field
- `mcp-server/src/db.ts` — add `source` column migration
- `src/routes/agent-inbox.tsx` — terminal message styling
- `mcp-server/src/tools/agent-inbox.ts` — set `source = 'mcp'` explicitly in `ask_user`/`send_to_agent`
