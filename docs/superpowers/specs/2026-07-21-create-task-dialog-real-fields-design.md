# Design: make the Create Task dialog's fields real

**Date:** 2026-07-21
**Status:** draft, for review

## Problem

The Create Task dialog looks complete but most of it does not persist. On
submit, `handleCreateTask` (`v2_fe/src/App.tsx`) builds a rich local `Task`
object — owner, operator, estimate, tags, review, history — for the UI, then
calls `createTaskflowTask` with only:

```
title, description_markdown, notes_markdown, status, priority,
sort_order, assignee_label, due_at: null
```

So **operator, estimate, the due date, and the review gate are dropped** — they
live only on the ephemeral local object and vanish on reload. "Review gate is
there but doesn't save" is one symptom of a broader gap: the task model backs
none of those fields (`review_gate`, `estimate`, `operator` do not exist; and
the create call hardcodes `due_at: null` even though the column exists).

This makes the dialog's fields real: dropdowns backed by live data, and the
values persisted and rendered in the task details sheet.

## What already exists

- `liveWorkspace.members: TaskflowProjectMember[]` and `agents: TaskflowAgent[]`
  are both in the workspace — the Owner/Operator dropdowns need no new fetch.
- `TaskflowTask` has `assigned_user`, `assigned_agent_id`, `assignee_label`,
  `due_at`. The create input (`TaskflowTaskCreate`) exposes all of them.

## Model changes

Five new columns on `TaskflowTask`, one migration (a new-named file, never a
rewrite):

| Column | Type | Meaning |
|---|---|---|
| `review_gate` | `Option<String>` (text, max 4000) | What a human must approve before ship |
| `estimate_minutes` | `Option<i64>` | Estimate in minutes (free-text input, parsed) |
| `operator_user` | `Option<ForeignKey<AuthUser>>`, `on_delete = set_null` | Operator if a human |
| `operator_agent_id` | `Option<i64>` | Operator if an agent |
| `created_by_agent_id` | `Option<i64>` | Creator if an agent (see below) |

`due_at` is unchanged — it already exists; the create call just needs to send it.

### Why agent references are bare `i64`, not `ForeignKey`

The **human** columns (`operator_user`, and the existing `created_by`) are real
`ForeignKey<AuthUser>` — `AuthUser` is in a base crate both plugins already use.

The **agent** columns (`operator_agent_id`, `created_by_agent_id`) are bare
`i64`, matching the existing `assigned_agent_id`, because they cannot be a
`ForeignKey`. `taskflow-agents` depends on `taskflow-tasks` (agents reference
tasks); a `ForeignKey<TaskflowAgent>` on `TaskflowTask` would force the reverse
edge and create a circular crate dependency that will not compile. `TaskflowTask`
already documents this on `assigned_agent_id`: "dependency cycle while still
letting the UI show agent ownership."

Trade-off accepted: a bare id has no DB-level referential integrity, so a deleted
agent leaves a dangling id (exactly as `assigned_agent_id` does today). The only
way to a real FK is to move `TaskflowAgent` into a lower shared crate both
plugins depend on — a separate refactor, out of scope here.

## Creator tracking

We want to know who created each task — a human or an agent. `created_by`
(`Option<ForeignKey<AuthUser>>`) already exists for humans but is unset today
(the human create path never sends it, and the MCP path can't — it has no user).
This mirrors the operator split: a human FK plus an agent id.

- **Human create** (dashboard): the frontend sends `created_by = currentUser.id`.
- **Agent create** (MCP `create_task` → the agent task-create handler): the
  handler stamps `created_by_agent_id = <the authenticated agent's id>`, derived
  from the credential server-side, never from the request body.
- At most one of `created_by` / `created_by_agent_id` is set. The details sheet
  and the card show a "Created by" that resolves to the member or agent name, or
  falls back to "Unknown" for legacy rows where both are null.

This is the only change that touches the MCP/agent path; everything else is the
dashboard create + the model.

## Owner and Operator

Decided: explicit operator fields, so the two roles never contend for one slot.

- **Owner** → `assigned_user` (the accountable project member; a human).
- **Operator** → a member OR an agent:
  - human → `operator_user`
  - agent → `operator_agent_id`
  - at most one of the two is set.

`assigned_agent_id` stays for existing agent-assignment behaviour and is not
repurposed. `assignee_label` continues to hold a display string, derived from the
owner.

## Dialog fields

| Field | Now | Change |
|---|---|---|
| Owner | free text | **Dropdown** of active project members → `assigned_user` (+ label) |
| Operator | free text | **Dropdown** of members *and* agents → `operator_user` or `operator_agent_id` |
| Due | free text | **shadcn date + time picker** → `due_at` (ISO) |
| Estimate | free text `2h` | Free-text, **placeholder "minutes"**, parsed to `estimate_minutes` (int); unparseable → null |
| Description | "Description, markdown" | Relabel **"Description"** + help text *"you can write in markdown"* |
| Notes | "Notes, markdown" | Same relabel + help text |
| Review gate | free text, dropped | Persist to `review_gate`; render in the details sheet |
| Tags | free text, dropped | **Out of scope** — left as-is (display-only) unless raised later |

A member/agent dropdown uses shadcn `Select`. Owner lists members by display
name; Operator lists members then agents, each option carrying whether it is a
user or an agent so the submit routes to the right column.

## Backend create input

`TaskflowTaskCreate` gains `review_gate`, `estimate_minutes`, `operator_user`,
`operator_agent_id` (all optional). `createTaskflowTask` in the frontend sends
them, plus the real `due_at`, `assigned_user` (no longer null / label-only), and
`created_by = currentUser.id`.

Auto-REST create for `taskflow_task` already exists (it is a project-scoped
writable table); the new dashboard-writable columns ride the same path. No new
endpoint. **`created_by_agent_id` is NOT client-writable** — it is stamped only
by the agent task-create handler from the credential, so a dashboard caller
cannot forge an agent creator.

## Details sheet

The sheet currently renders `task.review`, `task.operatorName`, `task.estimate`
from the local mock shape. `mapLiveTasks` must map the real columns onto that
shape so the sheet shows persisted values:

- `review_gate` → the review section (already rendered via `MarkdownRenderer`)
- `estimate_minutes` → "Estimate" (formatted, e.g. "90 min")
- operator (`operator_user` / `operator_agent_id`) → "Operator", resolved to a
  member or agent display name from the workspace
- `due_at` → "Due" (formatted date+time)
- creator (`created_by` / `created_by_agent_id`) → "Created by", resolved to a
  member or agent display name, "Unknown" when both are null

## Testing

- **Backend:** a create with `review_gate`, `estimate_minutes`, `operator_user`
  (and separately `operator_agent_id`), and `due_at` round-trips — the row comes
  back with each value. Migration backfills nothing (all nullable). The MCP
  `create_task` handler stamps `created_by_agent_id` from the credential (not the
  body), and a dashboard create cannot set it.
- **Frontend (pure helpers):** parse free-text estimate → minutes (`"90"`→90,
  `"1h"`→null or 60?; decide: parse leading integer, else null); format
  minutes → label; resolve an operator selection to `{operator_user}` xor
  `{operator_agent_id}`.
- **Live:** create a task with an owner, an agent operator, a due date+time, an
  estimate, and a review gate; reload; confirm all five persist and render in the
  details sheet. (The mock currently loses them on reload — that is the check.)

## Decisions to pin

- **Estimate parse:** the free-text is parsed for a leading integer number of
  minutes (`"90"`, `"90 min"` → 90); anything without a leading integer stores
  null. Placeholder: `"minutes, e.g. 90"`.
- **Operator exclusivity:** setting an operator clears the other operator column,
  enforced on the client at submit and tolerated (last-write-wins) on the model.

## Out of scope

- Tags persistence (not requested).
- Workstream B (file reference — done) and C (sessions/live sheet — separate spec).
- Editing these fields after creation beyond what the existing task update path
  already allows; this spec covers create + render.

## Provenance

Requested 2026-07-21 by dalmas with two screenshots. Owner/Operator modelling
(explicit operator fields) chosen in the terminal the same day.
