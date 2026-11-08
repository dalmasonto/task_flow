/// The right-hand detail sheet (#5907 items 2 and 12) is driven by the URL,
/// so the page under it stays mounted (no board reload on a slow network),
/// Back closes it, and a link to "this task over the board" can be shared.
///
///   ?task=<id>             a task
///   ?task=new[&status=x]   the new-task form
///   ?activity=<id>         one activity entry
///   ?terminal=<agent id>   an agent's live terminal
///
/// Pure, so the rules are tested without rendering.
import { normalizeStatus, type TaskStatus } from "./task-status"

export type Detail = { kind: "task"; id: string } | { kind: "new-task"; status: TaskStatus; column?: string | null } | { kind: "activity"; id: number } | { kind: "terminal"; agent: number }

const KEYS = ["task", "activity", "status", "column", "terminal"] as const

export function readDetail(params: URLSearchParams): Detail | null {
  const task = params.get("task")
  if (task === "new") {
    const s = params.get("status")
    // "review" from older links reads as In review (#5933: flat statuses).
    return { kind: "new-task", status: normalizeStatus(s) ?? "not_started", column: params.get("column") || null }
  }
  if (task && /^\d+$/.test(task)) return { kind: "task", id: task }
  const activity = params.get("activity")
  if (activity && /^\d+$/.test(activity)) return { kind: "activity", id: Number(activity) }
  const terminal = params.get("terminal")
  if (terminal && /^\d+$/.test(terminal)) return { kind: "terminal", agent: Number(terminal) }
  return null
}

/// `search` with the sheet's keys replaced by `detail` (or removed when null).
/// Other params, like a board filter, are kept.
export function withDetail(search: string, detail: Detail | null): string {
  const p = new URLSearchParams(search)
  for (const k of KEYS) p.delete(k)
  if (detail?.kind === "task") p.set("task", detail.id)
  else if (detail?.kind === "new-task") {
    p.set("task", "new")
    if (detail.status !== "not_started") p.set("status", detail.status)
    if (detail.column) p.set("column", detail.column)
  } else if (detail?.kind === "activity") p.set("activity", String(detail.id))
  else if (detail?.kind === "terminal") p.set("terminal", String(detail.agent))
  const s = p.toString()
  return s ? `?${s}` : ""
}

/// Where a detail opens from `pathname`. On the full task page (which owns the
/// one open task) another task goes to its own page instead of a sheet.
export function detailHref(pathname: string, search: string, detail: Detail): string {
  if (pathname.startsWith("/v3/tasks/")) {
    if (detail.kind === "task") return `/v3/tasks/${detail.id}`
    if (detail.kind === "new-task") return `/v3/tasks/new${withDetail("", detail).replace(/^\?task=new&?/, "?").replace(/^\?$/, "")}`
  }
  return `${pathname}${withDetail(search, detail)}`
}
