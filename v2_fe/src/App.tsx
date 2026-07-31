import { fetchTaskRef } from "@/lib/task-ref-fetch"
import { Button } from "@/components/ui/button"
import { SecurityPage } from "@/pages/account/SecurityPage"
import { InvitationsPage } from "@/pages/account/InvitationsPage"
import { SettingsPage } from "@/pages/account/SettingsPage"
import { ProfilePage } from "@/pages/account/ProfilePage"
import { AccountLayout } from "@/pages/account/AccountLayout"
import { BOARD_PRIORITIES } from "@/lib/board-filter"
import { MediaPage } from "@/pages/dashboard/MediaPage"
import { OverviewPage } from "@/pages/dashboard/OverviewPage"
import { taskRefState } from "@/lib/task-ref-state"
import { type TaskRefState } from "@/lib/task-ref-state"
import { type TaskRefAnswer } from "@/lib/task-ref-state"
import { filterBoardTasks } from "@/lib/board-filter"
import { ALL_PRIORITIES } from "@/lib/board-filter"
import { messageToTask } from "@/lib/message-to-task"
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react"
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { ActivityIcon, BellIcon, FileTextIcon, GitBranchIcon, InfoIcon, KanbanSquareIcon, MessageSquareIcon, MoreHorizontalIcon, PlayIcon, PlusIcon, SearchIcon, UserRoundPlusIcon } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { TaskChipContext, GithubRepoContext, ChatDockContext } from "@/lib/markdown-contexts"
import { loadDockOpen, loadDockChatId, saveDockState } from "@/lib/chat-dock-state"
import { type BoardColumnId } from "@/lib/board-columns"
import { Input } from "@/components/ui/input"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { fetchCurrentUser, hasStoredAuthSession, getStoredUser, logoutUser, type AuthUser } from "@/lib/auth-api"
import type { TaskflowAgentMessage, TaskflowMessageAttachment, TaskflowProjectUpdate, TaskflowTaskStatus } from "@/api/client"
import { archiveTaskflowProject, createTaskflowChannel, createTaskflowProjectInvite, createTaskflowTaskActivity, createTaskflowTaskSession, createTaskflowTask, createTaskflowProject, fetchMyInvites, fetchTaskflowProjectSummary, fetchTaskflowWorkspace, fetchBoardColumn, fetchWorkspaceChat, fetchWorkspaceActivity, fetchActivityActions, openTaskflowRealtimeStream, taskflowRealtimeGroups, isScopeDenial, realtimeEventHasInlineRow, reviewTask as submitTaskReview, taskflowApi, taskflowTables, updateTaskflowProject, updateTaskflowTask, updateTaskflowTaskSession, uploadTaskAttachment, type RealtimeStatus, type TaskflowRealtimeEvent, type TaskflowWorkspace } from "@/lib/taskflow-api"
import { reconcile, removeMessage } from "@/lib/message-store"
import { cn } from "@/lib/utils"
import { formatEstimateMinutes, parseEstimateMinutes } from "@/lib/tasks"
import { firstLine } from "@/lib/markdown"
import { isoToDatetimeLocalInput, datetimeLocalInputToIso } from "@/lib/datetime"
import { ALL_TOOLS } from "@/lib/activity-filter"

/// The shared room every project gets. Named in one place so the auto-open
/// preference and the create path cannot drift apart.
import { ActivityLogPage } from "@/pages/activity"
import { AgentsConversationEmpty, AgentsConversationRoute, AgentsPage } from "@/pages/agents"
import { ApiBasePage } from "@/pages/api-base"
import { AuthGateScreen, AuthPage } from "@/pages/auth"
import { BoardLoadMoreSentinel, DropIndicator, EndDropIndicator, Metric, TaskCard, TaskRefNotice } from "@/components/board"
import { ChatDock } from "@/components/chat/chat-dock"
import { GithubHeaderButton, NoProjectEmptyState } from "@/components/layout"
import { TaskDetailSheet } from "@/components/task-sheet"
import { InvitesPage } from "@/pages/invites"
import { LandingPage } from "@/pages/landing"
import { MAX_LIVE_ACTIVITY, MAX_LIVE_TERMINAL_FRAMES, countOnlineAgents, formatDuration, formatLiveDate, getRunningLiveTaskSession, liveId, mapLiveActivityEvents, mapLiveDirectChats, mapLiveInvites, mapLivePriority, mapLiveProjectRow, mapLiveProjects, mapLiveReviews, mapLiveStatus, mapLiveTasks, mergeProjectTasks, normalizeAgentInviteEmail, realtimeEventRowId, removeById, reorderTasks, sessionDurationSeconds, slugifyProjectName, toLiveInviteRole, toLivePriority, toLiveStatus, upsertById, upsertCapped, type ReviewFeedItem } from "@/lib/live-mappers"
import { ReviewsPage } from "@/pages/reviews"
import { TaskSessionDock } from "@/components/session-dock"
import { WorkspaceDialog } from "@/components/workspace-dialog"
import { columns, nextStatus, previousStatus, type ActivityEvent, type AuthGateStatus, type ColumnId, type DialogMode, type DropTarget, type Priority, type Project, type Task } from "@/lib/workspace-view"
import { useLivenessNow } from "@/hooks/use-liveness-now"


function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [workspaceProjects, setWorkspaceProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  // Incremented every time a fresh core workspace replaces the current one.
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // #56: the last page fetched for each board column. A ref, not state — it
  // guards a fetch and must not be stale inside the sentinel's callback, and it
  // has no business triggering a render of its own.
  //
  // This replaces #26's client-side limit, which sliced an array that already
  // held every task. The column now holds only what has been fetched, and the
  // sentinel asks the server for the next 25.
  const boardColumnPages = useRef<Record<string, number>>({})
  useEffect(() => {
    boardColumnPages.current = {}
  }, [activeProjectId])


  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [dialogMode, setDialogMode] = useState<DialogMode>(null)
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null)
  // The task.id being edited; the edit dialog reuses the Create Task form.
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  // Controlled state for the Create Task dialog's owner/operator/due fields.
  // shadcn Select and datetime-local are controlled, and handleCreateTask reads
  // these from state (not FormData); the rest of the form stays uncontrolled.
  // #50: a message being turned into a task seeds the NEW TASK dialog rather
  // than creating anything. The point is to add context — images, a due date,
  // an owner — before saving, so a silent create was the wrong shape.
  const [composeSeed, setComposeSeed] = useState<{ title: string; description: string; nonce: number } | null>(null)
  const composeTaskFromMessage = useCallback((body: string) => {
    const parsed = messageToTask(body)
    if (!parsed) return
    // The nonce keys the dialog: defaultValue only applies on mount, so opening
    // it a second time with different text would otherwise show the first seed.
    setComposeSeed({ ...parsed, nonce: Date.now() })
    setDialogMode("new-task")
  }, [])

  const [newTaskOwner, setNewTaskOwner] = useState<{ id: number; label: string } | null>(null)
  const [newTaskOperator, setNewTaskOperator] = useState<string>("") // "" | "user:N" | "agent:N"
  const [newTaskDue, setNewTaskDue] = useState<string>("") // datetime-local value
  const [usesLiveApi, setUsesLiveApi] = useState(false)
  const [isLiveSyncing, setIsLiveSyncing] = useState(false)
  const [liveSyncError, setLiveSyncError] = useState<string | null>(null)
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting")
  const [liveWorkspace, setLiveWorkspace] = useState<TaskflowWorkspace | null>(null)
  // Mirror of liveWorkspace for stable callbacks (e.g. the realtime handler) that
  // must read the latest members/agents without taking a reactive dependency.
  const liveWorkspaceRef = useRef(liveWorkspace)
  useEffect(() => {
    liveWorkspaceRef.current = liveWorkspace
  }, [liveWorkspace])
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() =>
    hasStoredAuthSession() ? getStoredUser() : null
  )
  const [authGateStatus, setAuthGateStatus] = useState<AuthGateStatus>(
    () => (hasStoredAuthSession() ? "checking" : "anonymous")
  )
  // The signed-in user's own invite inbox count (GET .../invites/mine), distinct
  // from `pendingInvites` below which counts the ACTIVE PROJECT's outgoing invites.
  const [myInviteCount, setMyInviteCount] = useState(0)
  const refreshMyInviteCount = useCallback(async () => {
    try {
      const rows = await fetchMyInvites()
      setMyInviteCount(rows.length)
    } catch {
      // Transient failure — keep showing the last known count.
    }
  }, [])

  const activeProjectBase: Project | undefined =
    workspaceProjects.find((project) => project.id === activeProjectId) ?? workspaceProjects[0]
  const activeLiveProjectId = activeProjectBase ? liveId(activeProjectBase.id) : null
  const activeLiveWorkspace =
    activeLiveProjectId && liveWorkspace?.project.id === activeLiveProjectId ? liveWorkspace : null
  // The snapshot count from mapLiveProjects can go stale between summary fetches;
  // when we hold the live workspace, recompute online agents from its sessions +
  // heartbeats so the dashboard/sidebar/API Base reflect real presence.
  //
  // The tick is load-bearing: recomputing only "whenever the workspace changes"
  // sounds sufficient because heartbeats ARE workspace changes — but an agent
  // that dies stops sending them, so the count would freeze at its last live
  // value precisely when it needs to fall.
  const appLivenessNow = useLivenessNow()
  const activeProject: Project | undefined = useMemo(
    () =>
      activeProjectBase && activeLiveWorkspace
        ? { ...activeProjectBase, agentsOnline: countOnlineAgents(activeLiveWorkspace, appLivenessNow) }
        : activeProjectBase,
    [activeProjectBase, activeLiveWorkspace, appLivenessNow]
  )
  // id -> title for the Media page's source chips ("#general" etc). Falls back
  // to `#${id}` for a channel that isn't (yet) in the live workspace snapshot.
  const liveChannelTitles = useMemo(() => {
    const map = new Map<number, string>()
    for (const channel of activeLiveWorkspace?.agentChannels ?? []) {
      map.set(channel.id, channel.title)
    }
    return map
  }, [activeLiveWorkspace])
  const mediaChannelName = useCallback(
    (channelId: number | null) => (channelId != null ? liveChannelTitles.get(channelId) ?? `#${channelId}` : "Chat"),
    [liveChannelTitles]
  )
  const projectTasks = useMemo(
    () => (activeProject ? tasks.filter((task) => task.projectId === activeProject.id) : []),
    [activeProject, tasks]
  )
  // Board search + priority filter. Applied only to the board columns, not the
  // project metrics (those stay whole-project totals).
  const [boardSearch, setBoardSearch] = useState("")
  const [boardPriority, setBoardPriority] = useState<string>(ALL_PRIORITIES)
  const boardFilteredTasks = useMemo(
    () => filterBoardTasks(projectTasks, { search: boardSearch, priority: boardPriority }),
    [projectTasks, boardSearch, boardPriority]
  )
  const boardFilterActive = boardSearch.trim() !== "" || boardPriority !== ALL_PRIORITIES
  const selectedTask =
    projectTasks.find((task) => task.id === selectedTaskId) ?? projectTasks[0]
  const openTask = openTaskId ? tasks.find((task) => task.id === openTaskId) : undefined
  // #49: a TASK#<n> chip must always explain itself — and only the SERVER can
  // say whether an id exists. This used to resolve against `tasks`, on the
  // claim that it held everything the user could see. It does not: realtime is
  // scoped to the subscribed project, the summary fetch takes one 100-row page,
  // and a failed refetch leaves a hole. Every one of those reported a real task
  // as "doesn't exist". See lib/task-ref-state.ts.
  // The answer is stored WITH the id it answers, so "loading" is derived from
  // "no answer for this id yet" rather than written by the effect. That removes
  // a synchronous setState on every open and, more usefully, makes it
  // impossible for a slow answer about a previous chip to be shown for this one.
  const [taskRefAnswer, setTaskRefAnswer] = useState<{ id: string; answer: TaskRefAnswer } | null>(
    null
  )
  const openTaskRef: TaskRefState | null = !openTaskId
    ? null
    : taskRefAnswer?.id === openTaskId
      ? taskRefState(taskRefAnswer.answer, activeProject?.id ?? null)
      : openTask && activeProject
        ? // A cache HIT is not a veto — it is the server's own earlier answer,
          // so open immediately and let the request refine it. Only a cache MISS
          // has to wait, because none of the ways the board goes stale (realtime
          // scoping, the 100-row summary page, a failed refetch) can invent a
          // task that is not there. Without this, every board-card click dimmed
          // the screen behind a modal spinner for one round trip.
          { kind: "ready", taskId: openTaskId }
        : taskRefState({ status: "loading" }, activeProject?.id ?? null)

  // Render the sheet from the SERVER's row when the board has not got it.
  // Requiring the local row was the last place the cache could veto opening a
  // task the server had already confirmed — it produced "the server confirmed
  // this task, but it isn't on the loaded board" about a task sitting in the
  // response.
  //
  // Attachments, relations and activity still come from the workspace, and a
  // server-only row is not in it. The sheet must therefore SAY so rather than
  // render "no attachments yet" over a task that may have several — see
  // `openTaskOffBoard` below.
  const openTaskServerRow =
    taskRefAnswer?.id === openTaskId && taskRefAnswer.answer.status === "found"
      ? taskRefAnswer.answer.row
      : undefined
  const openTaskFromServer = useMemo(() => {
    if (!openTaskServerRow) return undefined
    const [mapped] = mapLiveTasks(
      [openTaskServerRow],
      activeLiveWorkspace?.members ?? [],
      activeLiveWorkspace?.agents ?? []
    )
    return mapped
  }, [openTaskServerRow, activeLiveWorkspace])
  // Board row first (it carries whatever the board has enriched), server row
  // as the guarantee that a confirmed task always opens.
  const openTaskResolved = openTask ?? openTaskFromServer
  // True when we are rendering from the server row alone. Everything the
  // workspace owns — attachments, relations, activity — is unknown rather than
  // absent, and the difference is exactly the class of lie this whole sequence
  // of fixes exists to remove.
  const openTaskOffBoard = !openTask && Boolean(openTaskFromServer)
  const reviewTask = reviewTaskId ? tasks.find((task) => task.id === reviewTaskId) : selectedTask
  // Pre-fill the edit dialog from the LIVE task row (it keeps the raw ids/columns
  // that mapLiveTasks drops), converting live enums back into form values.
  const editTaskRow = editTaskId ? activeLiveWorkspace?.tasks.find((task) => String(task.id) === editTaskId) : undefined
  const editTaskSeed = editTaskRow
    ? {
        title: editTaskRow.title,
        status: mapLiveStatus(editTaskRow.status),
        priority: mapLivePriority(editTaskRow.priority),
        estimate: editTaskRow.estimate_minutes != null ? String(editTaskRow.estimate_minutes) : "",
        description: editTaskRow.description_markdown,
        notes: editTaskRow.notes_markdown ?? "",
        review: editTaskRow.review_gate ?? "",
      }
    : undefined
  const pendingReviews = tasks.filter((task) => task.status === "review").length
  const projectInviteRecords = activeLiveWorkspace ? mapLiveInvites(activeLiveWorkspace, currentUser) : []
  const pendingInvites = projectInviteRecords.filter((invite) => invite.status === "Pending" || invite.status === "Needs auth").length
  const blockedCount = projectTasks.filter((task) => task.status === "blocked").length
  const activeCount = projectTasks.filter((task) => task.status === "in_progress").length
  const doneCount = projectTasks.filter((task) => task.status === "done").length
  const completion = projectTasks.length ? Math.round((doneCount / projectTasks.length) * 100) : 0
  const sidebarProjects = workspaceProjects.map((project) => ({
    ...project,
    taskCount: tasks.filter((task) => task.projectId === project.id).length,
  }))
  // #38: the activity feed is capped at 1000 by the server (umbral NoPagination).
  // These hold older windows fetched by id cursor so history beyond the newest
  // 1000 can be walked in, on demand, rather than being silently truncated.
  // #56: the activity feed is TRUE pagination — one page held at a time, chosen
  // from a page list. The old accumulate-and-append path (olderActivity,
  // dedupeById, olderExhausted) is gone: it existed to walk past the 1000-row
  // cap, and holding every page defeats the point of paging.
  const [activityPage, setActivityPage] = useState(1)
  const [activityTotal, setActivityTotal] = useState(0)
  // From the response envelope, never derived: the SERVER pages the feed
  // (PageNumberPagination in backend/src/main.rs), so only the server knows how
  // many pages there are. A frontend ceil(count / OWN_CONSTANT) is how the
  // pager once claimed 40-row pages over an API serving 25.
  const [activityTotalPages, setActivityTotalPages] = useState(1)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Server-side, so the tool filter applies to the WHOLE feed rather than to
  // whichever page happens to be loaded. Lifted out of ActivityLogPage for that
  // reason. Free-text search stays in the page — see the note on
  // fetchWorkspaceActivity for why it cannot go server-side.
  const [activityTool, setActivityTool] = useState<string>(ALL_TOOLS)
  // The COMPLETE option list, from an endpoint the filter does not affect.
  const [activityToolOptions, setActivityToolOptions] = useState<string[]>([])

  useEffect(() => {
    setActivityPage(1)
    setActivityTotal(0)
    setActivityTotalPages(1)
    setActivityTool(ALL_TOOLS)
    setActivityToolOptions([])
  }, [activeProjectId])

  const activityEvents = useMemo<ActivityEvent[]>(
    () => (activeLiveWorkspace ? mapLiveActivityEvents(activeLiveWorkspace, projectTasks) : []),
    [activeLiveWorkspace, projectTasks]
  )



  // #56: activity loads ONLY when the user asks for the next page.
  //
  // #38's auto-loader is gone. It existed to work around the 1000-row
  // NoPagination cap — walking older windows so the count reflected the true
  // total instead of the cap. With real pagination the server reports that total
  // directly, so the loop had nothing left to discover and simply pulled pages
  // nobody had asked for, defeating the point of paging at all.
  const reviewFeed = useMemo<ReviewFeedItem[]>(
    () => (activeLiveWorkspace ? mapLiveReviews(activeLiveWorkspace, projectTasks) : []),
    [activeLiveWorkspace, projectTasks]
  )
  const publicPath = location.pathname.replace(/\/$/, "") || "/"
  const authMode =
    publicPath === "/login"
      ? "login"
      : publicPath === "/signup"
        ? "signup"
        : publicPath === "/reset-password"
          ? "reset"
          : publicPath.startsWith("/confirm-password")
            ? "confirm"
          : null
  const legacyDashboardRoutes: Record<string, string> = {
    "/board": "/dashboard/board",
    "/agents": "/dashboard/agents",
    "/reviews": "/dashboard/reviews",
    "/history": "/dashboard/activity",
    "/activity": "/dashboard/activity",
    "/invites": "/dashboard/invites",
    "/settings": "/dashboard/api",
    "/api": "/dashboard/api",
  }
  const isDashboardRoute = publicPath.startsWith("/dashboard")
  const isAccountRoute = publicPath.startsWith("/account")
  // Both areas live inside the authenticated dashboard shell and share the same
  // auth gate and current-user fetch.
  const isAppRoute = isDashboardRoute || isAccountRoute
  const hasAuthSession = hasStoredAuthSession()
  const accountProjects = useMemo(
    () =>
      workspaceProjects
        .map((project) => {
          const id = liveId(project.id)
          return id ? { id, name: project.name } : null
        })
        .filter((project): project is { id: number; name: string } => project !== null),
    [workspaceProjects]
  )

  const loadLiveWorkspace = useCallback(
    async (preferredProjectId: string | null = activeProjectId) => {
      setIsLiveSyncing(true)

      try {
        const summary = await fetchTaskflowProjectSummary()

        // The API responded successfully. Zero projects is a valid, honest state
        // (a first-time user, or someone with no accepted invites yet) — NOT an
        // error and NOT a reason to show fixture data. Clear everything and let
        // the dashboard render its empty state.
        if (!summary.projects.length) {
          setUsesLiveApi(true)
          setWorkspaceProjects([])
          setActiveProjectId(null)
          setTasks([])
          setSelectedTaskId(null)
          setLiveWorkspace(null)
          setLiveSyncError(null)
          return
        }

        const nextProjects = mapLiveProjects(summary)
        const nextActiveProjectId =
          preferredProjectId && nextProjects.some((project) => project.id === preferredProjectId)
            ? preferredProjectId
            : nextProjects[0].id
        const nextProjectId = liveId(nextActiveProjectId) ?? summary.projects[0].id
        const summaryTasks = mapLiveTasks(summary.tasks, summary.members, summary.agents)

        setWorkspaceProjects(nextProjects)
        setUsesLiveApi(true)
        setActiveProjectId(nextActiveProjectId)
        setTasks(summaryTasks)
        setLiveWorkspace((current) => (current?.project.id === nextProjectId ? current : null))
        setSelectedTaskId((current) => {
          if (summaryTasks.some((task) => task.projectId === nextActiveProjectId && task.id === current)) return current
          return summaryTasks.find((task) => task.projectId === nextActiveProjectId)?.id ?? current
        })

        try {
          const workspace = await fetchTaskflowWorkspace(nextProjectId)
          const nextProjectTasks = mapLiveTasks(workspace.tasks, workspace.members, workspace.agents)

          setLiveWorkspace(workspace)
          // #56: a fresh CORE workspace carries empty chat/activity arrays, so
          // it silently discards any slice already merged in. Bumping the epoch
          // makes the slice loader treat this like a new project and refetch —
          // without it the ref flag still said "loaded", the arrays stayed
          // empty, and the Agents page showed "select a conversation" against a
          // URL that named a real one.
          setWorkspaceEpoch((current) => current + 1)
          setTasks((current) => mergeProjectTasks(current, nextActiveProjectId, nextProjectTasks))
          setSelectedTaskId((current) => {
            if (nextProjectTasks.some((task) => task.id === current)) return current
            return nextProjectTasks[0]?.id ?? current
          })
          setLiveSyncError(null)
        } catch (error) {
          setLiveWorkspace(null)
          setLiveSyncError(
            error instanceof Error
              ? `Live project summary loaded, but project detail failed: ${error.message}`
              : "Live project summary loaded, but project detail failed."
          )
        }
      } catch (error) {
        setLiveWorkspace(null)
        setLiveSyncError(error instanceof Error ? error.message : "Could not load the live TaskFlow API.")
      } finally {
        setIsLiveSyncing(false)
      }
    },
    [activeProjectId]
  )

  const applyWorkspaceUpdate = useCallback(
    (projectId: number, updater: (workspace: TaskflowWorkspace) => TaskflowWorkspace) => {
      setLiveWorkspace((current) => (current?.project.id === projectId ? updater(current) : current))
    },
    []
  )

  const applyRealtimeDeletion = useCallback(
    (event: TaskflowRealtimeEvent, rowId: number, projectId: number | null) => {
      if (event.table === taskflowTables.projects) {
        setWorkspaceProjects((current) => current.filter((project) => project.id !== String(rowId)))
        if (projectId === rowId) setLiveWorkspace(null)
        return
      }

      if (!projectId) return

      switch (event.table) {
        case taskflowTables.members:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, members: removeById(workspace.members, rowId) }))
          break
        case taskflowTables.invites:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, invites: removeById(workspace.invites, rowId) }))
          break
        case taskflowTables.apiEndpoints:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, apiEndpoints: removeById(workspace.apiEndpoints, rowId) }))
          break
        case taskflowTables.tasks:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, tasks: removeById(workspace.tasks, rowId) }))
          setTasks((current) => current.filter((task) => task.id !== String(rowId)))
          break
        case taskflowTables.taskRelations:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskRelations: removeById(workspace.taskRelations, rowId) }))
          break
        case taskflowTables.agentPrompts:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agentPrompts: removeById(workspace.agentPrompts, rowId) }))
          break
        case taskflowTables.taskActivity:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskActivity: removeById(workspace.taskActivity, rowId) }))
          break
        case taskflowTables.taskSessions:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskSessions: removeById(workspace.taskSessions, rowId) }))
          break
        case taskflowTables.agents:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agents: removeById(workspace.agents, rowId) }))
          break
        case taskflowTables.agentCredentials:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agentCredentials: removeById(workspace.agentCredentials, rowId) }))
          break
        case taskflowTables.agentSessions:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agentSessions: removeById(workspace.agentSessions, rowId) }))
          break
        case taskflowTables.agentChannels:
          applyWorkspaceUpdate(projectId, (workspace) => ({
            ...workspace,
            agentChannels: removeById(workspace.agentChannels, rowId),
            agentMessages: workspace.agentMessages.filter((message) => message.channel !== rowId),
            agentChannelMembers: workspace.agentChannelMembers.filter((member) => member.channel !== rowId),
          }))
          break
        case taskflowTables.agentChannelMembers:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agentChannelMembers: removeById(workspace.agentChannelMembers, rowId) }))
          break
        case taskflowTables.agentMessages:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agentMessages: removeMessage(workspace.agentMessages, rowId) }))
          break
        case taskflowTables.messageAttachments:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, messageAttachments: removeById(workspace.messageAttachments, rowId) }))
          break
        case taskflowTables.terminalFrames:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, terminalFrames: removeById(workspace.terminalFrames, rowId) }))
          break
        case taskflowTables.channelReadCursors:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, channelReadCursors: removeById(workspace.channelReadCursors, rowId) }))
          break
        case taskflowTables.taskReviews:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskReviews: removeById(workspace.taskReviews, rowId) }))
          break
      }
    },
    [applyWorkspaceUpdate]
  )

  const applyRealtimeRow = useCallback(
    (event: TaskflowRealtimeEvent, row: unknown, projectId: number | null) => {
      if (event.table === taskflowTables.projects) {
        const project = row as TaskflowWorkspace["project"]
        setWorkspaceProjects((current) => {
          const index = current.findIndex((item) => item.id === String(project.id))
          const mapped = mapLiveProjectRow(project, index >= 0 ? current[index] : undefined, index >= 0 ? index : current.length)
          return index >= 0
            ? [...current.slice(0, index), mapped, ...current.slice(index + 1)]
            : [...current, mapped]
        })
        applyWorkspaceUpdate(project.id, (workspace) => ({ ...workspace, project }))
        return
      }

      if (!projectId) return

      switch (event.table) {
        case taskflowTables.members: {
          const member = row as TaskflowWorkspace["members"][number]
          if (member.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, members: upsertById(workspace.members, member) }))
          break
        }
        case taskflowTables.invites: {
          const invite = row as TaskflowWorkspace["invites"][number]
          if (invite.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, invites: upsertById(workspace.invites, invite) }))
          break
        }
        case taskflowTables.apiEndpoints: {
          const apiEndpoint = row as TaskflowWorkspace["apiEndpoints"][number]
          if (apiEndpoint.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, apiEndpoints: upsertById(workspace.apiEndpoints, apiEndpoint) }))
          break
        }
        case taskflowTables.tasks: {
          const task = row as TaskflowWorkspace["tasks"][number]
          if (task.project !== projectId) return
          const [mappedTask] = mapLiveTasks(
            [task],
            liveWorkspaceRef.current?.members ?? [],
            liveWorkspaceRef.current?.agents ?? []
          )
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, tasks: upsertById(workspace.tasks, task) }))
          setTasks((current) => {
            const index = current.findIndex((item) => item.id === mappedTask.id)
            return index >= 0
              ? [...current.slice(0, index), mappedTask, ...current.slice(index + 1)]
              : [...current, mappedTask]
          })
          break
        }
        case taskflowTables.taskRelations: {
          const relation = row as TaskflowWorkspace["taskRelations"][number]
          if (relation.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskRelations: upsertById(workspace.taskRelations, relation) }))
          break
        }
        case taskflowTables.taskActivity: {
          const activity = row as TaskflowWorkspace["taskActivity"][number]
          if (activity.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskActivity: upsertCapped(workspace.taskActivity, activity, MAX_LIVE_ACTIVITY) }))
          break
        }
        case taskflowTables.taskSessions: {
          const session = row as TaskflowWorkspace["taskSessions"][number]
          if (session.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskSessions: upsertById(workspace.taskSessions, session) }))
          break
        }
        case taskflowTables.agents: {
          const agent = row as TaskflowWorkspace["agents"][number]
          if (agent.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agents: upsertById(workspace.agents, agent) }))
          break
        }
        case taskflowTables.agentCredentials: {
          const credential = row as TaskflowWorkspace["agentCredentials"][number]
          if (credential.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agentCredentials: upsertById(workspace.agentCredentials, credential) }))
          break
        }
        case taskflowTables.agentSessions: {
          const session = row as TaskflowWorkspace["agentSessions"][number]
          if (session.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agentSessions: upsertById(workspace.agentSessions, session) }))
          break
        }
        case taskflowTables.agentChannels: {
          const channel = row as TaskflowWorkspace["agentChannels"][number]
          if (channel.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agentChannels: upsertById(workspace.agentChannels, channel) }))
          break
        }
        case taskflowTables.agentChannelMembers: {
          const member = row as TaskflowWorkspace["agentChannelMembers"][number]
          applyWorkspaceUpdate(projectId, (workspace) => {
            if (!workspace.agentChannels.some((channel) => channel.id === member.channel)) return workspace
            return { ...workspace, agentChannelMembers: upsertById(workspace.agentChannelMembers, member) }
          })
          break
        }
        case taskflowTables.agentMessages: {
          const message = row as TaskflowAgentMessage
          if (message.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({
            ...workspace,
            agentMessages: reconcile(workspace.agentMessages, message),
          }))
          break
        }
        case taskflowTables.messageAttachments: {
          const attachment = row as TaskflowMessageAttachment
          if (attachment.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({
            ...workspace,
            messageAttachments: upsertById(workspace.messageAttachments, attachment),
          }))
          break
        }
        case taskflowTables.terminalFrames: {
          const frame = row as TaskflowWorkspace["terminalFrames"][number]
          if (frame.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, terminalFrames: upsertCapped(workspace.terminalFrames, frame, MAX_LIVE_TERMINAL_FRAMES) }))
          break
        }
        case taskflowTables.channelReadCursors: {
          const cursor = row as TaskflowWorkspace["channelReadCursors"][number]
          if (cursor.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, channelReadCursors: upsertById(workspace.channelReadCursors, cursor) }))
          break
        }
        case taskflowTables.taskReviews: {
          const review = row as TaskflowWorkspace["taskReviews"][number]
          if (review.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskReviews: upsertById(workspace.taskReviews, review) }))
          break
        }
        case taskflowTables.agentPrompts: {
          const prompt = row as TaskflowWorkspace["agentPrompts"][number]
          if (prompt.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, agentPrompts: upsertById(workspace.agentPrompts, prompt) }))
          break
        }
      }
    },
    [applyWorkspaceUpdate]
  )

  const fetchAndApplyRealtimeEvent = useCallback(
    async (event: TaskflowRealtimeEvent, projectId: number | null) => {
      const rowId = realtimeEventRowId(event)
      if (!rowId) return

      if (event.action === "deleted") {
        applyRealtimeDeletion(event, rowId, projectId)
        return
      }

      // A few high-frequency non-chat tables project their fields server-side,
      // so the event already carries the row. Refetching would be a round-trip
      // for data we hold. Chat is NOT among them — see `realtimeTablesWithInlineRows`.
      if (realtimeEventHasInlineRow(event.table)) {
        applyRealtimeRow(event, event.row as never, projectId)
        return
      }

      try {
        switch (event.table) {
          case taskflowTables.projects:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.projects, rowId), projectId)
            break
          case taskflowTables.members:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.members, rowId), projectId)
            break
          case taskflowTables.invites:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.invites, rowId), projectId)
            break
          case taskflowTables.apiEndpoints:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.apiEndpoints, rowId), projectId)
            break
          case taskflowTables.tasks:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.tasks, rowId), projectId)
            break
          case taskflowTables.taskRelations:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.taskRelations, rowId), projectId)
            break
          case taskflowTables.taskActivity:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.taskActivity, rowId), projectId)
            break
          case taskflowTables.taskSessions:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.taskSessions, rowId), projectId)
            break
          case taskflowTables.agents:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.agents, rowId), projectId)
            break
          case taskflowTables.agentCredentials:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.agentCredentials, rowId), projectId)
            break
          case taskflowTables.agentSessions:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.agentSessions, rowId), projectId)
            break
          case taskflowTables.terminalFrames:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.terminalFrames, rowId), projectId)
            break
          case taskflowTables.channelReadCursors:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.channelReadCursors, rowId), projectId)
            break
          case taskflowTables.taskReviews:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.taskReviews, rowId), projectId)
            break
          // Chat. Id-only on the wire because these events fan out to the whole
          // project room; REST re-checks the channel roster and denies rows the
          // caller cannot read.
          case taskflowTables.agentMessages:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.agentMessages, rowId), projectId)
            break
          case taskflowTables.messageAttachments:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.messageAttachments, rowId), projectId)
            break
          case taskflowTables.agentChannels:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.agentChannels, rowId), projectId)
            break
          case taskflowTables.agentChannelMembers:
            applyRealtimeRow(event, await taskflowApi.get(taskflowTables.agentChannelMembers, rowId), projectId)
            break
        }
      } catch (error) {
        // A denial means the row belongs to a channel this user is not on. That
        // is the scope working; it fires for every message anyone else sends and
        // must not surface as a sync error.
        if (isScopeDenial(error)) return
        setLiveSyncError(error instanceof Error ? error.message : "Could not apply realtime update.")
      }
    },
    [applyRealtimeDeletion, applyRealtimeRow]
  )

  useEffect(() => {
    if (!isAppRoute || !hasAuthSession) return

    let active = true
    fetchCurrentUser().then((user) => {
      if (!active) return
      setCurrentUser(user)
      setAuthGateStatus(user ? "authenticated" : "anonymous")
    })

    return () => {
      active = false
    }
  }, [hasAuthSession, isAppRoute, location.pathname])

  useEffect(() => {
    if (authGateStatus !== "authenticated") return
    void loadLiveWorkspace(activeProjectId)
  }, [activeProjectId, authGateStatus, loadLiveWorkspace])

  // #49: ask the SERVER what a TASK#<n> chip points at — and ask it for THAT
  // TASK, nothing else.
  //
  // This used to refresh the whole workspace afterwards, on the theory that the
  // board might not hold the row. Opening one task then cost ~35 requests: every
  // project, every member, all 132 kB of tasks, every channel, message,
  // terminal frame and activity row — and the page visibly lurched as all of it
  // landed. The sheet renders from the row this returns, so none of that was
  // ever needed to open the task.
  useEffect(() => {
    if (!openTaskId || authGateStatus !== "authenticated") return
    let cancelled = false
    void fetchTaskRef(openTaskId, activeProjectId).then((answer) => {
      if (!cancelled) setTaskRefAnswer({ id: openTaskId, answer })
    })
    return () => {
      cancelled = true
    }
  }, [openTaskId, activeProjectId, authGateStatus])

  useEffect(() => {
    if (authGateStatus !== "authenticated") return
    let active = true
    fetchMyInvites()
      .then((rows) => {
        if (active) setMyInviteCount(rows.length)
      })
      .catch(() => {
        // Transient failure — keep showing the last known count.
      })
    return () => {
      active = false
    }
  }, [authGateStatus])

  // ONE SSE connection for every group this view needs, reconnecting itself with
  // exponential backoff. On a re-open we refetch the workspace: events that fired
  // while we were disconnected are gone for good, so reconnecting without a
  // catch-up would leave the board silently stale — which is exactly how a
  // backend restart used to make new tasks stop appearing until a reload.
  useEffect(() => {
    if (authGateStatus !== "authenticated") return

    const projectId = activeProjectId ? liveId(activeProjectId) : null
    return openTaskflowRealtimeStream({
      groups: taskflowRealtimeGroups(projectId),
      onEvent: (event) => {
        void fetchAndApplyRealtimeEvent(event, projectId)
      },
      // loadLiveWorkspace refetches the project summary AND the active
      // workspace, which is exactly the catch-up a reconnect needs.
      onReconnect: () => {
        void loadLiveWorkspace(activeProjectId)
      },
      onStatusChange: setRealtimeStatus,
    })
  }, [activeProjectId, authGateStatus, fetchAndApplyRealtimeEvent, loadLiveWorkspace])

  // Stable opener for TASK#<n> chips (see TaskChipContext). MUST live above the
  // early returns below — it is a hook, so it has to run on every render in the
  // same order. Only calls stable state setters, so the context value never
  // churns and doesn't re-render every MarkdownRenderer.
  const openTaskById = useCallback((taskId: number) => {
    setSelectedTaskId(String(taskId))
    setOpenTaskId(String(taskId))
  }, [])

  // #55: the docked chat's own state. It is deliberately NOT route-driven — the
  // dock exists so you can message someone without navigating away, so putting
  // it in the URL would defeat the point. Persisted so it survives a reload.
  const [dockOpen, setDockOpen] = useState(() => loadDockOpen())
  const [dockChatId, setDockChatId] = useState<string | null>(() => loadDockChatId())
  useEffect(() => saveDockState(dockOpen, dockChatId), [dockOpen, dockChatId])
  const openDockChat = useCallback((chatId: string) => {
    setDockChatId(chatId)
    setDockOpen(true)
  }, [])

  /// Open the DM with an agent, creating it if this is the first message.
  ///
  /// Direct rooms are membership-driven and never invented as placeholders, so
  /// an agent you have not DM'd before simply has no chat to open. The server
  /// dedups DMs by roster, so creating one you already have just returns it —
  /// which is why this can create unconditionally when the lookup misses.
  const openAgentChat = useCallback(
    (agentId: number) => {
      const workspace = activeLiveWorkspace
      if (!workspace) return
      // Reuse the same mapper the chat list is built from, rather than
      // re-deriving "which room is the DM with this agent" a second way.
      const existing = mapLiveDirectChats(workspace, currentUser, Date.now()).find(
        (chat) => chat.liveAgentId === agentId
      )
      if (existing) {
        openDockChat(existing.id)
        return
      }
      const projectId = activeLiveProjectId
      if (!projectId) return
      void createTaskflowChannel({
        project: projectId,
        kind: "direct",
        title: workspace.agents.find((agent) => agent.id === agentId)?.display_name ?? "Direct message",
        members: [{ kind: "agent", agent: agentId }],
      })
        .then((channel) => {
          applyWorkspaceUpdate(projectId, (current) => ({
            ...current,
            agentChannels: upsertById(current.agentChannels, channel),
            agentChannelMembers: channel.members.reduce(
              (rows, member) => upsertById(rows, member),
              current.agentChannelMembers
            ),
          }))
          openDockChat(`live:direct:${channel.id}`)
        })
        .catch(() => {
          // Opening a chat is not worth an error dialog over; the dock simply
          // does not open and the agent stays reachable from the Agents page.
        })
    },
    [activeLiveWorkspace, currentUser, activeLiveProjectId, applyWorkspaceUpdate, openDockChat]
  )
  const chatDockApi = useMemo(
    () => ({ openChat: openDockChat, openAgentChat }),
    [openDockChat, openAgentChat]
  )

  const loadMoreBoardColumn = useCallback(
    async (columnId: BoardColumnId) => {
      const projectId = activeLiveProjectId
      if (!projectId) return
      const nextPage = (boardColumnPages.current[columnId] ?? 1) + 1
      // Claimed before the request so a second sentinel hit cannot fetch the
      // same page twice; released on failure so it can be retried.
      boardColumnPages.current[columnId] = nextPage
      try {
        const { rows, count } = await fetchBoardColumn(projectId, columnId, nextPage)
        applyWorkspaceUpdate(projectId, (workspace) => ({
          ...workspace,
          tasks: rows.reduce((current, row) => upsertById(current, row), workspace.tasks),
          // Refresh the total from the same response the rows came from, so the
          // sentinel cannot chase a count that has since changed.
          taskCounts: { ...workspace.taskCounts, [columnId]: count },
        }))
        // The board renders from `tasks`, NOT from liveWorkspace.tasks. Merging
        // only into the workspace left the fetched rows invisible, so the
        // column's loaded count never grew and the sentinel re-fired forever —
        // a loader that spun without ever loading. Both stores must be fed.
        setTasks((current) => {
          const mapped = mapLiveTasks(
            rows,
            activeLiveWorkspace?.members ?? [],
            activeLiveWorkspace?.agents ?? []
          )
          const known = new Set(current.map((task) => task.id))
          const added = mapped.filter((task) => !known.has(task.id))
          return added.length ? [...current, ...added] : current
        })
      } catch {
        boardColumnPages.current[columnId] = nextPage - 1
      }
    },
    [activeLiveProjectId, applyWorkspaceUpdate, activeLiveWorkspace?.members, activeLiveWorkspace?.agents]
  )
  /// Load one page, REPLACING the held rows. Changing the tool resets to page 1
  /// because page 3 of an unfiltered feed is not page 3 of a filtered one.
  const loadActivityPage = useCallback(
    async (page: number, tool: string) => {
      const projectId = activeLiveProjectId
      if (!projectId) return
      setLoadingOlder(true)
      try {
        const { rows, count, totalPages } = await fetchWorkspaceActivity(
          projectId,
          page,
          tool === ALL_TOOLS ? undefined : tool
        )
        setActivityTotal(count)
        setActivityTotalPages(totalPages)
        setActivityPage(page)
        setActivityTool(tool)
        applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskActivity: rows }))
      } catch {
        // Leave the current page in place; the controls stay live for a retry.
      } finally {
        setLoadingOlder(false)
      }
    },
    [activeLiveProjectId, applyWorkspaceUpdate]
  )

  // #56: the heavy slices load only for the surfaces that render them. The board
  // used to download every message, prompt, terminal frame and 1000 activity
  // rows — ~1.2 MB of the 1.31 MB workspace — and display none of it.
  //
  // The flags are set BEFORE the request, not after: `activeLiveWorkspace` is in
  // the dependency list, and applying the slice changes it, so a flag set on
  // success would let the effect re-fire against its own result. On failure they
  // reset, so a transient error still retries when the surface is next visited.
  // A ref, not state: these flags gate a fetch, they do not belong in a render.
  // Holding them in state also meant calling setState synchronously inside the
  // effect, which is the cascading-render pattern the lint rule objects to.
  const loadedSlices = useRef<{ project: number | null; epoch: number; chat: boolean; activity: boolean }>({
    project: null,
    epoch: -1,
    chat: false,
    activity: false,
  })

  // Bumped when a slice fetch fails, purely to re-run the effect below. Clearing
  // the ref flag on failure was not enough: none of the effect's other deps
  // change when a request fails, so nothing re-triggered it and the retry never
  // happened — the surface stayed empty until a full page reload rebuilt all the
  // state. Bounded, so a persistently failing backend cannot spin.
  const [sliceRetry, setSliceRetry] = useState(0)
  const MAX_SLICE_RETRIES = 5
  const retrySlice = useCallback(() => {
    setSliceRetry((current) => (current < MAX_SLICE_RETRIES ? current + 1 : current))
  }, [])

  // #56: the chat slice is needed when the dock is open, or when a chat surface
  // is actually mounted. The route-string check stays as a fast path, but the
  // MOUNT signal is the reliable one — matching on pathname assumes the route
  // table and this string never drift, and a miss leaves the page permanently
  // empty with no clue why.
  const [chatSurfaceMounted, setChatSurfaceMounted] = useState(false)
  const chatNeeded =
    dockOpen || chatSurfaceMounted || location.pathname.startsWith("/dashboard/agents")
  // The task sheet renders one task's activity; the feed renders the project's.
  const activityNeeded = openTaskId !== null || location.pathname.startsWith("/dashboard/activity")

  useEffect(() => {
    if (!activeLiveProjectId || !activeLiveWorkspace) return
    const projectId = activeLiveProjectId
    const slices = loadedSlices.current
    // Switching projects invalidates the slices — and so does a core reload,
    // which hands back empty chat/activity arrays and drops whatever was merged.
    if (slices.project !== projectId || slices.epoch !== workspaceEpoch) {
      slices.project = projectId
      slices.epoch = workspaceEpoch
      slices.chat = false
      slices.activity = false
    }
    // Marked BEFORE the request: applying a slice changes activeLiveWorkspace,
    // which re-runs this effect, so a flag set on success would let it re-fire
    // against its own result. Cleared on failure so the next visit retries.
    if (chatNeeded && !slices.chat) {
      slices.chat = true
      void fetchWorkspaceChat(projectId)
        .then((slice) => applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, ...slice })))
        .catch(() => {
          slices.chat = false
          retrySlice()
        })
    }
    if (activityNeeded && !slices.activity) {
      slices.activity = true
      void fetchActivityActions(projectId)
        .then(setActivityToolOptions)
        .catch(() => setActivityToolOptions([]))
      void fetchWorkspaceActivity(projectId)
        .then(({ rows, count, totalPages }) => {
          setActivityTotal(count)
          setActivityTotalPages(totalPages)
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskActivity: rows }))
        })
        .catch(() => {
          slices.activity = false
          retrySlice()
        })
    }
  }, [chatNeeded, activityNeeded, activeLiveProjectId, activeLiveWorkspace, applyWorkspaceUpdate, sliceRetry, retrySlice, workspaceEpoch])

  if (publicPath === "/") {
    return <LandingPage />
  }

  if (authMode) {
    return <AuthPage mode={authMode} />
  }

  if (legacyDashboardRoutes[publicPath]) {
    return <Navigate to={legacyDashboardRoutes[publicPath]} replace />
  }

  if (!isAppRoute) {
    return <Navigate to="/" replace />
  }

  if (!hasAuthSession) {
    const next = `${location.pathname}${location.search}`
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }

  if (authGateStatus !== "authenticated") {
    return <AuthGateScreen />
  }

  function handleProjectChange(projectId: string) {
    const firstTask = tasks.find((task) => task.projectId === projectId)
    setActiveProjectId(projectId)
    if (firstTask) {
      setSelectedTaskId(firstTask.id)
    }
    setOpenTaskId(null)
  }

  // Returns a promise that resolves once the project is created and applied to
  // local state, and REJECTS (with a ProjectFormError carrying field errors) on
  // failure so the dialog can show errors inline and stay open. It does NOT
  // close the dialog — the dialog closes itself on success. The creator is now
  // an active OWNER member, so the follow-up loadLiveWorkspace re-adds (not
  // drops) the project when activeProjectId changes.
  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const name = String(formData.get("name") ?? "").trim()
    if (!name) return

    const slug = String(formData.get("slug") ?? "").trim() || slugifyProjectName(name)
    const description = String(formData.get("description_markdown") ?? "").trim() || "### Project\nDescribe the project mission, constraints, and operating rhythm."
    const repositoryUrl = String(formData.get("repository_url") ?? "").trim()
    const apiBase = String(formData.get("default_api_base_url") ?? "").trim()

    const project = await createTaskflowProject({
      name,
      slug,
      description_markdown: description,
      repository_url: repositoryUrl || null,
      default_api_base_url: apiBase || "/api",
    })

    const mappedProject = mapLiveProjectRow(project, undefined, workspaceProjects.length)
    const projectId = String(project.id)
    setLiveSyncError(null)
    setWorkspaceProjects((current) => [...current, mappedProject])
    setActiveProjectId(projectId)
    setSelectedTaskId((current) => tasks.find((task) => task.projectId === projectId)?.id ?? current)
    setLiveWorkspace({
      project,
      // A brand-new project has no tasks yet, so every column total is zero.
      taskCounts: { not_started: 0, in_progress: 0, review: 0, blocked: 0, done: 0 },
      members: [],
      invites: [],
      apiEndpoints: [],
      tasks: [],
      taskRelations: [],
      taskActivity: [],
      taskSessions: [],
      taskAttachments: [],
      agents: [],
      agentCredentials: [],
      agentSessions: [],
      agentChannels: [],
      agentChannelMembers: [],
      agentMessages: [],
      messageAttachments: [],
      terminalFrames: [],
      channelReadCursors: [],
      taskReviews: [],
      agentPrompts: [],
    })
  }

  function handleUpdateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeProject) return
    const projectId = liveId(activeProject.id)
    if (!projectId) {
      setLiveSyncError("This project is seeded demo data. Create or select a live project before saving changes.")
      return
    }

    const formData = new FormData(event.currentTarget)
    const updates: TaskflowProjectUpdate = {}

    if (formData.has("name")) {
      const name = String(formData.get("name") ?? "").trim()
      if (name) updates.name = name
    }

    if (formData.has("slug")) {
      const slug = String(formData.get("slug") ?? "").trim()
      if (slug) updates.slug = slugifyProjectName(slug)
    }

    if (formData.has("description_markdown")) {
      updates.description_markdown = String(formData.get("description_markdown") ?? "").trim()
    }

    if (formData.has("repository_url")) {
      const repositoryUrl = String(formData.get("repository_url") ?? "").trim()
      updates.repository_url = repositoryUrl || null
    }

    if (formData.has("default_api_base_url")) {
      const apiBase = String(formData.get("default_api_base_url") ?? "").trim()
      updates.default_api_base_url = apiBase || null
    }

    if (formData.has("status")) {
      const status = String(formData.get("status") ?? "active")
      if (status === "active" || status === "paused" || status === "archived") {
        updates.status = status
      }
    }

    void updateTaskflowProject(projectId, updates)
      .then((project) => {
        setDialogMode(null)
        setLiveSyncError(null)
        setWorkspaceProjects((current) => {
          const index = current.findIndex((item) => item.id === String(project.id))
          const mapped = mapLiveProjectRow(project, index >= 0 ? current[index] : undefined, index >= 0 ? index : current.length)
          return index >= 0 ? [...current.slice(0, index), mapped, ...current.slice(index + 1)] : [...current, mapped]
        })
        applyWorkspaceUpdate(project.id, (workspace) => ({ ...workspace, project }))
      })
      .catch((error) => {
        setLiveSyncError(error instanceof Error ? error.message : "Could not update the project.")
      })
  }

  // Async + throwing so the dialog can surface the error inline and stay open;
  // the dialog closes itself on success.
  async function handleCreateInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeProject) return
    const projectId = liveId(activeProject.id)
    if (!projectId) {
      throw new Error("Select a live project before sending invites.")
    }

    const formData = new FormData(event.currentTarget)
    const recipient = String(formData.get("recipient") ?? "").trim()
    if (!recipient) return

    const inviteType = String(formData.get("type") ?? "user")
    const role = String(formData.get("role") ?? "developer")
    const email = inviteType === "agent" ? normalizeAgentInviteEmail(recipient) : recipient.toLowerCase()
    const displayName =
      inviteType === "agent"
        ? recipient
        : String(formData.get("display_name") ?? "").trim() || recipient.split("@")[0] || recipient

    const invite = await createTaskflowProjectInvite(projectId, {
      email,
      display_name: displayName,
      role: toLiveInviteRole(role),
    })
    setLiveSyncError(null)
    applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, invites: upsertById(workspace.invites, invite) }))
  }

  function handleArchiveProject(projectId: string) {
    const liveProjectId = liveId(projectId)
    if (!liveProjectId) {
      setLiveSyncError("This project is seeded demo data. Live archive actions require a project from /api/taskflow_project/.")
      return
    }

    void archiveTaskflowProject(liveProjectId)
      .then((project) => {
        setLiveSyncError(null)
        setWorkspaceProjects((current) => {
          const index = current.findIndex((item) => item.id === String(project.id))
          const mapped = mapLiveProjectRow(project, index >= 0 ? current[index] : undefined, index >= 0 ? index : current.length)
          return index >= 0 ? [...current.slice(0, index), mapped, ...current.slice(index + 1)] : [...current, mapped]
        })
        applyWorkspaceUpdate(project.id, (workspace) => ({ ...workspace, project }))
      })
      .catch((error) => {
        setLiveSyncError(error instanceof Error ? error.message : "Could not archive the project.")
      })
  }

  function placeTask(taskId: string, target: DropTarget) {
    if (!activeProject) return
    const nextTasks = reorderTasks(tasks, taskId, target)
    const nextProjectTasks = nextTasks.filter((task) => task.projectId === activeProject.id)
    const nextSortOrder = Math.max(0, nextProjectTasks.findIndex((task) => task.id === taskId))

    setTasks(nextTasks)
    setSelectedTaskId(taskId)

    const taskIdNumber = liveId(taskId)
    if (usesLiveApi && taskIdNumber) {
      void updateTaskflowTask(taskIdNumber, {
        status: toLiveStatus(target.columnId),
        sort_order: nextSortOrder,
      }).catch((error) => {
        setLiveSyncError(error instanceof Error ? error.message : "Could not persist the task move.")
      })
    }
  }

  function moveTask(taskId: string, status: ColumnId) {
    placeTask(taskId, { columnId: status, taskId: null, position: "after" })
  }

  function openTaskDetails(taskId: string) {
    setSelectedTaskId(taskId)
    setOpenTaskId(taskId)
    // The backend session timer creates/closes sessions server-side; an open tab
    // that missed the realtime event would show a stale (empty) session list.
    // Fetch this task's sessions on open so the sheet always reflects reality.
    void loadTaskSessions(taskId)
  }

  /// Refetch one task's work sessions and merge them into the live workspace, so
  /// the detail sheet shows the current sessions even if the realtime event for a
  /// timer-created session never landed.
  async function loadTaskSessions(taskId: string) {
    if (!usesLiveApi || !activeProject) return
    const id = liveId(taskId)
    const pid = liveId(activeProject.id)
    if (!id || !pid) return
    try {
      const page = await taskflowApi
        .from(taskflowTables.taskSessions)
        .filter({ task: id })
        .orderBy("-started_at", "-id")
        .list()
      applyWorkspaceUpdate(pid, (workspace) => ({
        ...workspace,
        taskSessions: page.results.reduce((rows, session) => upsertById(rows, session), workspace.taskSessions),
      }))
    } catch {
      // Best-effort: the sheet still renders whatever sessions are already loaded.
    }
  }

  async function handleUploadTaskAttachment(taskId: string, files: File[]) {
    const id = liveId(taskId)
    if (!id || !files.length) return
    try {
      const created = await uploadTaskAttachment(id, files)
      const pid = activeProject ? liveId(activeProject.id) : null
      if (pid) {
        applyWorkspaceUpdate(pid, (workspace) => ({
          ...workspace,
          taskAttachments: [...workspace.taskAttachments, ...created],
        }))
      }
      setLiveSyncError(null)
    } catch (error) {
      setLiveSyncError(error instanceof Error ? error.message : "Could not upload the attachment.")
    }
  }

  function handleDeleteTask(taskId: string) {
    // Optimistic: drop it and close the sheet immediately. A live delete that
    // fails restores the row so a rejected delete never silently loses it.
    const removed = tasks.find((task) => task.id === taskId)
    setTasks((current) => current.filter((task) => task.id !== taskId))
    setOpenTaskId(null)
    setSelectedTaskId(null)
    // Only live (numeric-id) tasks hit the API; a local/mock task just drops.
    if (usesLiveApi && /^\d+$/.test(taskId)) {
      void taskflowApi.delete(taskflowTables.tasks, Number(taskId)).catch((error) => {
        if (removed) setTasks((current) => [removed, ...current])
        setLiveSyncError(error instanceof Error ? error.message : "Could not delete the task.")
      })
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>, fallbackColumn: ColumnId) {
    event.preventDefault()
    if (draggedTaskId) {
      placeTask(draggedTaskId, dropTarget ?? { columnId: fallbackColumn, taskId: null, position: "after" })
      setDraggedTaskId(null)
    }
    setDropTarget(null)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>, status: ColumnId) {
    const nextTarget = event.relatedTarget as Node | null
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
      setDropTarget((current) => (current?.columnId === status ? null : current))
    }
  }

  function handleCreateTask(event: FormEvent<HTMLFormElement>, files: File[] = []) {
    event.preventDefault()
    if (!activeProject) return
    const formData = new FormData(event.currentTarget)
    const title = String(formData.get("title") ?? "").trim()
    if (!title) return

    const status = String(formData.get("status") ?? "not_started") as ColumnId
    const priority = String(formData.get("priority") ?? "high") as Priority
    // Owner/operator/due come from controlled state, not FormData.
    const owner = newTaskOwner?.label || "Unassigned"
    const [opKind, opId] = newTaskOperator.split(":")
    const operatorUserId = opKind === "user" ? Number(opId) : null
    const operatorAgentId = opKind === "agent" ? Number(opId) : null
    const members = liveWorkspaceRef.current?.members ?? []
    const agents = liveWorkspaceRef.current?.agents ?? []
    const operatorName =
      operatorUserId != null
        ? members.find((m) => m.user === operatorUserId)?.display_name ?? `User #${operatorUserId}`
        : operatorAgentId != null
          ? agents.find((a) => a.id === operatorAgentId)?.display_name ?? `Agent #${operatorAgentId}`
          : "human"
    const dueIso = datetimeLocalInputToIso(newTaskDue)
    const due = newTaskDue ? formatLiveDate(dueIso, "Unscheduled") : "Unscheduled"
    const estimate = String(formData.get("estimate") ?? "").trim()
    const description = String(formData.get("description") ?? "").trim()
    const notes = String(formData.get("notes") ?? "").trim()
    const review = String(formData.get("review") ?? "No review gate defined.").trim() || "No review gate defined."
    const tags = String(formData.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)

    // Edit mode reuses this form: same fields, same controlled owner/operator/due
    // state. Patch the existing task instead of creating a new one.
    if (editTaskId) {
      const ownerInitials =
        owner
          .split(" ")
          .map((part) => part[0])
          .join("")
          .slice(0, 2)
          .toUpperCase() || "UN"
      // Optimistically patch the edited fields; a live save reconciles below.
      setTasks((currentTasks) =>
        currentTasks.map((task) =>
          task.id === editTaskId
            ? {
                ...task,
                title,
                description,
                notes,
                status,
                priority,
                owner,
                ownerInitials,
                operator: operatorAgentId != null ? "agent" : newTaskOwner ? "human" : "pair",
                operatorName,
                estimate: formatEstimateMinutes(parseEstimateMinutes(estimate)),
                due,
                review,
                updated: "Just now",
              }
            : task
        )
      )
      setSelectedTaskId(editTaskId)
      setOpenTaskId(editTaskId)
      setDialogMode(null)
      setNewTaskOwner(null)
      setNewTaskOperator("")
      setNewTaskDue("")
      const savedEditId = editTaskId
      setEditTaskId(null)

      if (usesLiveApi && /^\d+$/.test(savedEditId)) {
        void updateTaskflowTask(Number(savedEditId), {
          title,
          description_markdown: description || `### Outcome\n${review}`,
          notes_markdown: notes || null,
          status: toLiveStatus(status),
          priority: toLivePriority(priority),
          assigned_user: newTaskOwner?.id ?? null,
          assignee_label: owner,
          operator_user: operatorUserId,
          operator_agent_id: operatorAgentId,
          due_at: dueIso,
          estimate_minutes: parseEstimateMinutes(estimate),
          review_gate: review || null,
        })
          .then((updatedTask) => {
            const [mappedTask] = mapLiveTasks([updatedTask], members, agents)
            setTasks((currentTasks) =>
              currentTasks.map((task) => (task.id === mappedTask.id ? mappedTask : task))
            )
            // Refresh the RAW row store immediately. The realtime task event is
            // id-only and lags behind a refetch, so a quick second Edit would
            // otherwise pre-fill from the stale pre-edit row.
            const pid = liveId(activeProject.id)
            if (pid != null) {
              applyWorkspaceUpdate(pid, (workspace) => ({
                ...workspace,
                tasks: upsertById(workspace.tasks, updatedTask),
              }))
            }
            if (files.length) void handleUploadTaskAttachment(String(updatedTask.id), files)
          })
          .catch((error) => {
            setLiveSyncError(error instanceof Error ? error.message : "Could not save the task changes.")
          })
      }
      return
    }

    const newTask: Task = {
      id: `task-${Math.floor(Date.now() / 1000)}`,
      projectId: activeProject.id,
      title,
      description,
      notes,
      status,
      priority,
      owner,
      ownerInitials: owner
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase() || "UN",
      operator: operatorAgentId != null ? "agent" : newTaskOwner ? "human" : "pair",
      operatorName,
      createdBy:
        members.find((m) => m.user === currentUser?.id)?.display_name ??
        currentUser?.username ??
        currentUser?.email ??
        "You",
      estimate: formatEstimateMinutes(parseEstimateMinutes(estimate)),
      updated: "Just now",
      due,
      tags: tags.length ? tags : ["planning"],
      blockers: [],
      review,
      history: ["Task created from the project workspace form."],
    }

    setTasks((currentTasks) => [newTask, ...currentTasks])
    setSelectedTaskId(newTask.id)
    setOpenTaskId(newTask.id)
    setDialogMode(null)
    setNewTaskOwner(null)
    setNewTaskOperator("")
    setNewTaskDue("")

    const projectId = liveId(activeProject.id)
    if (usesLiveApi && projectId) {
      void createTaskflowTask({
        project: projectId,
        title,
        description_markdown: description || `### Outcome\n${review}`,
        notes_markdown: notes || null,
        status: toLiveStatus(status),
        priority: toLivePriority(priority),
        sort_order: projectTasks.length,
        assigned_user: newTaskOwner?.id ?? null,
        assignee_label: owner,
        operator_user: operatorUserId,
        operator_agent_id: operatorAgentId,
        due_at: dueIso,
        estimate_minutes: parseEstimateMinutes(estimate),
        review_gate: review || null,
        created_by: currentUser?.id ?? null,
      })
        .then((createdTask) => {
          const [mappedTask] = mapLiveTasks(
            [createdTask],
            liveWorkspaceRef.current?.members ?? [],
            liveWorkspaceRef.current?.agents ?? []
          )
          setTasks((currentTasks) => [mappedTask, ...currentTasks.filter((task) => task.id !== newTask.id)])
          setSelectedTaskId(mappedTask.id)
          setOpenTaskId(mappedTask.id)
          // Add the new raw row so a follow-up Edit pre-fills correctly without
          // waiting for the realtime create event to round-trip.
          if (projectId != null) {
            applyWorkspaceUpdate(projectId, (workspace) => ({
              ...workspace,
              tasks: upsertById(workspace.tasks, createdTask),
            }))
          }
          if (files.length) void handleUploadTaskAttachment(String(createdTask.id), files)
        })
        .catch((error) => {
          setLiveSyncError(error instanceof Error ? error.message : "Could not create the live task.")
        })
    }
  }

  function applyLiveTaskRow(taskRow: TaskflowWorkspace["tasks"][number]) {
    const [mappedTask] = mapLiveTasks(
      [taskRow],
      liveWorkspaceRef.current?.members ?? [],
      liveWorkspaceRef.current?.agents ?? []
    )
    applyWorkspaceUpdate(taskRow.project, (workspace) => ({ ...workspace, tasks: upsertById(workspace.tasks, taskRow) }))
    setTasks((current) => {
      const index = current.findIndex((task) => task.id === mappedTask.id)
      return index >= 0
        ? [...current.slice(0, index), mappedTask, ...current.slice(index + 1)]
        : [...current, mappedTask]
    })
  }

  function applyLiveTaskSessionRow(session: TaskflowWorkspace["taskSessions"][number]) {
    applyWorkspaceUpdate(session.project, (workspace) => ({
      ...workspace,
      taskSessions: upsertById(workspace.taskSessions, session),
    }))
  }

  function applyLiveTaskActivityRow(activity: TaskflowWorkspace["taskActivity"][number]) {
    applyWorkspaceUpdate(activity.project, (workspace) => ({
      ...workspace,
      taskActivity: upsertById(workspace.taskActivity, activity),
    }))
  }

  function taskSessionActorLabel() {
    return currentUser?.username ?? currentUser?.email ?? "You"
  }

  async function recordTaskSessionActivity(projectId: number, taskId: number, action: string, body: string) {
    const activity = await createTaskflowTaskActivity({
      project: projectId,
      task: taskId,
      actor_kind: "user",
      actor_user: currentUser?.id ?? null,
      actor_label: taskSessionActorLabel(),
      action,
      body_markdown: body,
    })
    applyLiveTaskActivityRow(activity)
  }

  async function closeRunningTaskSessions(
    workspace: TaskflowWorkspace,
    taskId: number,
    state: "paused" | "stopped" | "failed",
    summary: string,
    endedAt = new Date()
  ) {
    const endedAtIso = endedAt.toISOString()
    const runningSessions = workspace.taskSessions.filter(
      (session) => session.task === taskId && session.state === "running" && !session.ended_at
    )

    if (!runningSessions.length) return []

    const closedSessions = await Promise.all(
      runningSessions.map((session) =>
        updateTaskflowTaskSession(session.id, {
          state,
          ended_at: endedAtIso,
          duration_seconds: sessionDurationSeconds(session, endedAt),
          summary_markdown: summary,
        })
      )
    )

    closedSessions.forEach(applyLiveTaskSessionRow)
    return closedSessions
  }

  function handleStartTaskSession(task: Task) {
    const projectId = liveId(task.projectId)
    const taskId = liveId(task.id)
    if (!projectId || !taskId || !activeLiveWorkspace) {
      setLiveSyncError("Select a live task before starting a session.")
      return
    }

    if (getRunningLiveTaskSession(task, activeLiveWorkspace)) {
      setLiveSyncError("A session is already running for this task.")
      return
    }

    const startedAt = new Date().toISOString()

    void createTaskflowTaskSession({
      project: projectId,
      task: taskId,
      state: "running",
      actor_kind: "user",
      actor_user: currentUser?.id ?? null,
      actor_label: taskSessionActorLabel(),
      started_at: startedAt,
      summary_markdown: `Started focused work on **${task.title}**.`,
    })
      .then(async (session) => {
        applyLiveTaskSessionRow(session)
        const updatedTask = await updateTaskflowTask(taskId, { status: "in_progress" })
        applyLiveTaskRow(updatedTask)
        await recordTaskSessionActivity(projectId, taskId, "timer_started", `Started a focused session on **${task.title}**.`)
        setLiveSyncError(null)
      })
      .catch((error) => {
        setLiveSyncError(error instanceof Error ? error.message : "Could not start the task session.")
      })
  }

  function handlePauseTaskSession(task: Task) {
    const projectId = liveId(task.projectId)
    const taskId = liveId(task.id)
    if (!projectId || !taskId || !activeLiveWorkspace) {
      setLiveSyncError("Select a live task before pausing a session.")
      return
    }

    void closeRunningTaskSessions(
      activeLiveWorkspace,
      taskId,
      "paused",
      `Paused focused work on **${task.title}**.`
    )
      .then(async (closedSessions) => {
        const updatedTask = await updateTaskflowTask(taskId, { status: "paused" })
        applyLiveTaskRow(updatedTask)
        await recordTaskSessionActivity(
          projectId,
          taskId,
          "timer_paused",
          closedSessions.length
            ? `Paused **${task.title}** after ${formatDuration(closedSessions[0].duration_seconds)}.`
            : `Marked **${task.title}** paused without a running session.`
        )
        setLiveSyncError(null)
      })
      .catch((error) => {
        setLiveSyncError(error instanceof Error ? error.message : "Could not pause the task session.")
      })
  }

  function handleStopTaskSession(task: Task, finalStatus: Extract<TaskflowTaskStatus, "done" | "partial_done" | "blocked">) {
    const projectId = liveId(task.projectId)
    const taskId = liveId(task.id)
    if (!projectId || !taskId || !activeLiveWorkspace) {
      setLiveSyncError("Select a live task before stopping a session.")
      return
    }

    const statusLabel =
      finalStatus === "done"
        ? "done"
        : finalStatus === "partial_done"
          ? "ready for review"
          : "blocked"

    void closeRunningTaskSessions(
      activeLiveWorkspace,
      taskId,
      "stopped",
      `Stopped focused work on **${task.title}** and marked it ${statusLabel}.`
    )
      .then(async (closedSessions) => {
        const updatedTask = await updateTaskflowTask(taskId, { status: finalStatus })
        applyLiveTaskRow(updatedTask)
        await recordTaskSessionActivity(
          projectId,
          taskId,
          "timer_stopped",
          closedSessions.length
            ? `Stopped **${task.title}** after ${formatDuration(closedSessions[0].duration_seconds)} and marked it ${statusLabel}.`
            : `Marked **${task.title}** ${statusLabel} without a running session.`
        )
        setLiveSyncError(null)
      })
      .catch((error) => {
        setLiveSyncError(error instanceof Error ? error.message : "Could not stop the task session.")
      })
  }

  function handleReviewDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!reviewTask) return
    const formData = new FormData(event.currentTarget)
    const decision = String(formData.get("decision") ?? "approve")
    const note = String(formData.get("note") ?? "").trim()
    const next = decision === "approve" ? "done" : decision === "changes" ? "in_progress" : "blocked"

    setTasks((currentTasks) =>
      currentTasks.map((task) =>
        task.id === reviewTask.id
          ? {
              ...task,
              status: next,
              updated: "Just now",
              history: [
                `Human review ${decision === "approve" ? "approved" : decision === "changes" ? "requested changes" : "blocked"}${note ? `: ${note}` : "."}`,
                ...task.history,
              ],
            }
          : task
      )
    )
    const reviewTaskIdNumber = liveId(reviewTask.id)
    if (usesLiveApi && reviewTaskIdNumber) {
      const onError = (error: unknown) =>
        setLiveSyncError(error instanceof Error ? error.message : "Could not persist the review decision.")
      // approve/changes are real review DECISIONS: the review endpoint records the
      // review row, transitions the task, and posts the report-back to the agent.
      // "blocked" is a plain status change, not a review — keep the direct update.
      if (decision === "approve" || decision === "changes") {
        void submitTaskReview(
          reviewTaskIdNumber,
          decision === "approve" ? "approved" : "changes_requested",
          note || undefined
        ).catch(onError)
      } else {
        void updateTaskflowTask(reviewTaskIdNumber, { status: toLiveStatus(next) }).catch(onError)
      }
    }
    setDialogMode(null)
    setReviewTaskId(null)
  }

  async function handleLogout() {
    await logoutUser()
    setCurrentUser(null)
    setAuthGateStatus("anonymous")
    navigate("/login", { replace: true })
  }

  return (
    <TaskChipContext.Provider value={openTaskById}>
     <GithubRepoContext.Provider value={activeLiveWorkspace?.project.github_repo ?? null}>
     <ChatDockContext.Provider value={chatDockApi}>
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar
        projects={sidebarProjects}
        activeProjectId={activeProject?.id ?? ""}
        currentUser={currentUser}
        pendingReviews={pendingReviews}
        pendingInvites={pendingInvites}
        myInviteCount={myInviteCount}
        onlineAgents={activeProject?.agentsOnline ?? 0}
        onProjectChange={handleProjectChange}
        onNewProject={() => setDialogMode("new-project")}
        onInviteProject={(projectId) => {
          handleProjectChange(projectId)
          setDialogMode("invite")
        }}
        onArchiveProject={handleArchiveProject}
        onNavigate={(to) => navigate(to)}
        onLogout={handleLogout}
      />
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 shadow-sm backdrop-blur sm:px-5">
          <SidebarTrigger />
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">
              <KanbanSquareIcon className="size-4" />
              <span>Projects</span>
              <span>/</span>
              <span className="font-medium text-foreground">{activeProject?.name ?? "No project"}</span>
            </div>
            <div className="relative ml-auto hidden w-full max-w-80 md:block">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-9 pl-8" placeholder="Search tasks, agents, activity" />
            </div>
          </div>
          {usesLiveApi ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadLiveWorkspace(activeProjectId)}
              disabled={isLiveSyncing}
              title={
                realtimeStatus === "reconnecting"
                  ? "The live feed dropped and is reconnecting. Click to refetch now."
                  : "Live realtime feed"
              }
              className={cn(realtimeStatus === "reconnecting" && "border-amber-300 text-amber-800")}
            >
              {/* A truthful status dot: green when live, amber+pulse while
                  reconnecting, so a dead feed is visible instead of silently stale. */}
              <span
                className={cn(
                  "size-2 rounded-full",
                  isLiveSyncing || realtimeStatus === "connecting"
                    ? "animate-pulse bg-muted-foreground"
                    : realtimeStatus === "reconnecting"
                      ? "animate-pulse bg-amber-500"
                      : "bg-emerald-500"
                )}
              />
              {isLiveSyncing
                ? "Syncing"
                : realtimeStatus === "reconnecting"
                  ? "Reconnecting"
                  : realtimeStatus === "connecting"
                    ? "Connecting"
                    : "Live"}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => void loadLiveWorkspace(activeProjectId)} disabled={isLiveSyncing}>
              <BellIcon />
              Sync
            </Button>
          )}
          {activeProject ? <GithubHeaderButton project={activeProject} /> : null}
          {activeProject ? (
            <Button size="sm" onClick={() => { setComposeSeed(null); setDialogMode("new-task") }}>
              <PlusIcon />
              New Task
            </Button>
          ) : null}
        </header>

        <main className="h-[calc(100svh-3.5rem)] min-h-0 flex-1 overflow-y-auto bg-[linear-gradient(180deg,var(--background),var(--muted))]">
          <Routes>
            <Route path="/dashboard" element={<Navigate to="/dashboard/board" replace />} />
            <Route
              path="/dashboard/overview"
              element={
                <OverviewPage
                  projectId={activeProject ? liveId(activeProject.id) : null}
                  currentUserId={currentUser?.id ?? null}
                />
              }
            />
            <Route
              path="/dashboard/media"
              element={
                <MediaPage
                  projectId={activeProject ? liveId(activeProject.id) : null}
                  channelName={mediaChannelName}
                  onOpenTask={(taskId) => {
                    navigate("/dashboard/board")
                    setOpenTaskId(String(taskId))
                  }}
                  onOpenChannel={() => navigate("/dashboard/agents")}
                />
              }
            />
            <Route path="/dashboard/board" element={!activeProject ? (
          <NoProjectEmptyState onNewProject={() => setDialogMode("new-project")} syncing={isLiveSyncing} />
        ) : (
          <section className="flex h-full min-h-0 flex-col p-4 sm:p-5">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col space-y-5">
              <div className="shrink-0 rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="max-w-3xl">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex size-8 items-center justify-center rounded-lg text-sm font-semibold text-[oklch(0.985_0.006_230)]"
                        style={{ background: activeProject.tint }}
                      >
                        {activeProject.code}
                      </span>
                      <h1 className="text-2xl font-semibold tracking-normal text-foreground">
                        {activeProject.name}
                      </h1>
                      <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-primary/20">
                        {activeProject.health}
                      </span>
                    </div>
                    {/* Height-gated header: the description is clamped to its
                        first line and the full markdown lives behind the Project
                        Info dialog, so the top of the board keeps a fixed height. */}
                    <button
                      type="button"
                      onClick={() => setDialogMode("project-info")}
                      title="View full project description"
                      className="mt-3 flex max-w-2xl items-center gap-1.5 text-left text-sm text-muted-foreground transition hover:text-foreground"
                    >
                      <span className="truncate">{firstLine(activeProject.objective) || "No description yet."}</span>
                      <InfoIcon className="size-3.5 shrink-0 opacity-70" />
                    </button>
                    {liveSyncError ? (
                      <p className="mt-2 max-w-2xl rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        {liveSyncError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setDialogMode("invite")}>
                      <UserRoundPlusIcon />
                      Invite
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setDialogMode("edit-project")}>
                      <FileTextIcon />
                      Edit Project
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setDialogMode("api-contract")}>
                      <GitBranchIcon />
                      API Contract
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setComposeSeed(null); setDialogMode("new-task") }}>
                      <PlusIcon />
                      Create Task
                    </Button>
                    <Button size="sm" onClick={() => navigate("/dashboard/agents")}>
                      <PlayIcon />
                      Start Work
                    </Button>
                  </div>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Metric label="Open tasks" value={String(projectTasks.length - doneCount)} detail={`${activeCount} active`} />
                  <Metric label="Completion" value={`${completion}%`} detail={`${doneCount} shipped`} />
                  <Metric label="Agents online" value={String(activeProject.agentsOnline)} detail={activeProject.cadence} />
                  <Metric label="Blocked" value={String(blockedCount)} detail={blockedCount ? "needs attention" : "clear"} />
                </div>
              </div>

              <div className="flex shrink-0 items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Project Board</h2>
                  <p className="text-sm text-muted-foreground">{activeProject.apiBase}</p>
                </div>
                <div className="hidden items-center gap-2 md:flex">
                  <Button variant="outline" size="sm" onClick={() => navigate("/dashboard/activity")}>
                    <ActivityIcon />
                    Activity
                  </Button>
                </div>
              </div>

              {/* Board search + priority filter. Narrows the columns only; the
                  metrics above stay whole-project totals. */}
              <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative sm:max-w-xs sm:flex-1">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={boardSearch}
                    onChange={(event) => setBoardSearch(event.target.value)}
                    placeholder="Search #id, title, owner, tag…"
                    className="pl-8"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {[ALL_PRIORITIES, ...BOARD_PRIORITIES].map((option) => {
                    const active = boardPriority === option
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setBoardPriority(option)}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-medium capitalize ring-1 transition",
                          active
                            ? "bg-primary/10 text-primary ring-primary/30"
                            : "bg-muted/60 text-muted-foreground ring-border hover:bg-muted"
                        )}
                      >
                        {option === ALL_PRIORITIES ? "All" : option}
                      </button>
                    )
                  })}
                  {boardFilterActive ? (
                    <>
                      <span className="ml-1 text-xs text-muted-foreground">
                        {boardFilteredTasks.length} of {projectTasks.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setBoardSearch("")
                          setBoardPriority(ALL_PRIORITIES)
                        }}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        Clear
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Board columns scroll horizontally. On small screens each column
                  snaps to ~full screen width (one at a time); from lg up the five
                  columns flex to fill the row. The region is height-gated: it
                  takes the remaining vertical space (flex-1 + min-h-0) and each
                  column's card list scrolls internally, so the header above stays
                  fixed instead of the whole page scrolling. */}
              <div className="min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto pb-2 lg:snap-none">
                <div className="flex h-full gap-3">
                  {columns.map((column) => {
                    // #26: newest first (id descending) so a freshly created task
                    // — including one arriving over SSE — lands at the TOP, and
                    // pagination pulls older cards in as you scroll. Dragging a
                    // card to another column still changes its status; within a
                    // column the id-sort wins, so manual reordering is dropped.
                    const columnTasks = boardFilteredTasks
                      .filter((task) => task.status === column.id)
                      .sort((a, b) => {
                        const na = Number(a.id)
                        const nb = Number(b.id)
                        if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na
                        return b.id.localeCompare(a.id)
                      })
                    // #56: the column holds only what has been FETCHED, so there
                    // is nothing left to slice — render all of it. `count` from
                    // the paginated envelope is the true total, which is what
                    // says whether another page exists.
                    const shownColumnTasks = columnTasks
                    const columnTotal = activeLiveWorkspace?.taskCounts?.[column.id] ?? columnTasks.length
                    const ColumnIcon = column.icon
                    return (
                      <div
                        key={column.id}
                        className={cn(
                          "flex h-full max-h-full w-[97vw] shrink-0 snap-center flex-col rounded-lg border bg-card/75 transition sm:w-[20rem] lg:w-auto lg:min-w-0 lg:flex-1 lg:snap-align-none",
                          draggedTaskId && dropTarget?.columnId === column.id && "border-primary/60 bg-primary/5 ring-2 ring-primary/25"
                        )}
                        onDragEnter={() => setDropTarget({ columnId: column.id, taskId: null, position: "after" })}
                        onDragOver={(event) => {
                          event.preventDefault()
                          setDropTarget((current) =>
                            current?.columnId === column.id && current.taskId === null
                              ? current
                              : { columnId: column.id, taskId: null, position: "after" }
                          )
                        }}
                        onDragLeave={(event) => handleDragLeave(event, column.id)}
                        onDrop={(event) => handleDrop(event, column.id)}
                      >
                        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className={cn("inline-flex size-7 items-center justify-center rounded-md ring-1", column.tone)}>
                              <ColumnIcon className="size-3.5" />
                            </span>
                            <div className="min-w-0">
                              <h3 className="truncate text-sm font-semibold">{column.title}</h3>
                              {/* The column's TOTAL, not how many are loaded — a
                                  paged column showing "25 tasks" would be a lie. */}
                              <p className="text-xs text-muted-foreground">{columnTotal} tasks</p>
                            </div>
                          </div>
                          <Button variant="ghost" size="icon-sm">
                            <MoreHorizontalIcon />
                          </Button>
                        </div>
                        <div data-board-scroll className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                          {draggedTaskId && dropTarget?.columnId === column.id && dropTarget.taskId === null ? (
                            <EndDropIndicator label={`Drop at end of ${column.title}`} />
                          ) : null}
                          {shownColumnTasks.map((task) => (
                            <div key={task.id} className="relative">
                              {draggedTaskId && dropTarget?.taskId === task.id && dropTarget.position === "before" ? (
                                <DropIndicator label={`Drop before ${task.title}`} position="before" />
                              ) : null}
                              <TaskCard
                                task={task}
                                selected={selectedTask?.id === task.id}
                                dragging={draggedTaskId === task.id}
                                onSelect={() => openTaskDetails(task.id)}
                                onDragStart={() => setDraggedTaskId(task.id)}
                                onDragOver={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  const bounds = event.currentTarget.getBoundingClientRect()
                                  const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after"
                                  if (draggedTaskId && draggedTaskId !== task.id) {
                                    setDropTarget({ columnId: column.id, taskId: task.id, position })
                                  }
                                }}
                                onDrop={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  handleDrop(event, column.id)
                                }}
                                onDragEnd={() => {
                                  setDraggedTaskId(null)
                                  setDropTarget(null)
                                }}
                                onMoveNext={() => moveTask(task.id, nextStatus(task.status))}
                                onMovePrevious={() => moveTask(task.id, previousStatus(task.status))}
                              />
                              {draggedTaskId && dropTarget?.taskId === task.id && dropTarget.position === "after" ? (
                                <DropIndicator label={`Drop after ${task.title}`} position="after" />
                              ) : null}
                            </div>
                          ))}
                          {shownColumnTasks.length < columnTotal ? (
                            <BoardLoadMoreSentinel
                              onLoadMore={() => void loadMoreBoardColumn(column.id)}
                              remaining={columnTotal - shownColumnTasks.length}
                            />
                          ) : null}
                          {columnTasks.length === 0 ? (
                            <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed bg-muted/40 px-3 text-center text-sm text-muted-foreground">
                              No tasks in {column.title.toLowerCase()}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </section>
        )} />
            <Route
              path="/dashboard/agents"
              element={
                activeProject ? (
                  <AgentsPage
                    project={activeProject}
                    liveWorkspace={activeLiveWorkspace}
                    currentUser={currentUser}
                    onWorkspaceUpdate={(updater) => {
                      if (activeLiveProjectId) applyWorkspaceUpdate(activeLiveProjectId, updater)
                    }}
                    onRefreshWorkspace={() => loadLiveWorkspace(activeProjectId)}
                    onActive={setChatSurfaceMounted}
                    onComposeTask={composeTaskFromMessage}
                  />
                ) : (
                  <NoProjectEmptyState onNewProject={() => setDialogMode("new-project")} syncing={isLiveSyncing} />
                )
              }
            >
              <Route index element={<AgentsConversationEmpty />} />
              <Route path=":conversationId" element={<AgentsConversationRoute />} />
            </Route>
            <Route
              path="/dashboard/reviews"
              element={
                activeProject ? (
                  <ReviewsPage
                    tasks={projectTasks.filter((task) => task.status === "review")}
                    reviews={reviewFeed}
                    onReview={(taskId) => {
                      setReviewTaskId(taskId)
                      setDialogMode("review-decision")
                    }}
                  />
                ) : (
                  <NoProjectEmptyState onNewProject={() => setDialogMode("new-project")} syncing={isLiveSyncing} />
                )
              }
            />
            <Route path="/dashboard/history" element={<Navigate to="/dashboard/activity" replace />} />
            <Route
              path="/dashboard/activity"
              element={
                activeProject ? (
                  <ActivityLogPage
                    title="Activity"
                    events={activityEvents}
                    page={activityPage}
                    totalPages={activityTotalPages}
                    totalCount={activityTotal}
                    tool={activityTool}
                    tools={activityToolOptions}
                    loading={loadingOlder}
                    onPageChange={(next) => void loadActivityPage(next, activityTool)}
                    onToolChange={(next) => void loadActivityPage(1, next)}
                  />
                ) : (
                  <NoProjectEmptyState onNewProject={() => setDialogMode("new-project")} syncing={isLiveSyncing} />
                )
              }
            />
            <Route
              path="/dashboard/invites"
              element={
                activeProject ? (
                  <InvitesPage project={activeProject} invites={projectInviteRecords} onInvite={() => setDialogMode("invite")} />
                ) : (
                  <NoProjectEmptyState onNewProject={() => setDialogMode("new-project")} syncing={isLiveSyncing} />
                )
              }
            />
            <Route path="/dashboard/settings" element={<Navigate to="/dashboard/api" replace />} />
            <Route
              path="/dashboard/api"
              element={
                activeProject ? (
                  <ApiBasePage
                    project={activeProject}
                    workspace={activeLiveWorkspace}
                    onContract={() => setDialogMode("api-contract")}
                    onUpdateProject={handleUpdateProject}
                  />
                ) : (
                  <NoProjectEmptyState onNewProject={() => setDialogMode("new-project")} syncing={isLiveSyncing} />
                )
              }
            />
            <Route path="/dashboard/*" element={<Navigate to="/dashboard/board" replace />} />
            <Route path="/account" element={<AccountLayout pendingInvites={myInviteCount} />}>
              <Route index element={<Navigate to="/account/profile" replace />} />
              <Route path="profile" element={<ProfilePage currentUser={currentUser} projects={accountProjects} />} />
              <Route path="settings" element={<SettingsPage projects={accountProjects} />} />
              <Route
                path="invitations"
                element={
                  <InvitationsPage
                    onAccepted={() => {
                      void loadLiveWorkspace(activeProjectId)
                      void refreshMyInviteCount()
                    }}
                    onDeclined={() => void refreshMyInviteCount()}
                  />
                }
              />
              <Route path="security" element={<SecurityPage />} />
              <Route path="*" element={<Navigate to="/account/profile" replace />} />
            </Route>
          </Routes>
        </main>
      </SidebarInset>
      {openTaskRef && openTaskRef.kind !== "ready" ? (
        <TaskRefNotice
          state={openTaskRef}
          onClose={() => setOpenTaskId(null)}
          onSwitchProject={(projectId) => {
            // Keep openTaskId set: once the new project's tasks land the
            // resolver flips to "ready" and the sheet opens on its own.
            setActiveProjectId(projectId)
          }}
        />
      ) : null}
      {openTaskRef?.kind === "ready" && openTaskResolved && activeProject ? (
        <TaskDetailSheet
          // Keyed on the task id so opening a DIFFERENT task remounts the
          // subtree. Without it, `MessageAttachments` keeps its `activeIndex`
          // while its `attachments` prop is swapped underneath — so a TASK#n
          // chip clicked inside an open preview silently retargets the preview
          // at the new task's attachment at that index, or unmounts it when the
          // new task has none. Either way the reader loses the document they
          // were reading, which is the failure 32da9af exists to prevent.
          key={openTaskResolved.id}
          task={openTaskResolved}
          offBoard={openTaskOffBoard}
          project={activeProject}
          projectTasks={projectTasks}
          liveWorkspace={activeLiveWorkspace}
          onClose={() => setOpenTaskId(null)}
          onEdit={() => {
            const row = activeLiveWorkspace?.tasks.find((task) => String(task.id) === openTaskResolved.id)
            if (!row) return
            const editMembers = activeLiveWorkspace?.members ?? []
            setNewTaskOwner(
              row.assigned_user != null
                ? {
                    id: row.assigned_user,
                    label:
                      editMembers.find((member) => member.user === row.assigned_user)?.display_name ??
                      `User #${row.assigned_user}`,
                  }
                : null
            )
            setNewTaskOperator(
              row.operator_user != null
                ? `user:${row.operator_user}`
                : row.operator_agent_id != null
                  ? `agent:${row.operator_agent_id}`
                  : ""
            )
            setNewTaskDue(row.due_at ? isoToDatetimeLocalInput(row.due_at) : "")
            setEditTaskId(openTaskResolved.id)
            setDialogMode("edit-task")
          }}
          onDelete={() => handleDeleteTask(openTaskResolved.id)}
          onMove={(status) => moveTask(openTaskResolved.id, status)}
          onOpenTask={(taskId) => openTaskDetails(taskId)}
          onOpenReview={() => {
            setReviewTaskId(openTaskResolved.id)
            setDialogMode("review-decision")
          }}
          onOpenMessage={() => navigate("/dashboard/agents")}
          onStartSession={handleStartTaskSession}
          onPauseSession={handlePauseTaskSession}
          onStopSession={handleStopTaskSession}
          onUploadAttachment={(files) => void handleUploadTaskAttachment(openTaskResolved.id, files)}
          onAddComment={async (body) => {
            const projectId = liveId(activeProject.id)
            const taskId = liveId(openTaskResolved.id)
            if (projectId === null || taskId === null) {
              throw new Error("Save this project before commenting on its tasks.")
            }
            await recordTaskSessionActivity(projectId, taskId, "commented", body)
          }}
        />
      ) : null}
      <TaskSessionDock
        tasks={projectTasks}
        liveWorkspace={activeLiveWorkspace}
        onOpenTask={openTaskDetails}
        onStartSession={handleStartTaskSession}
        onPauseSession={handlePauseTaskSession}
        onStopSession={handleStopTaskSession}
      />
      <WorkspaceDialog
        key={dialogMode === "new-task" && composeSeed ? `new-task-${composeSeed.nonce}` : (dialogMode ?? "closed")}
        mode={dialogMode}
        activeProject={activeProject}
        reviewTask={reviewTask}
        editTask={
          dialogMode === "new-task"
            ? composeSeed
              ? {
                  title: composeSeed.title,
                  status: "not_started" as ColumnId,
                  priority: "high" as Priority,
                  estimate: "",
                  description: composeSeed.description,
                  notes: "",
                  review: "",
                }
              : undefined
            : editTaskSeed
        }
        members={activeLiveWorkspace?.members ?? []}
        agents={activeLiveWorkspace?.agents ?? []}
        taskOwner={newTaskOwner}
        onTaskOwnerChange={setNewTaskOwner}
        taskOperator={newTaskOperator}
        onTaskOperatorChange={setNewTaskOperator}
        taskDue={newTaskDue}
        onTaskDueChange={setNewTaskDue}
        onClose={() => {
          setDialogMode(null)
          setReviewTaskId(null)
          setEditTaskId(null)
        }}
        onEditProject={() => setDialogMode("edit-project")}
        onCreateTask={handleCreateTask}
        onCreateProject={handleCreateProject}
        onUpdateProject={handleUpdateProject}
        onCreateInvite={handleCreateInvite}
        onReviewDecision={handleReviewDecision}
      />
      {/* #55: chat lives over the page, not on a route of its own — the whole
          point is not losing your place on the board to send one message. */}
      {activeProject && dockOpen ? (
        <ChatDock
          project={activeProject}
          liveWorkspace={activeLiveWorkspace}
          currentUser={currentUser}
          onWorkspaceUpdate={(updater) => {
            if (activeLiveProjectId) applyWorkspaceUpdate(activeLiveProjectId, updater)
          }}
          onRefreshWorkspace={() => loadLiveWorkspace(activeProjectId)}
          chatId={dockChatId}
          onChangeChat={setDockChatId}
          onComposeTask={composeTaskFromMessage}
          onClose={() => setDockOpen(false)}
        />
      ) : null}
      {/* No launcher on the Agents page: it already IS the chat, so a floating
          button to open a smaller copy of it is just clutter. Keyed on the same
          two signals as chatNeeded — the mount is the honest one, the path check
          covers the frame before it mounts. */}
      {activeProject && !dockOpen && !chatSurfaceMounted && !location.pathname.startsWith("/dashboard/agents") ? (
        <button
          type="button"
          className="fixed bottom-4 right-4 z-[60] flex cursor-pointer items-center gap-1.5 rounded-3xl bg-primary px-3 py-3.5 text-sm font-medium text-primary-foreground shadow-lg transition hover:opacity-90"
          onClick={() => setDockOpen(true)}
          title="Open chat"
        >
          <MessageSquareIcon className="size-4" />
          Chat
        </button>
      ) : null}
    </SidebarProvider>
     </ChatDockContext.Provider>
     </GithubRepoContext.Provider>
    </TaskChipContext.Provider>
  )
}


export default App
