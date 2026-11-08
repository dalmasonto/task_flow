/// The board's columns (#5907 1b, #5933, #5934): one per status by default,
/// or the project's own list from `GET /projects/{p}/statuses`. Every column
/// maps onto one flat status (`kind`). A task sits in its `status_column` if
/// that is a column of its kind, otherwise in the first column of its kind.
/// That's the server's rule, kept here so a just-moved task lands right away.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

import { STATUS_LABEL } from "../components/status-tones"
import { isTaskStatus, pageGroupOf, STATUS_ORDER, type TaskStatus } from "../lib/task-status"

export type BoardColumn = {
  key: string
  label: string
  kind: TaskStatus
  color: string | null
  hidden: boolean
  /// The server's count for this column, or null when it isn't known (an
  /// older server without the statuses endpoint).
  count: number | null
}

export type BoardColumns = { columns: BoardColumn[]; version: number; custom: boolean; fromServer: boolean }

/// One column per status, archived hidden: what a project that never edited
/// its columns has, and what an older server implies.
export const DEFAULT_COLUMNS: BoardColumns = {
  columns: STATUS_ORDER.map((k) => ({ key: k, label: STATUS_LABEL[k], kind: k, color: null, hidden: k === "archived", count: null })),
  version: 0,
  custom: false,
  fromServer: false,
}

type ServerColumn = { key: string; label: string; kind: string; position?: number; color?: string | null; hidden?: boolean; task_count?: number }

export function parseColumns(body: { columns?: ServerColumn[]; version?: number; custom?: boolean }): BoardColumns {
  const columns = (body.columns ?? [])
    .filter((c) => isTaskStatus(c.kind))
    .map((c) => ({ key: c.key, label: c.label, kind: c.kind as TaskStatus, color: c.color ?? null, hidden: !!c.hidden, count: typeof c.task_count === "number" ? c.task_count : null }))
  if (!columns.length) return DEFAULT_COLUMNS
  return { columns, version: body.version ?? 0, custom: !!body.custom, fromServer: true }
}

/// The key of the column `task` sits in.
export function columnKeyOf(cols: BoardColumn[], status: TaskStatus, statusColumn: string | null | undefined): string | null {
  if (statusColumn && cols.some((c) => c.key === statusColumn && c.kind === status)) return statusColumn
  return cols.find((c) => c.kind === status)?.key ?? null
}

/// Is `key` the first column of its kind (where tasks with no column count)?
export function isFirstOfKind(cols: BoardColumn[], key: string): boolean {
  const col = cols.find((c) => c.key === key)
  return !!col && cols.find((c) => c.kind === col.kind)?.key === key
}

/// `GET /api/taskflow/projects/{p}/statuses`. A 404 from an older server
/// means "no such endpoint": the default columns apply.
/// Remembered for the session, so an older server isn't asked on every change.
let unsupported = false

export async function fetchBoardColumns(project: number, signal?: AbortSignal): Promise<BoardColumns> {
  if (unsupported) return DEFAULT_COLUMNS
  const res = await fetch(`${API_BASE_URL}/api/taskflow/projects/${project}/statuses`, withBearer({ signal }))
  if (res.status === 405) unsupported = true
  if (res.status === 404 || res.status === 405) {
    // 404 is also "no such project / not a member": only an endpoint-shaped
    // 404 (no JSON error code) means the server predates the endpoint.
    const body = await res.json().catch(() => null) as { error?: string } | null
    if (body?.error !== "not_found") unsupported = true
    return DEFAULT_COLUMNS
  }
  if (!res.ok) throw new Error(`Couldn't load the board's columns (${res.status}).`)
  return parseColumns(await res.json())
}

export type ColumnInput = { key: string; label: string; kind: TaskStatus; color?: string | null; hidden?: boolean }

/// `PUT` the whole ordered list (owner/admin). Errors become sentences.
export async function saveBoardColumns(project: number, columns: ColumnInput[], baseVersion: number): Promise<BoardColumns> {
  const res = await fetch(`${API_BASE_URL}/api/taskflow/projects/${project}/statuses`, withBearer({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ columns, base_version: baseVersion }) }))
  if (res.ok) return parseColumns(await res.json())
  let body: { error?: string; detail?: string; missing?: string[] } = {}
  try {
    body = await res.json()
  } catch {
    // Not JSON: fall through to the status.
  }
  if (body.error === "stale") throw new Error("Someone else changed the columns. Reload them and try again.")
  if (body.error === "busy") throw new Error("The columns are being changed right now. Try again in a moment.")
  if (body.error === "kind_missing") throw new Error(`Every status needs a column (it can be hidden). Missing: ${(body.missing ?? []).map((k) => (isTaskStatus(k) ? STATUS_LABEL[k] : k)).join(", ")}.`)
  if (body.error === "duplicate_key") throw new Error(body.detail ?? "Two columns have the same key.")
  if (res.status === 403) throw new Error("Only owners and admins can change the board's columns.")
  throw new Error(body.detail ?? `Couldn't save the columns (${res.status}).`)
}

/// A key for a new column from its label: lowercase, dashes, unique.
export function keyFor(label: string, taken: string[]): string {
  const base = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "column"
  let key = base
  for (let n = 2; taken.includes(key); n++) key = `${base}-${n}`
  return key
}


/// A column's total and whether more of it waits on the server. App pages
/// the board by v2's five groups (paused loads with blocked, archived with
/// done), so "more" is whether the column's group has rows left. The total is
/// the server's count, or the group's total when the group is this status
/// alone. Otherwise it isn't known (null) and reads as "loaded+".
export function columnStats(
  col: Pick<BoardColumn, "kind" | "count">,
  custom: boolean,
  loaded: number,
  groupLoaded: number,
  groupTotal: number,
): { total: number | null; more: boolean } {
  const alone = STATUS_ORDER.filter((k) => pageGroupOf(k) === pageGroupOf(col.kind)).length === 1
  const total = col.count ?? (alone && !custom ? groupTotal : null)
  const groupMore = groupTotal > groupLoaded
  return { total, more: total != null ? total > loaded && groupMore : groupMore }
}
