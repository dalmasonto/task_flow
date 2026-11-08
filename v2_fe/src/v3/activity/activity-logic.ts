/// Pure rules for the v3 activity feed (tested in activity-logic.test.ts).
import type { TaskflowTaskActivity } from "@/api/client"

export type ActorFilter = "all" | "agent" | "user"

/// Newest first, one row per id. Live rows from the stream are merged over the
/// fetched pages, so an event that arrives twice (stream + a page) shows once.
export function mergeActivity(pages: TaskflowTaskActivity[], live: TaskflowTaskActivity[]): TaskflowTaskActivity[] {
  const byId = new Map<number, TaskflowTaskActivity>()
  for (const r of pages) byId.set(r.id, r)
  for (const r of live) byId.set(r.id, r)
  return [...byId.values()].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id)
}

/// Does a live row belong in the feed as currently filtered? Live rows skip
/// the server's filters, so the same rules apply here. Rows older than the
/// oldest loaded one are left out: they belong to a page not loaded yet.
export function liveRowFits(r: TaskflowTaskActivity, project: number, actor: ActorFilter, action: string | null, oldest: string | null): boolean {
  if (r.project !== project) return false
  if (actor !== "all" && r.actor_kind !== actor) return false
  if (action && r.action !== action) return false
  if (oldest && (r.created_at ?? "") < oldest) return false
  return true
}

export function matchesSearch(r: TaskflowTaskActivity, title: string | undefined, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [r.actor_label, r.action, r.body_markdown ?? "", title ?? "", r.task != null ? `#${r.task}` : ""].join(" ").toLowerCase().includes(needle)
}

export type DayGroup = { key: string; label: string; rows: TaskflowTaskActivity[] }

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/// Rows (already newest first) bucketed by local calendar day: "Today",
/// "Yesterday", then the date.
export function groupByDay(rows: TaskflowTaskActivity[], now: number): DayGroup[] {
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(today.getDate() - 1)
  const groups: DayGroup[] = []
  for (const r of rows) {
    const d = r.created_at ? new Date(r.created_at) : null
    const key = d && !Number.isNaN(d.getTime()) ? dayKey(d) : "unknown"
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) {
      const label =
        key === dayKey(today)
          ? "Today"
          : key === dayKey(yesterday)
            ? "Yesterday"
            : d && key !== "unknown"
              ? d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) })
              : "Undated"
      g = { key, label, rows: [] }
      groups.push(g)
    }
    g.rows.push(r)
  }
  return groups
}

const VERBS: Record<string, string> = {
  created: "created",
  updated: "edited",
  status_changed: "moved",
  reviewed: "reviewed",
  review_requested: "asked for a review on",
  timer_started: "started a session on",
  timer_paused: "paused the session on",
  timer_stopped: "ended the session on",
  claimed: "claimed",
  commented: "commented on",
  comment: "commented on",
}

/// "moved #12" for known task events; anything else (an agent's own log line,
/// a tool name) reads as the action with spaces, and is flagged as a tool so
/// the row can show it in mono.
export function verbOf(action: string): { verb: string; tool: boolean } {
  const known = VERBS[action]
  return known ? { verb: known, tool: false } : { verb: action.replace(/_/g, " "), tool: true }
}
