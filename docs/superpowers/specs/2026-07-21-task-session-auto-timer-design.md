# Design: system-driven task session timer

**Date:** 2026-07-21
**Status:** approved
**Task:** #23

## Problem

Task work sessions (`taskflow_task_session`) are a time-tracking timer per task.
Today they are started/stopped by hand — the agent from its side, a human from
the task sheet's Start/Pause/Stop buttons. Relying on either to remember is
unreliable: the agent routinely moves a task to `in_progress` and forgets to
open a session (demonstrated live — zero sessions were opened across a full
board session). The result is missing, untrustworthy time data.

## Goal

The **system** owns the timer, driven purely by task status:

- When a task enters `in_progress` and has no active session, open one.
- When a task leaves `in_progress` (moves to any other status), close any
  active session.

No agent or client discipline required — it must cover both the human dashboard
and the agent/MCP paths.

## Approach: one ORM-signal reconciler

umbral-core exposes an in-process signal registry
(`crates/umbral-core/src/signals.rs`). Every ORM write fires a named signal.
Register a subscriber once, at boot, in `TaskflowTasksPlugin::on_ready`, and it
runs on every task write regardless of which HTTP handler produced it.

### Two signals, because the write paths differ

The status-change write paths do **not** all emit the same signal:

| Path | Write call | Signal fired | Payload |
|---|---|---|---|
| Dashboard (board drag, edit) | umbral-rest `DynQuerySet::update_json` | `bulk_post_save:taskflow_task` | `{ ids, created, actor }` |
| REST create | `insert_json` | `bulk_post_save:taskflow_task` | `{ ids, created, actor }` |
| MCP `update_task_status_as_agent` | `Manager::save` | `post_save:taskflow_task` | `{ instance, created, actor }` |
| `apply_review` | `Manager::save` | `post_save:taskflow_task` | `{ instance, created, actor }` |

A `post_save`-only subscriber (e.g. the typed `on_model::<T>().post_save`) would
catch the agent paths but **miss every human board move** — the exact opposite of
"covers both sides." So we subscribe to **both** signal names using the raw
`umbral::signals::subscribe_async` API and funnel them into one reconciler.

### The reconciler

```
reconcile_task_session(task_id):
    task = load task by id            # both signals fire AFTER the write commits
    if task is missing: return        # deleted between write and handler
    active = sessions where task=task_id and ended_at IS NULL
    if task.status == in_progress:
        if active is empty:
            create session { state=Running, started_at=now,
                             actor_kind=System, actor_label="System" }
        # else: already timing — do nothing
    else:
        for s in active:
            s.ended_at = now
            s.duration_seconds = (now - s.started_at).seconds
            s.state = Stopped
            save s
```

- **`post_save` handler:** read `payload["instance"]["id"]`, call reconcile.
- **`bulk_post_save` handler:** iterate `payload["ids"]`, call reconcile for each.

Stateless and idempotent: no old status is needed, a repeated `in_progress`
write opens no duplicate, and a create (`created=true`) with `status=in_progress`
opens a session while any other created status is a no-op.

### Attribution

The auto-opened session is attributed to **System** (`actor_kind=System`,
`actor_label="System"`) — honest, since the system opened it, not a person. The
task's own assignee/operator remains the record of *who owns the work*.

## Why not the alternatives

- **Inject into each write path.** Three code sites, and it forces the dashboard
  off generic auto-REST onto a custom status endpoint. More surface, same result.
- **Frontend-driven timer.** Misses the MCP and `apply_review` paths — the very
  agent-forgetfulness this task exists to remove.

## Coexistence with the manual Start/Pause/Stop controls

Free. The manual buttons write the same `taskflow_task_session` rows, so:

- A manually-opened session already counts as "active" → the reconciler opens no
  second one on `in_progress`.
- When the task leaves `in_progress`, the reconciler's "close any active" closes
  a manually-opened session too.

Nothing to remove; the buttons stay for mid-work pause/annotate.

## No loops / write amplification

The reconciler writes only `taskflow_task_session`, never `taskflow_task`, so it
cannot re-trigger the task signals it listens on. A bulk update touching N tasks
runs N reconciles (bounded by the batch). Each reconcile is one indexed SELECT
plus at most one INSERT or a small UPDATE — cheap on the write path.

## Frontend

Essentially untouched. `TaskflowTaskSession` is already exposed over realtime
(id-only to the task-sessions group), so a session opening or closing surfaces
live in the task sheet's timer through the existing `getLiveTaskSessions` /
`getRunningLiveTaskSession` path.

## Testing

Backend integration tests (in `taskflow-tasks`):

- `in_progress` via **REST PATCH** (`update_json`) opens exactly one running
  session (proves the `bulk_post_save` path).
- `in_progress` via **`Manager::save`** (agent path) opens one (proves
  `post_save`).
- A second `in_progress` write opens **no** duplicate session (idempotency).
- Moving to `done` / `blocked` / `paused` / `not_started` closes the active
  session and populates `duration_seconds` and `state=Stopped`.
- Review-gate scenarios: `done → in_progress`, `blocked → in_progress`,
  `not_started → in_progress`, then back to the original state.

## Implementation notes

- Add `umbral-signals` (raw `subscribe_async` is re-exported from `umbral`, so
  the facade dep already present may suffice; confirm at build time).
- Reconciler and both subscriptions live in `taskflow-tasks` (both models are in
  that crate; the global DB pool is reachable from `on_ready`).
- No migration — the `taskflow_task_session` model already has every field used.

## Out of scope

- Changing the manual session UI beyond leaving it in place.
- `summary_markdown` content beyond an optional "auto-opened/closed" note.
- Reconciling historical tasks already `in_progress` at deploy time (the next
  status write, or a manual open, will pick them up).
