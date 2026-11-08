/// Flat task statuses (#5933, #5934): v3 shows the server's seven statuses as
/// they are. Paused is not folded into Blocked, and Archived not into Done.
/// v2's five-column `ColumnId` still exists underneath (App pages the board
/// by it), so this is where the two meet.
import type { TaskflowTaskStatus } from "@/api/client"
import type { BoardColumnId } from "@/lib/board-columns"
import { mapLiveStatus, toLiveStatus } from "@/lib/live-mappers"
import type { ColumnId, Task } from "@/lib/workspace-view"

export type TaskStatus = TaskflowTaskStatus

/// Board order.
export const STATUS_ORDER: TaskStatus[] = ["not_started", "in_progress", "paused", "blocked", "partial_done", "done", "archived"]

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (STATUS_ORDER as string[]).includes(v)
}

/// A task's real status. `liveStatus` comes from the server row; after a local
/// move it can lag `status`, and then `status` (the move) wins.
export function statusOf(t: Pick<Task, "status" | "liveStatus">): TaskStatus {
  if (t.liveStatus && mapLiveStatus(t.liveStatus) === t.status) return t.liveStatus
  return toLiveStatus(t.status)
}

/// The five-column page a status loads with (App pages the board by these).
export function pageGroupOf(s: TaskStatus): BoardColumnId {
  return mapLiveStatus(s) as BoardColumnId
}

/// Whether v2's ColumnId move can express this status exactly (paused and
/// archived it can't: it would turn them into blocked and done).
export function columnIdFor(s: TaskStatus): ColumnId | null {
  const c = mapLiveStatus(s)
  return toLiveStatus(c) === s ? c : null
}

/// Read a status from older stored filters and URLs, which used "review".
export function normalizeStatus(v: unknown): TaskStatus | null {
  if (v === "review") return "partial_done"
  return isTaskStatus(v) ? v : null
}
