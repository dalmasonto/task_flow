/// The active project's board columns (see columns.ts). Counts change as
/// tasks move, so the list is re-read a moment after the loaded tasks change
/// (one request, not one per event). `reload()` re-reads after an edit.
import { useEffect, useRef } from "react"

import { useLoad } from "../lib/use-load"
import { useWorkspace } from "../workspace"
import { DEFAULT_COLUMNS, fetchBoardColumns, type BoardColumns } from "./columns"

export function useBoardColumns(): BoardColumns & { reload: () => void; loading: boolean } {
  const { live } = useWorkspace()
  const project = live?.project.id ?? null
  const res = useLoad(project == null ? null : `board-columns:${project}`, (signal) => fetchBoardColumns(project!, signal))
  const reload = res.reload
  const first = useRef(true)
  const tasks = live?.tasks
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(reload, 1200)
    return () => clearTimeout(t)
  }, [tasks, reload])
  return { ...(res.data ?? DEFAULT_COLUMNS), reload, loading: res.loading }
}
