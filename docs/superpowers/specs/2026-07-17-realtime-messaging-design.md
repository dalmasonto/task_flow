# Realtime + Messaging Rework — Design

**Date:** 2026-07-17
**Status:** Approved (sections 1–2 approved by owner; remaining calls delegated)
**Scope:** First of four sub-projects. Queued behind it: attachments/files, API scoping + permissions, frontend architecture cleanup.

## Problem

Three defects, one root cause.

### 1. Realtime events cannot be attributed to a table

`umbral-realtime` 0.0.10 emits the *action* as the event name and an id-only payload:

```rust
// umbral-realtime/src/lib.rs — Expose emit path
let group = spec.route.group_for(&ev);
let projected = spec.project(&ev.instance);   // Projection::IdOnly → {"id": 42}
let action_name = ev.action_name();           // "created" | "updated" | "deleted"
Realtime::to_group(group).send(action_name, &projected).await;
```

The table name never reaches the wire. On the client, `umbral.realtime.model(name, handlers, {group})`
ignores `name` entirely — the crate's own comment states *"`name` is the model label, for readability
only"* — and delegates straight to `subscribe(group, routes)`.

`backend/src/realtime.rs` exposes 13 project-scoped models to a single `project:{id}` group, and
`v2_fe/src/lib/taskflow-api.ts` opens 14 subscriptions against it. Therefore:

> One new message emits `created {"id": 42}` → **all 14 client handlers fire** →
> `fetchAndApplyRealtimeEvent` issues up to 14 `GET /api/{table}/42` calls. Most fetch an unrelated
> row that merely shares id 42, and upsert it into the workspace as though it were real.

This is both the source of the excess backend traffic and a **silent data-corruption bug**. It is the
root cause; the rest follows from it.

### 2. Chat state is split three ways

`liveWorkspace.agentMessages`, `threadMessagesByAgent`, and `channelMessagesById` all hold messages
simultaneously, with hardcoded fixtures (`agentThreads`, `agentChannelThreads`, ~160 lines) as a
silent fallback whenever `liveWorkspace` is null. Every render path must ask "am I live or mock?".

### 3. The sender asserts its own identity

`sendLiveMessage` posts `sender_kind`, `sender_user`, and `sender_label` in the request body to
unscoped auto-REST. Any authenticated user can post as any agent or any other user, and nothing
verifies the caller belongs to the channel.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Discriminator fix | App-level per-table groups | No framework change; makes the generated client's `.on()` honest. Umbral's id-only default is a separate footgun to fix upstream later. |
| Mock chat fallback | Delete entirely | Collapses three stores to one and removes live/mock branching from every render path. |
| Send path | Custom POST endpoint | Server derives identity; also the natural home for attachments later. |
| Sender echo | `client_nonce` column | Order-independent reconcile; SSE echo commonly beats the POST response on localhost. |
| Diff width | Re-group all project-scoped exposures; inline payload for chat tables only | Re-grouping is what fixes the bug. Full projections everywhere would push every column onto the wire while the group policy still lets any user join any room — that decision belongs to the permissions sub-project. |
| `ChannelMember.project` | Denormalize | Mirrors `TaskflowAgentMessage`, which already denormalizes `project` for realtime routing. |
| Nonce idempotency | Yes | Same nonce + channel returns the existing row; a retry cannot double-post. |
| File picker | Disable | It fabricates `/uploads/pending/{name}` for a file that is never uploaded and cannot be read. A lying control is worse than an absent one. |

## Architecture

### Backend

**Group scheme.** All 14 project-scoped exposures move to `project:{id}:{suffix}` — 13 that share the
`project_group` router today, plus `TaskflowAgentChannelMember`, which currently sits on the global
`taskflow:agents` group. `TaskflowProject` is the 15th exposure and does not move. The group carries
the discriminator the event name lacks.

The suffix is a **short stable label, not the table name** — `messages`, not
`taskflow_agent_message`. Backend and frontend must agree on it exactly or subscriptions silently
receive nothing, so it is defined once per side and the two lists are asserted to match:

| Model | Table | Group suffix |
|---|---|---|
| `TaskflowAgentMessage` | `taskflow_agent_message` | `messages` |
| `TaskflowAgentChannel` | `taskflow_agent_channel` | `channels` |
| `TaskflowAgentChannelMember` | `taskflow_agent_channel_member` | `channel_members` |
| `TaskflowTask` | `taskflow_task` | `tasks` |
| `TaskflowTaskRelation` | `taskflow_task_relation` | `task_relations` |
| `TaskflowTaskActivity` | `taskflow_task_activity` | `task_activity` |
| `TaskflowTaskSession` | `taskflow_task_session` | `task_sessions` |
| `TaskflowAgent` | `taskflow_agent` | `agents` |
| `TaskflowAgentSession` | `taskflow_agent_session` | `agent_sessions` |
| `TaskflowAgentCredential` | `taskflow_agent_credential` | `agent_credentials` |
| `TaskflowAgentTerminalFrame` | `taskflow_agent_terminal_frame` | `terminal_frames` |
| `TaskflowProjectMember` | `taskflow_project_member` | `project_members` |
| `TaskflowProjectInvite` | `taskflow_project_invite` | `project_invites` |
| `TaskflowProjectApiEndpoint` | `taskflow_project_api_endpoint` | `api_endpoints` |
| — (presence only) | — | `presence` |

`TaskflowProject` itself stays on the project-level `taskflow:projects` group, since a project row has
no parent project to scope to.

The frontend's `taskflowGroups` builder is the single source of the suffix on that side, keyed off the
existing `taskflowTables` map so a table name and its group cannot drift apart.

```rust
.expose::<TaskflowAgentMessage>(
    Expose::to_group_with(|ev| format!("project:{}:messages", project_id(ev)))
        .fields(&["id", "channel", "project", "client_nonce", "sender_kind",
                  "sender_user", "sender_agent", "sender_label",
                  "body_markdown", "priority", "created_at"]),
)
```

- **Chat tables** (`taskflow_agent_message`, `taskflow_agent_channel`,
  `taskflow_agent_channel_member`) use `Expose::fields(...)` so the row arrives inline and the client
  never refetches.
- **The other 11** keep `Projection::IdOnly` and a client-side `GET` — but now that GET fires **once**,
  against the correct table.
- `taskflow:projects` (project-level rows) is unchanged.
- The `taskflow:agents` global group is **retired**; `ChannelMember` moves to
  `project:{id}:channel_members`, ending a cross-tenant fanout where every authenticated user saw every
  project's membership events.

**Group policy** learns the `:{table}` suffix. This does not change the security posture — any
authenticated user can already join any project room. Hardening is the permissions sub-project's job;
this design must simply not make it worse.

**Presence** is pinned to a dedicated `project:{id}:presence` group carrying no model events. Today's
`PresenceSpec::matching(|g| g.starts_with("project:"))` would otherwise match every per-table group
and produce 14 presence sets per project instead of one.

**Migrations** (two model changes):
- `TaskflowAgentMessage.client_nonce: Option<String>` — nullable, `max_length = 64`.
- `TaskflowAgentChannelMember.project: ForeignKey<TaskflowProject>` — `on_delete = "cascade"`,
  matching `TaskflowAgentMessage`.

`project` is NOT NULL with no default. `makemigrations` rejects it with `UnsafeAlter` — a **static
diff-time check** on adding a NOT NULL column via `ALTER` to an established table, independent of
whether the table holds any rows. Recreating the dev DB therefore does not help: `migrate` only applies
migration *files*, so the check fires regardless of database state.

Resolution: regenerate `backend/migrations/taskflow_agents/0001_auto.json`, the plugin's only
migration, so both new columns land in the initial `CREATE TABLE` rather than a later `ALTER`. This is
sound only because of where this project sits — that migration has exactly one prior commit (the
pre-work snapshot), no other plugin declares `depends_on` it, and the only database it has ever
produced is a gitignored dev DB whose entire contents `seed::all()` regenerates. **In a shipped system
this would be an anti-pattern**; rewriting applied migration history breaks every existing deployment.
The first real deployment needs a proper additive migration with a backfill, and that is work to do
when there is production data worth preserving.

**Send endpoint.** `POST /api/taskflow/agents/messages`, registered in
`plugins/taskflow-agents/src/urls.rs` — the first domain route in the plugin (the existing three are
health checks).

- Request: `{channel, body_markdown, priority, client_nonce}`
- Server derives: `project` ← `channel.project`; `sender_kind` / `sender_user` / `sender_agent` /
  `sender_label` ← authenticated identity (session user vs. agent API key)
- `403` unless the caller is a `TaskflowAgentChannelMember` of `channel`
- `404` if the channel does not exist; `400` on an empty body or a body over `max_length`
- Idempotent: an existing `(channel, client_nonce)` returns the stored row with `200` rather than
  inserting
- Response: the created row, same shape the realtime projection emits

Reads stay on scoped auto-REST.

**Seed.** `seed::all()` currently creates only a dev superuser, so a fresh DB has zero chat rows.
With the fixtures deleted, dev would boot into a genuinely empty screen. Add `seed::chat()`: one
project, one channel, and member rows for the seeded user.

### Frontend

**`taskflow-api.ts`** — `taskflowGroups` gains a per-table builder; the fan-out onto one group becomes
one subscription per table:

```ts
taskflowApi.on("taskflow_agent_message", {
  created: (row) => upsertMessage(row),   // row arrives whole — no GET
  updated: (row) => upsertMessage(row),
  deleted: (row) => removeMessage(row.id),
}, { group: `project:${projectId}:messages` })
```

`fetchAndApplyRealtimeEvent`'s per-event GET disappears for the three chat tables and fires once,
correctly, for the other 11.

**Send** shrinks to a nonce and a POST:

```ts
const nonce = crypto.randomUUID()
addPendingMessage({ nonce, body_markdown: body, priority })   // renders instantly
await sendTaskflowAgentMessage({ channel, body_markdown: body, priority, client_nonce: nonce })
// Response is NOT upserted. reconcileByNonce handles the SSE echo and the POST
// response identically, whichever wins the race.
```

**Store collapse.** Delete `threadMessagesByAgent`, `channelMessagesById`, `agentThreads`,
`agentChannelThreads`, and `handleSendMessage`'s mock branch. `liveWorkspace.agentMessages` becomes
the single store. `upsertById` gains a nonce-aware sibling, `reconcileByNonceOrId`. Fix the standing
oddity in `mapLiveChannelMessages` where the fetch orders `-created_at` DESC and the mapper re-sorts
ASC.

**File picker** is disabled behind an honest affordance. `appendAttachmentMarkdown` stays — URL and
project-path attachments flatten to links that genuinely resolve — until the attachments sub-project.

## Data flow

```
user types → composer
  → nonce = crypto.randomUUID()
  → addPendingMessage({nonce})                        ← bubble renders immediately
  → POST /api/taskflow/agents/messages {channel, body, priority, nonce}
       ↓ server: derive sender, assert membership, insert
       ↓ model event → Expose → project:{id}:messages, fields(...)
  → SSE echo {id, client_nonce, body_markdown, ...}   ┐ whichever lands first
  → POST response (same row shape)                    ┘ reconcileByNonceOrId
       → match on nonce → replace pending in place    (no duplicate, no flash)
       → second arrival → already reconciled → no-op
```

Other members of the channel hold no pending row, so the same SSE event simply inserts by id.

## Error handling

| Case | Behavior |
|---|---|
| POST fails (network/5xx) | Pending bubble enters a `failed` state with retry. Retry reuses the **same nonce** — idempotency makes a double-insert impossible if the original actually landed. |
| POST 403 (not a member) | Pending bubble removed; surfaced as an error. Signals an `ensureLiveChannel` bug, since membership is created before the first post. |
| SSE drops | Pending bubbles stay pending; the POST response still reconciles them, so a message never *looks* lost while SSE is down. Recovery is a refetch on reconnect. |
| SSE echo arrives for an unknown nonce | Normal — another tab or client sent it. Insert by id. |
| Realtime event for a stale project | Ignored; guard on `row.project !== projectId` as today. |

## Testing

Backend (Rust, via `umbral-testing`):
- Send endpoint: derives sender from identity and **ignores** client-supplied `sender_*` fields
- Send endpoint: 403 for a non-member; 404 for an unknown channel
- Idempotency: same `(channel, client_nonce)` twice → one row, both calls return it
- Realtime routing: a message event reaches `project:{id}:messages` and **not** `project:{id}:tasks`
  — the regression test for the root-cause bug
- Group policy: accepts every per-table suffix and `presence`; rejects `project:` with an empty id and
  the retired `taskflow:agents`
- Seed: `seed::chat()` is idempotent — booting twice does not double-insert

Frontend — no test framework exists today. Add **vitest** for the reconcile reducer only. It is a pure
function, it is where the subtle race lives, and it is cheap to cover:
- pending → SSE echo first → reconciled once, no duplicate
- pending → POST response first → reconciled once, no duplicate
- both arrive → second is a no-op
- SSE row with unknown nonce → plain insert

Broader FE testing is deliberately out of scope; it belongs with the frontend-architecture sub-project.

## Out of scope (queued)

- `fetchTaskflowWorkspace`'s 15-request burst per project switch, and its dropped pagination
  (`Paginated<T>.count` discarded, so anything past page 1 is invisible)
- Splitting `App.tsx` (6,576 lines)
- Attachments: model, `FileField`, `StoragePlugin::media()`, multipart upload, m2m from message
- REST scoping and permissions — including `taskflow_agent_credential` (holding `key_hash`) being
  exposed as full CRUD to every authenticated user, and the realtime group policy allowing any user
  into any project room
- Client-side channel/member creation in `ensureLiveChannel` via unscoped auto-REST
- Upstream Umbral fix: table discriminator in the emitted event + a non-decorative `model(name, …)`

## Success criteria

1. One new message produces **exactly one** SSE event and **zero** follow-up GETs on the chat path.
2. No handler ever receives an event for a table it did not subscribe to.
3. Chat renders from exactly one store; no fixture data remains reachable.
4. A message cannot be posted with a forged sender, or into a channel the caller has not joined.
5. Sending is duplicate-free regardless of whether the SSE echo or the POST response arrives first.
