# Agent Identity & Collaboration System — Design

**Date:** 2026-07-18
**Status:** design → staged implementation (owner leading autonomously)

Replaces the "improper" process-derived identity (legacy `task_flow/mcp-server`: cwd+ppid,
name-string routing, no auth, 24h purge) with a **stable, credentialed agent identity** anchored in a
per-repo `.taskflow.json`, so an agent linked yesterday keeps the same identity today and can act as
*itself* (messages, activity, sessions, reviews). Every model already exists in the backend
(`taskflow-agents`, `taskflow-tasks`); what's missing is the producers + auth. This design adds them.

## Core concept: `.taskflow.json` + profiles

A repo/working-dir holds `.taskflow.json` (git-ignored — it carries a secret):

```jsonc
{
  "server": "http://localhost:8000",        // backend base URL
  "project": 1,                               // project id this repo maps to
  "default_profile": "main",
  "profiles": {
    "main":     { "agent_id": 12, "key": "tfk_live_main_…", "display_name": "Builder" },
    "reviewer": { "agent_id": 13, "key": "tfk_live_rev_…",  "display_name": "Reviewer" }
  }
}
```

- The MCP server / hooks read `.taskflow.json`, pick `default_profile` (`main`) unless a tool call or
  env (`TASKFLOW_PROFILE`) selects another. The selected profile's `key` authenticates every backend
  call as a **specific, stable `TaskflowAgent`** (`agent_id`). Continuity across sessions is the
  credential, not the process — re-exec / tmux / new ppid never mint a new identity.
- Profiles let one repo host multiple roles: `main` builds, `reviewer` reviews. Reviews are reported
  back to the agent whose profile is `main`.

## Backend changes (Rust / Umbral, `backend/`)

### Stage 1 — Identity foundation (credential mint + agent auth) [FIRST]
- **Mint endpoint** (human-authed, `RequireAuth<i64>`): `POST /api/taskflow/agents/link` →
  body `{ project, display_name, profile, project_root?, runtime?, version? }`. Creates (or reuses by
  `identifier`) a `TaskflowAgent` and a `TaskflowAgentCredential` (store only `key_prefix` + argon2
  `key_hash`), returns the **raw key once** + the `.taskflow.json` profile block to paste. `identifier`
  = a stable server-issued value (e.g. `agent:{project}:{slug(display_name)}:{profile}` or a uuid).
- **Agent-auth extractor** `RequireAgent`: reads `Authorization: Agent <key>` (or `x-taskflow-key`),
  splits prefix, looks up `TaskflowAgentCredential` by `key_prefix` (active, unexpired), verifies the
  argon2 hash, resolves `agent` → returns `(agent_id, project_id)`. On any failure → 401.
- **Agent-authored send**: extend `send_message` (or a sibling agent route) so an agent-authed caller
  stamps `sender_kind=agent, sender_agent=<id>, sender_label=<display_name>`; membership gate becomes
  "is this agent a member of the channel / project".
- Wire credential/agent tables writable only through these guarded endpoints (keep REST read-only).
- Tests: mint → returns key once; wrong/revoked key → 401; agent send stamps sender_agent.

### Stage 2 — Read receipts / unread
- New model `TaskflowChannelReadCursor` `{ id, project, channel FK, member_kind, member_user?,
  member_agent?, last_read_message FK?, last_read_at }`, UNIQUE(channel, member). Endpoint
  `POST .../channels/{id}/read { last_read_message }` (human OR agent auth). Realtime-exposed so the
  other side sees "read". Drives real `unread` counts (replace hardcoded 0) and an "agent read your
  message ✓✓" indicator.

### Stage 3 — Sessions + terminal producer (heartbeat/liveness)
- Agent-authed `POST .../sessions` (register: session_identifier, host, pid, cwd, transport),
  `POST .../sessions/{id}/heartbeat` (bumps `last_seen_at` on session + agent; flips agent status
  connected/idle), `POST .../sessions/{id}/frames` (append terminal frames), `POST .../sessions/{id}/close`.
  "Online" becomes live: agent is online iff a session heartbeated within N seconds (server-computed or
  a periodic sweeper marks stale → disconnected). Terminal frames → projected realtime fields (stream
  live, not id-only refetch).

### Stage 4 — Task lifecycle + review workflow
- Make agent↔task a real link: add `assigned_agent FK<TaskflowAgent>` (keep the raw int for migration,
  prefer the FK). Agent-authed `create_task`/`update_task`/`update_status`. Add review states +
  reviewer identity: `TaskflowTaskStatus` gains `in_review`; a `TaskflowTaskReview` `{ task, reviewer_kind,
  reviewer_user?/agent?, decision(approved|changes_requested), body_markdown, created_at }`. On review,
  post a message to the assigned agent's DM (so it surfaces in their tmux) + activity.

### Stage 5 — Activity from Claude hooks (agent-authed ingest)
- Agent-authed `POST .../activity { action, body?, metadata_json?, task? }` stamping the real agent.
- `.claude/settings.json` hooks (SessionStart, PreToolUse, PostToolUse, Stop, Notification) run a small
  script that reads `.taskflow.json` (selected profile) and POSTs the real tool action. This gives a
  trustworthy log of the agent's actual Read/Edit/Bash actions (the legacy system only saw MCP calls).

## MCP server (`task_flow/mcp-server` rewrite OR new `mcp/`)
A Node/TS MCP server that: reads `.taskflow.json` → selected profile → authenticates to THIS backend's
agent-auth HTTP API. Tools map to the endpoints above: `link`(one-time), `whoami`, `create_task`,
`list_tasks`, `update_task`, `send_message`, `check_messages`, `mark_read`, `register_session`,
`heartbeat`, `capture_terminal`, `report_review`, `list_agents`, `get_activity`. Profile selection:
default `main`, override via tool arg or `TASKFLOW_PROFILE`. No more cwd/ppid identity.

## Frontend (`v2_fe`)
Wire the real producers: online state from live session heartbeat (not row count); unread counts +
read receipts from the read-cursor; agent identity keyed by stable `identifier` (not display_name);
streamed terminal frames; review UI (request review, approve/request-changes, see reviewer). Most FE
mappers already render these tables — they just need the real fields + a couple of new endpoints.

## Ordering / rationale
Stage 1 is load-bearing — nothing else can be "the agent acting as itself" without stable auth. Then
read receipts (2) and sessions (3) make the chat/terminal real; tasks/review (4) and hooks (5) complete
the loop. Each stage is independently testable and shippable. The FE wiring rides alongside each stage.

## Out of scope (for now)
Non-Claude harnesses (design the activity endpoint generically, but only ship Claude hooks now).
Multi-tenant key rotation UI. Relay/remote transport (localhost first).
