# Offline-first outbox — design

**Task:** #45 — persist task creation, task edits/status, and chat messages when the
API is down; dispatch automatically on reconnect, exactly once.

**Status:** approved design, 2026-07-22 (dalmas). Storage decision: IndexedDB via
Dexie.js (SPA) + a JSON file (MCP).

## 1. Goal & scope

When a mutating action fails because the backend is **unreachable or 5xx**, we must
not lose it. Persist the payload in a durable local queue, show it as pending, and
replay it automatically when connectivity returns — **oldest-first, exactly once**.
A **4xx** (validation / permission / auth) is a real rejection: surface it, do not
queue, do not retry.

**In scope (v1):**
- Chat message sends (dashboard SPA + MCP).
- Task creation (dashboard SPA + MCP).
- Task status changes and edits (dashboard SPA + MCP).

**Surfaces:** both the human dashboard (IndexedDB/Dexie) and the MCP agent
(Node `fs` JSON file). Decided 2026-07-22.

**Out of scope (later):** attachment sends from the MCP where the source file is
moved/changed before flush (best-effort, documented edge); any conflict resolution
beyond last-write-wins; a payment/quotas interaction (unrelated).

## 2. Core pattern (shared)

Every mutating action carries a client-generated **nonce** (`crypto.randomUUID()` in
the browser, a random hex string in Node — same shape as the existing message
`client_nonce`).

Dispatch decision:
1. If `navigator.onLine === false` (browser) / a known-offline flag (MCP) → enqueue
   immediately, skip the network attempt.
2. Otherwise attempt the network call.
   - **2xx** → done (nothing queued; if this action was already in the queue, delete
     its row).
   - **Network error or 5xx** → enqueue (if not already), show pending UI, schedule a
     flush.
   - **4xx** → throw/surface the error, do **not** enqueue. (401 → surface for
     re-auth; never spin.)

Server-side idempotency guarantees a replay after a flaky success (response lost but
the write landed) never duplicates.

## 3. Backend

### 3.1 Task idempotency key

- Add `TaskflowTask.client_nonce: Option<String>` (nullable — legacy/other creates
  omit it).
- Uniqueness scoped per project: `#[umbral(unique_together = [["project", "client_nonce"]]) ]`.
- Migration: additive nullable column + the composite unique index. No backfill
  (existing rows keep NULL; NULLs are exempt from the unique constraint in SQLite).

### 3.2 Idempotent create endpoints

- **Human dashboard:** today the SPA creates via umbral auto-REST
  (`taskflowApi.create(tasks, …)`), which cannot dedupe. Add a custom
  `POST /api/taskflow/tasks` (`RequireAuth`) that:
  1. If `client_nonce` present and non-empty, look up `(project, client_nonce)`; if a
     row exists, return it (200) — the replay path.
  2. Otherwise insert and return the new row.
  This mirrors the message dedupe at `plugins/taskflow-agents/src/views.rs:456`.
  The SPA's `createTaskflowTask` switches to this endpoint.
- **Agent (MCP):** extend the existing `POST /api/taskflow/agents/tasks`
  (`RequireAgent`) to accept + dedupe `client_nonce` the same way.

### 3.3 Updates / status

Task edits and status changes are **naturally idempotent**: replaying "set
status=done" or "set title=X" yields the same state. They keep going through the
existing update/status endpoints (auto-REST PATCH and
`/api/taskflow/agents/tasks/{id}/status`); no nonce column is needed. The accepted
v1 semantic is **last-write-wins** — a stale queued edit may overwrite newer server
state (the task owner already declared "we care less for now" about reordering).

## 4. Ordering & dependencies

Flush is strictly **oldest-first** (by `createdAt`, then insertion `id`), so a
create is always dispatched before edits to the same task.

A queued edit of a task **created offline** has no real server id yet. The outbox
record carries `dependsOnNonce` = the create's nonce. On flush:
1. The create dispatches, returning the real server `id`.
2. A `nonce → realId` map is held for the flush pass; any subsequent queued item with
   `dependsOnNonce === thatNonce` has its `payload.taskId` rewritten to `realId`
   before it dispatches.
3. If a create is still failing (stays queued), its dependents are **held** (not
   dispatched) — they can't run without the id. Flush skips them this pass.

Same rewiring logic is implemented in both the SPA and MCP queues.

## 5. Dashboard SPA — Dexie

`src/lib/outbox.ts` — a Dexie database `taskflow-outbox`, one table:

```
outbox: ++id, nonce, kind, dependsOnNonce, createdAt, status
  record = {
    id,                    // auto
    nonce,                 // client nonce (idempotency key)
    kind,                  // 'message' | 'task-create' | 'task-update'
    dependsOnNonce?,       // create-nonce this item waits on
    payload,               // the action args (channel/body, task fields, {taskId, patch})
    files?,                // Blob[] for message attachments (IndexedDB stores Blobs)
    createdAt,             // ms epoch
    attempts,              // retry counter
    status,                // 'pending' | 'sending' | 'failed'
    lastError?,            // last surfaced message (for 'failed')
  }
```

- **Wrappers:** `enqueueOrSendMessage`, `enqueueOrCreateTask`, `enqueueOrUpdateTask`
  wrap the existing api functions with the §2 decision logic. Public UI code calls
  these instead of the raw api functions.
- **Flush driver:** a single-flight `flushOutbox()` (a module-level `flushing` guard
  so overlapping triggers coalesce). Triggered by: the `online` window event, a
  successful call from any wrapper, and a backoff timer (base 1s, ×2, cap 30s,
  jittered — same shape as the SSE reconnect). Oldest-first; on 2xx delete the row +
  record `nonce→realId`; on 4xx set `status='failed'` + `lastError` (stop retrying,
  surface); on network/5xx leave `pending`, bump `attempts`, back off.
- **Integration:** message sends already render nonce-keyed optimistic bubbles
  (`App.tsx:1477`); a queued send keeps its bubble in a `pending` state and flips to
  sent/failed off the queue outcome. Queued task-create renders an optimistic board
  card with a "pending sync" badge; queued edit shows a subtle pending marker on the
  card/detail.

## 6. MCP — Node file queue

`mcp/src/outbox.ts` — a durable queue in `.taskflow-outbox.json`, a sibling of
`.taskflow.json`, per profile, read/written with `node:fs` (no new dependency; the
whole file is small — id-and-payload records).

- Same record shape as the SPA (minus Dexie auto-id; use a monotonic counter + the
  nonce). Message attachments are stored by **file path**, re-read at flush time.
- Same enqueue-on-failure + oldest-first flush. Triggers: the next successful call,
  and a periodic retry timer while the process runs. Reuses `client_nonce`
  idempotency and the §4 dependent rewiring.
- Writes are serialized (a small in-process write queue) so concurrent tool calls
  don't corrupt the JSON file — mirrors the existing pane-write serialization.

## 7. UI (SPA)

- **Global indicator:** a small header badge, hidden when the queue is empty and
  online, otherwise "Offline — N pending" / "Syncing N…". Driven by `navigator.onLine`
  + a live count from the outbox (Dexie `liveQuery`).
- **Per-item states:** messages reuse the existing pending/failed bubble; task-create
  shows an optimistic card with a "pending sync" badge; task edits show a subtle
  pending marker. A failed item (4xx) offers a retry/dismiss affordance.

## 8. Error handling

- Classification helper shared by all wrappers: `network error | 5xx → retry`;
  `4xx → surface + drop`; `401 → surface (re-auth), drop`.
- Backoff caps at 30s; `attempts` is recorded but retries are not abandoned for
  network/5xx (the whole point is to survive a long outage). Only a 4xx moves an item
  to `failed`.
- Attachments: SPA stores Blobs durably; MCP stores paths (moved-file at flush time
  → that item fails with a clear error, surfaced, dropped).

## 9. Testing

- **Backend (Rust):** unit-test the idempotent create — same `(project, nonce)` twice
  returns the same row id, exactly one DB row; distinct nonces create distinct rows;
  omitted nonce still creates.
- **SPA (vitest):** queue module — enqueues on 5xx/network but not on 4xx; flush is
  oldest-first; a replayed nonce doesn't double-dispatch; a `dependsOnNonce` edit is
  rewired to the create's real id; a create that stays failed holds its dependents.
- **MCP (vitest):** file queue — persist across a simulated restart (read the file
  back), flush oldest-first, dedupe, dependent rewiring, serialized writes don't
  corrupt.
- **Manual (task's verify):** kill the backend → create a task, send a couple of
  messages, change a status → all show pending → restart the backend → they dispatch
  oldest-first, exactly once (no duplicates), indicator clears.

## 10. Phasing (each a reviewable commit)

1. **Backend** — `client_nonce` column + migration + idempotent create endpoints
   (human + agent) + unit test.
2. **SPA** — Dexie outbox module + wrappers + flush driver + header indicator +
   per-item states + vitest.
3. **MCP** — file outbox module + wrappers + flush + vitest.

Phases 2 and 3 both depend on phase 1 (the idempotent create). Within each client,
messages are the simplest (idempotency already exists) and land first, then
create/edit.
