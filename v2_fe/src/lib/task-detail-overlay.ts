import type { TaskflowWorkspace, WorkspaceTaskDetailSlice } from "@/lib/taskflow-api"

/**
 * #56 review: overlay the OPEN task's task-scoped detail onto the workspace the
 * task sheet reads — filling ONLY the gaps the project-wide capped load missed.
 *
 * The sheet renders definitive "No X yet" states by filtering the workspace's
 * `taskAttachments`/`taskRelations`/`taskReviews`/`taskActivity`/`taskSessions`
 * down to the open task. Those arrays are otherwise loaded project-wide and capped
 * (100 rows, or one paginated feed page), so a task whose rows fell past the cap
 * showed a FALSE empty state. Loading that task's rows task-scoped and overlaying
 * the missing ones here makes the sheet's view complete.
 *
 * **The LIVE base wins.** A first version of this made the detail SNAPSHOT win
 * (it replaced same-id base rows), which resurrected rows realtime had deleted and
 * clobbered newer live edits with the stale snapshot. So the overlay now only
 * APPENDS detail rows whose id is ABSENT from the live base — the base's own copy
 * of any row it already has is authoritative. Deletes are handled by pruning the
 * detail store (see `pruneTaskDetail`) when a delete arrives, so a deleted id is
 * gone from BOTH base and detail and cannot be re-added.
 *
 * Returned as a NEW workspace object so the shared arrays the paginated
 * activity/reviews FEEDS read are never mutated.
 */
export function overlayTaskDetail(
  workspace: TaskflowWorkspace,
  detail: WorkspaceTaskDetailSlice,
): TaskflowWorkspace {
  return {
    ...workspace,
    taskAttachments: fillGaps(workspace.taskAttachments, detail.taskAttachments),
    taskRelations: fillGaps(workspace.taskRelations, detail.taskRelations),
    taskReviews: fillGaps(workspace.taskReviews, detail.taskReviews),
    taskActivity: fillGaps(workspace.taskActivity, detail.taskActivity),
    taskSessions: fillGaps(workspace.taskSessions, detail.taskSessions),
  }
}

/**
 * Drop a row from the open-task detail store when it is deleted (realtime or local
 * mutation), so the overlay cannot re-add a row the live workspace removed. Live
 * UPDATES need no pruning — the base holds the newer row and the overlay skips any
 * id the base already has. Returns the same object when nothing changed.
 */
export function pruneTaskDetail<K extends keyof WorkspaceTaskDetailSlice>(
  detail: { taskId: number } & WorkspaceTaskDetailSlice,
  field: K,
  rowId: number,
): { taskId: number } & WorkspaceTaskDetailSlice {
  const rows = detail[field]
  if (!rows.some((row) => row.id === rowId)) return detail
  return { ...detail, [field]: rows.filter((row) => row.id !== rowId) }
}

/** Append only the `extra` rows whose id is not already in `base` (base wins). */
function fillGaps<T extends { id: number }>(base: T[], extra: T[]): T[] {
  if (extra.length === 0) return base
  const baseIds = new Set(base.map((row) => row.id))
  const missing = extra.filter((row) => !baseIds.has(row.id))
  return missing.length === 0 ? base : [...base, ...missing]
}
