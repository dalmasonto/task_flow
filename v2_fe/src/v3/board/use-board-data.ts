/// The board's view of the workspace: filtered tasks plus a card builder that
/// joins each task with its raw row, agents and attachment count.
import { useMemo, useState } from "react"

import type { TaskflowTask } from "@/api/client"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import type { Task } from "@/lib/workspace-view"

import { useWorkspace } from "../workspace"
import { boardRepos, cardInfo, EMPTY_FILTER, filterBoard, type BoardFilter } from "./board-logic"

export function useBoardData(filter: BoardFilter) {
  const { projectTasks, live, currentUser } = useWorkspace()
  const now = useLivenessNow()
  const rawById = useMemo(() => new Map<string, TaskflowTask>((live?.tasks ?? []).map((t) => [String(t.id), t])), [live?.tasks])
  const files = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of live?.taskAttachments ?? []) m.set(String(a.task), (m.get(String(a.task)) ?? 0) + 1)
    return m
  }, [live?.taskAttachments])
  const shown = filterBoard(projectTasks, rawById, filter, currentUser?.id ?? null)
  const card = (t: Task) => cardInfo(t, rawById.get(t.id), live?.agents ?? [], files.get(t.id) ?? 0, now)
  const count = (f: BoardFilter) => filterBoard(projectTasks, rawById, f, currentUser?.id ?? null).length
  return { shown, card, count, repos: boardRepos(rawById.values()), all: projectTasks }
}


const FILTER_KEY = "taskflow.v3.boardFilter"

/// The board's filter, kept for this tab so switching board ↔ list (or opening
/// a task and coming back) doesn't throw it away.
export function useBoardFilter(): [BoardFilter, (f: BoardFilter) => void] {
  const [filter, setFilter] = useState<BoardFilter>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(FILTER_KEY) ?? "null") as Partial<BoardFilter> | null
      return saved ? { ...EMPTY_FILTER, ...saved } : EMPTY_FILTER
    } catch {
      return EMPTY_FILTER
    }
  })
  const update = (f: BoardFilter) => {
    setFilter(f)
    try {
      sessionStorage.setItem(FILTER_KEY, JSON.stringify(f))
    } catch {
      /* private mode: the filter still works for this page */
    }
  }
  return [filter, update]
}
