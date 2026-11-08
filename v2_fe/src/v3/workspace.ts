/// What v3 reads from App.
///
/// App owns every piece of workspace state and the ONE realtime stream (a second
/// EventSource wedges realtime app-wide). v3 never fetches or subscribes on its
/// own: App builds this value from state it already has and hands it down.
/// Grow it here as v3 pages are ported; when v2 is deleted, the state moves out
/// of App into a real provider and this shape stays.
import { createContext, useContext } from "react"

import type { AuthUser } from "@/lib/auth-api"
import type { CreateProjectInput, RealtimeStatus, TaskflowWorkspace } from "@/lib/taskflow-api"
import type { Project, Task } from "@/lib/workspace-view"

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
