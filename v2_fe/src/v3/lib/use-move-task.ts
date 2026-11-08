/// Move a task to a flat status (#5933), and optionally to a board column
/// (#5907 1b). v2's `move` takes a five-column id, which would turn Paused
/// into Blocked and Archived into Done. Those, and any move into a named
/// column, go through `patch` with the real status instead. The reviewer's
/// rule: a column move always sends `status` and `status_column` together.
import { useCallback } from "react"
import { toast } from "sonner"

import { useWorkspace } from "../workspace"
import { columnIdFor, type TaskStatus } from "./task-status"

export function useMoveTask() {
  const { task: tv } = useWorkspace()
  return useCallback(
    (taskId: string, status: TaskStatus, column?: string | null) => {
      const simple = columnIdFor(status)
      if (simple && column == null) return tv.move(taskId, simple)
      void tv.patch(taskId, column != null ? { status, status_column: column } : { status }).catch((e: unknown) => {
        toast.error("Couldn't move the task", { description: e instanceof Error ? e.message : undefined })
      })
    },
    [tv],
  )
}
