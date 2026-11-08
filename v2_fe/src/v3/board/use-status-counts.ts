/// How many tasks the active project has in each flat status (#5933). The
/// board's columns carry counts on a server with #1b; they're summed per
/// status. An older server has no per-status counts, so each status is one
/// small count request (page_size 1).
import { useMemo } from "react"

import { taskflowApi, taskflowTables } from "@/lib/taskflow-api"

import { useLoad } from "../lib/use-load"
import { STATUS_ORDER, type TaskStatus } from "../lib/task-status"
import { useWorkspace } from "../workspace"
import { useBoardColumns } from "./use-board-columns"

export function useStatusCounts(): Partial<Record<TaskStatus, number>> {
  const { live } = useWorkspace()
  const project = live?.project.id ?? null
  const cols = useBoardColumns()
  const fromColumns = useMemo(() => {
    if (!cols.fromServer || cols.columns.some((c) => c.count == null)) return null
    const out: Partial<Record<TaskStatus, number>> = {}
    for (const c of cols.columns) out[c.kind] = (out[c.kind] ?? 0) + (c.count ?? 0)
    return out
  }, [cols])
  const fallback = useLoad(project != null && !cols.loading && fromColumns == null ? `status-counts:${project}` : null, async () => {
    const counts = await Promise.all(
      STATUS_ORDER.map((s) =>
        taskflowApi
          .from(taskflowTables.tasks)
          .filter({ project: project!, status: s })
          .param("page_size", 1)
          .list()
          .then((r) => [s, r.count] as const),
      ),
    )
    return Object.fromEntries(counts) as Record<TaskStatus, number>
  })
  return fromColumns ?? fallback.data ?? {}
}
