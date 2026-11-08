/// The board's view of the workspace: filtered tasks plus a card builder that
/// joins each task with its raw row, agents and attachment count.
import { useMemo } from "react"

import type { TaskflowTask } from "@/api/client"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import type { Task } from "@/lib/workspace-view"

import { useWorkspace } from "../workspace"
import { boardRepos, cardInfo, filterBoard, type BoardFilter } from "./board-logic"

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
  return { shown, card, repos: boardRepos(rawById.values()), all: projectTasks }
}

