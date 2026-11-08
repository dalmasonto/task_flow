/// What v3 reads from App.
///
/// App owns every piece of workspace state and the ONE realtime stream (a second
/// EventSource wedges realtime app-wide). v3 never fetches or subscribes on its
/// own: App builds this value from state it already has and hands it down.
/// Grow it here as v3 pages are ported; when v2 is deleted, the state moves out
/// of App into a real provider and this shape stays.
import { createContext, useContext } from "react"

import type { AuthUser } from "@/lib/auth-api"
import type { TaskflowTaskCreate, TaskflowTaskStatus, TaskflowTaskUpdate } from "@/api/client"
import type { BoardColumnId } from "@/lib/board-columns"
import type { CreateProjectInput, RealtimeStatus, TaskflowWorkspace } from "@/lib/taskflow-api"
import type { ColumnId, DropTarget, Project, Task } from "@/lib/workspace-view"

export type V3Project = Project & { taskCount: number }

export type V3Workspace = {
  currentUser: AuthUser | null
  projects: V3Project[]
  activeProject: Project | null
  /// Tasks loaded for the active project (the board's slice, not every task).
  projectTasks: Task[]
  realtimeStatus: RealtimeStatus
  isSyncing: boolean
  counts: {
    pendingReviews: number
    pendingInvites: number
    designUnread: number
    onlineAgents: number
  }
  /// The raw live workspace for the active project (agents, sessions, channels,
  /// messages, …) as App loads it and realtime keeps it current. Which slices
  /// are filled depends on the route (routes.ts v3GatePath) and the flag below.
  live: TaskflowWorkspace | null
  /// The board's store operations, v2's tested ones: the optimistic move +
  /// write, per-column paging, and the server's totals (a paged column must
  /// not claim only what is loaded).
  board: {
    total: number
    columnTotals: Partial<Record<BoardColumnId, number>>
    loadingColumns: ReadonlySet<BoardColumnId>
    syncError: string | null
    placeTask: (taskId: string, target: DropTarget) => void
    loadMore: (columnId: BoardColumnId, loaded: number) => void
  }
  /// The open task (the /v3/tasks/:id page), through v2's own open-task path:
  /// it fetches the task's own detail, so a task the board hasn't paged in
  /// still opens, and `offBoard` says when only the server row is known.
  task: {
    open: (taskId: string | null) => void
    current: Task | null
    offBoard: boolean
    /// The workspace with this task's detail overlaid (activity, files, …).
    live: TaskflowWorkspace | null
    /// Save fields; local state and the raw row reconcile from the response.
    patch: (taskId: string, patch: TaskflowTaskUpdate) => Promise<void>
    move: (taskId: string, status: ColumnId) => void
    remove: (taskId: string) => void
    comment: (taskId: string, body: string) => Promise<void>
    upload: (taskId: string, files: File[]) => Promise<void>
    /// Create in the active project; the new task joins local state from the
    /// server's response (project and created_by are filled in here).
    create: (input: Omit<TaskflowTaskCreate, "project" | "created_by">) => Promise<{ id: string }>
    /// Work sessions follow status (the backend timer opens one on
    /// in_progress, closes it on pause/done/review/blocked); these are v2's
    /// handlers, which move the task and log the activity.
    sessions: {
      start: (task: Task) => void
      pause: (task: Task) => void
      stop: (task: Task, final: Extract<TaskflowTaskStatus, "done" | "partial_done" | "blocked">) => void
    }
  }
  chooseProject: (projectId: string) => void
  /// Create a project and make it active, the same way v2's dialog does.
  createProject: (input: CreateProjectInput) => Promise<{ id: string }>
  /// Tell App a chat/terminal surface is on screen, so it loads the chat and
  /// terminal slices (v2's agents page uses the same signal).
  setChatSurfaceMounted: (mounted: boolean) => void
  refresh: () => void
  /// Apply a local change to the active project's live workspace (what v2's
  /// pages call onWorkspaceUpdate), e.g. after a write the server echoes.
  applyLiveUpdate: (updater: (workspace: TaskflowWorkspace) => TaskflowWorkspace) => void
  /// Refetch the active project's live workspace and wait for it.
  reloadLive: () => Promise<void>
  logout: () => Promise<void>
}

export const V3WorkspaceContext = createContext<V3Workspace | null>(null)

export function useWorkspace(): V3Workspace {
  const value = useContext(V3WorkspaceContext)
  if (!value) throw new Error("useWorkspace() outside V3WorkspaceContext: v3 must render through App's v3 branch")
  return value
}
