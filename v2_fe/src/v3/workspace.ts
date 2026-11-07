/// What v3 reads from App.
///
/// App owns every piece of workspace state and the ONE realtime stream (a second
/// EventSource wedges realtime app-wide). v3 never fetches or subscribes on its
/// own: App builds this value from state it already has and hands it down.
/// Grow it here as v3 pages are ported; when v2 is deleted, the state moves out
/// of App into a real provider and this shape stays.
import { createContext, useContext } from "react"

import type { AuthUser } from "@/lib/auth-api"
import type { RealtimeStatus } from "@/lib/taskflow-api"
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
  chooseProject: (projectId: string) => void
  refresh: () => void
  logout: () => Promise<void>
}

export const V3WorkspaceContext = createContext<V3Workspace | null>(null)

export function useWorkspace(): V3Workspace {
  const value = useContext(V3WorkspaceContext)
  if (!value) throw new Error("useWorkspace() outside V3WorkspaceContext: v3 must render through App's v3 branch")
  return value
}
