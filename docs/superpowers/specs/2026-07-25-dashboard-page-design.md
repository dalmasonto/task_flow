# Dashboard (project insights) page

**Status:** approved design, ready for planning
**Date:** 2026-07-25
**Task:** #60 (first of two pages; Media page is a separate spec)
**Area:** `backend/plugins/taskflow-tasks` + `v2_fe`.

## Problem

TaskFlow has no statistical view. A member cannot see how much time they have
actually worked, how many tasks close in a period, which tools are used, or who
is most active. Task #60 asks for a "very nice detailed dashboard," and the
owner's specific emphasis: **it must show how much time I have worked as a
member, from the real task sessions.**

## What already exists

- **`TaskflowTaskSession`** (`taskflow-tasks/models.rs:167`) — a per-actor work
  timer per task: `actor_kind` (user/agent/system), `actor_user`,
  `actor_agent_id`, `actor_label`, `started_at`, `ended_at`, `duration_seconds`,
  `state`. The system **auto-opens/closes** these on task status via the
  reconciler (`session_timer.rs`), so the time data is trustworthy — the exact
  point of that feature. This is the source of "time worked."
- **`TaskflowTaskActivity`** — an `action` string + actor + timestamp per event;
  distinct actions are exposed at `/api/taskflow/projects/{id}/activity/actions`.
- **`TaskflowTask`** — `status`, `created_at`, `updated_at`, but **no close
  timestamp**.
- Project routes are session-authorized and project-scoped via
  `RequireAuth<i64>` + `can_access_project(user_id, project_id)` → 404 when not a
  member (`views.rs:32`).
- The SPA has routes under `/dashboard/*` (board, agents, reviews, activity,
  invites, api) and reads data through a generic REST query API
  (`taskflowApi.from(table).filter(...).list()`); there is no stats endpoint.

## Goals

- A `/dashboard/overview` page, nav label **Dashboard**, showing for a chosen
  time range: the current member's total worked time, worked time per member
  (humans and agents), tasks closed over time, activity per tool, and a
  most-active leaderboard.
- Trustworthy numbers, computed server-side so they hold as history grows.

## Non-goals

- The **Media page** (task #60's second half) — its own spec/plan/build cycle.
- Editing/exporting stats, custom date pickers, per-task drill-down — a later
  iteration. The range switcher (7d/30d/90d/All) is the only control in v1.
- Live-ticking timers. A currently-running session contributes its time once it
  closes (see Worked-time semantics).

## Design

### 1. A precise `closed_at` on `TaskflowTask`

"How many tasks were closed in a period" must not ride on `updated_at` (which
bumps on any edit — a task done last week but edited today would misreport).

- **Migration** (next number in `taskflow-tasks/migrations/`): add nullable
  `closed_at TIMESTAMPTZ`. Backfill existing terminal tasks:
  `UPDATE taskflow_task SET closed_at = updated_at WHERE status IN ('done','archived')`.
- **Model:** add `pub closed_at: Option<DateTime<Utc>>` to `TaskflowTask`
  (nullable, editable-off is fine; it is system-maintained).
- **Reconciler** (`session_timer.rs::reconcile`, which already loads the task and
  branches on status, and already runs on every write path): extend it so
  `closed_at` tracks the terminal state idempotently —
  - task is `done`/`archived` **and** `closed_at` is `None` → set `closed_at = now`, save.
  - task is **not** terminal **and** `closed_at` is `Some` → clear it, save.
  - otherwise → no write.

  This is idempotent and re-entrancy-safe: setting `closed_at` fires
  `post_save:taskflow_task` → `reconcile` again, but the guard (`closed_at`
  already set) makes the second pass a no-op, so it terminates. A reopened task
  (done → in_progress) clears `closed_at`, so the field means "currently closed,
  at this time," which is the correct basis for counting closures per period.

### 2. `GET /api/taskflow/projects/{id}/stats?range=7d|30d|90d|all`

One session-authorized, project-scoped endpoint (same guard as
`activity_actions`: `RequireAuth` + `can_access_project` → 404). `range`
resolves to a UTC cutoff (`now - N days`; `all` = no cutoff; unknown value →
400). Aggregation follows the codebase's established pattern (`activity_actions`):
fetch the project's rows via the ORM (`filter(col.eq(project_id)).fetch()`), then
range-filter and reduce in Rust (HashMap tallies) — the ORM exposes no
aggregation projection and the app uses no raw SQL. The range cutoff bounds the
working set for the common 7d/30d/90d cases; `range=all` reads the full feed, the
same cost `activity_actions` already pays per project. Response:

```json
{
  "range": "30d",
  "generated_at": "2026-07-25T09:00:00Z",
  "worked_per_member": [
    { "kind": "user",  "id": 1, "label": "dalmasonto",   "seconds": 45600 },
    { "kind": "agent", "id": 1, "label": "Claude (main)", "seconds": 31200 }
  ],
  "tasks_closed_by_day": [ { "day": "2026-07-20", "count": 4 }, { "day": "2026-07-21", "count": 2 } ],
  "activity_by_tool":    [ { "tool": "Bash", "count": 210 }, { "tool": "Edit", "count": 96 } ],
  "activity_by_member":  [ { "kind": "user", "id": 1, "label": "dalmasonto", "count": 180 },
                           { "kind": "agent", "id": 1, "label": "Claude (main)", "count": 320 } ],
  "totals": { "closed_in_range": 18, "open_now": 7, "active_members": 4 }
}
```

**Semantics (precise, so the SQL is unambiguous):**
- `worked_per_member`: `SUM(duration_seconds)` over sessions with
  `project = {id}`, `started_at >= cutoff`, `duration_seconds IS NOT NULL`,
  grouped by `(actor_kind, actor_user, actor_agent_id)`. `actor_kind = 'system'`
  is **excluded** (auto-timer bookkeeping, not a person). Ordered by seconds
  desc. `label` from the row's `actor_label`.
- `tasks_closed_by_day`: `COUNT(*)` of tasks with `project = {id}`,
  `closed_at >= cutoff`, grouped by `date(closed_at)` (UTC), ascending. Days with
  zero closures are omitted (the frontend fills the gaps for the chart).
- `activity_by_tool`: `COUNT(*)` of `taskflow_task_activity` with
  `project = {id}`, `created_at >= cutoff`, grouped by `action`, desc; capped to
  the top 12 with the remainder folded into an `"Other"` bucket (keeps the panel
  readable and the payload bounded).
- `activity_by_member`: `COUNT(*)` of `taskflow_task_activity` with
  `project = {id}`, `created_at >= cutoff`, `actor_kind != 'system'`, grouped by
  `(actor_kind, actor_user, actor_agent_id)`, desc. This drives the "Most active"
  leaderboard — activity is measured by number of actions, distinct from the
  time-based worked-per-member panel. `label` from `actor_label`.
- `totals.closed_in_range`: count of tasks with `closed_at >= cutoff`.
- `totals.open_now`: snapshot count of tasks whose status is **not** terminal
  (not `done`/`archived`) — range-independent, the current backlog.
- `totals.active_members`: distinct non-system actors with a session
  (`started_at >= cutoff`).

`all` uses no cutoff for every "in range" clause; `open_now` is always a
snapshot.

### 3. The Dashboard page (`v2_fe`)

New route `/dashboard/overview`, rendered inside the existing dashboard shell
(same auth gate, project context, and sidebar). A **Dashboard** nav item is
added to the sidebar as the first entry, with a chart/bar icon; `/dashboard`
still redirects to `/dashboard/board` (unchanged).

Layout — the approved rich single-screen grid:

```
Dashboard                                   [ 7d  30d  90d  All ]
┌ Your time ─┐┌ Tasks done ┐┌ Tasks open ┐┌ Active members ┐
│ 12h 40m    ││ 18         ││ 7          ││ 4              │
└────────────┘└────────────┘└────────────┘└────────────────┘
┌ Tasks closed over time ───┐┌ Time worked per member ───────┐
│ ▁▃▅█▆▃▅ (bars)            ││ dalmasonto ████████ 12h 40m ◄ │
│                           ││ Claude     █████    8h 40m    │
└───────────────────────────┘│ Reviewer   ███      5h        │
┌ Activity per tool ────────┐└───────────────────────────────┘
│ Bash ███████  Edit █████  │┌ Most active ──────────────────┐
│ Read ████     Write ██    ││ 1 dalmasonto  2 Claude  3 …    │
└───────────────────────────┘└───────────────────────────────┘
```

- The **range switcher** triggers one fetch of the stats endpoint; the whole
  page reflects the chosen range. Loading and empty states are explicit ("No
  activity in this range yet").
- **Your time** tile = the `worked_per_member` entry matching the current user
  (`kind:"user"`, `id === currentUser.id`), formatted `12h 40m` (or `40m`, or
  `0m`). The current user's row in the per-member panel is **highlighted**.
- **Time worked per member** and **Activity per tool** are horizontal bars
  scaled to the max value; **Tasks closed over time** is a small bar/column
  chart over the day buckets (gaps filled with zero); **Most active** is a ranked
  list from `activity_by_member` (by action count), each row also showing that
  member's worked time as a secondary figure.
- **Charts are dependency-free** — inline SVG / flexbox bars, matching the app's
  existing inline-icon idiom; no chart library is added. The `dataviz` skill
  guides palette, contrast, dark-mode, and labeling at build time.

### Frontend data layer

Add to `taskflow-api.ts`, beside the other project fetches:
`fetchProjectStats(projectId, range): Promise<ProjectStats>` — GET the endpoint,
typed to the response above. It is a normal authorized fetch (bearer/session),
independent of `loadLiveWorkspace` (the dashboard is its own page, not part of
the board's reference load).

## Error handling

| Case | Behavior |
|---|---|
| Not a project member | endpoint 404 (same probe-safe pattern as other routes); page shows an access notice |
| Bad `range` value | 400; the frontend only ever sends the four known values |
| Stats fetch fails / network | page shows a retryable error, not a blank grid |
| Empty project (no sessions/activity) | tiles show `0` / `0m`; panels show explicit empty states |
| Reconciler write for `closed_at` fails | logged and swallowed like the session close already is; never breaks the status write |

## Testing

- **Backend (`taskflow-tasks`):**
  - Reconciler: entering `done` stamps `closed_at` once; a second reconcile does
    not rewrite it; reopening to `in_progress` clears it; `archived` also stamps.
  - Stats aggregation: worked-per-member sums only completed, non-system
    sessions in range and groups actors correctly; `tasks_closed_by_day` buckets
    by `closed_at`; `activity_by_tool` tallies and folds beyond top-12 into
    `Other`; `activity_by_member` groups non-system actors by action count;
    `totals` match; `range=all` ignores the cutoff; unknown range → 400.
  - Auth: a non-member gets 404.
- **Frontend (`v2_fe`, node/vitest — no jsdom):** pure helpers only —
  `formatWorkedTime(seconds)` (`0m`, `40m`, `12h 40m`, rounds sensibly); the
  stats→bar-model shaping (scale-to-max, current-user highlight flag, zero-gap
  fill for the day series, "Other" already server-side). The React page is
  verified by `npm run build` + a live pass.
- **Manual:** load `/dashboard/overview`, switch ranges, confirm the numbers
  match a hand-count on a small project and that "Your time" reflects the
  signed-in member.

## Migration & compatibility

Additive: one nullable column with a backfill, one new endpoint, one new page and
nav item. No existing route, model field, or the board/activity flows change.
The reconciler gains a guarded `closed_at` write on the path it already runs.
Backfill seeds historical closures from `updated_at` (best-effort for tasks
closed before this shipped); closures after it are exact.
