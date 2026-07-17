import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react"
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BellIcon,
  BotIcon,
  CheckIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  Clock3Icon,
  ClipboardCheckIcon,
  FileTextIcon,
  FileJsonIcon,
  GitBranchIcon,
  FolderKanbanIcon,
  GripVerticalIcon,
  InboxIcon,
  KanbanSquareIcon,
  LinkIcon,
  LockIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  TerminalIcon,
  TimerIcon,
  UserRoundPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import {
  confirmPasswordReset,
  fetchCurrentUser,
  hasStoredAuthSession,
  getStoredUser,
  loginUser,
  logoutUser,
  registerUser,
  requestPasswordReset,
  type AuthUser,
  type AuthResult,
} from "@/lib/auth-api"
import type {
  TaskflowAgentMessage,
  TaskflowAgentMessagePriority,
  TaskflowProjectInviteRole,
  TaskflowProjectInviteStatus,
  TaskflowProjectUpdate,
  TaskflowTaskPriority,
  TaskflowTaskStatus,
} from "@/api/client"
import {
  addChannelMember,
  archiveTaskflowProject,
  createTaskflowAgentChannel,
  createTaskflowAgentChannelMember,
  createTaskflowProjectInvite,
  createTaskflowTaskActivity,
  createTaskflowTaskSession,
  createTaskflowTask,
  createTaskflowProject,
  ProjectFormError,
  fetchMyInvites,
  fetchTaskflowProjectSummary,
  fetchTaskflowWorkspace,
  realtimeEventHasInlineRow,
  subscribeToTaskflowProjectEvents,
  subscribeToTaskflowWorkspaceEvents,
  sendTaskflowAgentMessage,
  taskflowApi,
  taskflowTables,
  updateTaskflowProject,
  updateTaskflowTask,
  updateTaskflowTaskSession,
  type TaskflowRealtimeEvent,
  type TaskflowProjectSummary,
  type TaskflowWorkspace,
} from "@/lib/taskflow-api"
import {
  addPending,
  findPending,
  isPending,
  markFailed,
  markRetrying,
  reconcile,
  removeMessage,
} from "@/lib/message-store"
import { cn } from "@/lib/utils"
import { AccountLayout } from "@/pages/account/AccountLayout"
import { ProfilePage } from "@/pages/account/ProfilePage"
import { SettingsPage } from "@/pages/account/SettingsPage"
import { InvitationsPage } from "@/pages/account/InvitationsPage"
import { SecurityPage } from "@/pages/account/SecurityPage"

type ColumnId = "not_started" | "in_progress" | "review" | "blocked" | "done"

type Priority = "P0" | "P1" | "P2"

type DialogMode = "new-project" | "edit-project" | "new-task" | "invite" | "api-contract" | "review-decision" | null

type AuthMode = "login" | "signup" | "reset" | "confirm"

type AuthGateStatus = "checking" | "authenticated" | "anonymous"

type DropTarget = {
  columnId: ColumnId
  taskId: string | null
  position: "before" | "after"
}

type ActivityEvent = {
  id: string
  title: string
  detail: string
  actor: string
  action: string
  entity: string
  time: string
}

type TaskActivityItem = {
  id: string
  detail: string
  actor: string
  action: string
  time: string
}

type TaskSession = {
  id: string
  liveSessionId?: number
  actor: string
  state: "active" | "paused" | "complete" | "failed"
  started: string
  duration: string
  detail: string
  startedAt?: string
  endedAt?: string | null
  durationSeconds?: number | null
}

type TaskRelation = {
  id: string
  title: string
  type: "Blocked by" | "Blocks" | "Related"
  status?: ColumnId
  detail: string
  taskId?: string
}

type MessagePriority = "normal" | "needs-response" | "blocking"

type AgentAttachment = {
  id: string
  kind: "image" | "markdown" | "file" | "url"
  name: string
  detail: string
  source: "upload" | "project-path" | "url" | "generated"
  path?: string
  url?: string
  size?: string
  mimeType?: string
}

type AgentMessage = {
  id: string
  from: string
  to?: string
  time: string
  body: string
  status: string
  priority?: MessagePriority
  choices?: string[]
  attachments?: AgentAttachment[]
  /// Set only on optimistic bubbles the server has not acknowledged. Carries the
  /// client_nonce so a failed bubble can be retried against the idempotent send.
  nonce?: string
}

type ConversationMember = {
  name: string
  type: "human" | "agent"
}

type AgentChatContext = {
  id: string
  mode: "direct" | "channel"
  liveChannelId?: number
  liveAgentId?: number
  title: string
  detail: string
  status: string
  members: ConversationMember[]
  primaryAgent: string
  unread: number
  messages: AgentMessage[]
}

type AgentTerminalSessionView = {
  agent: string
  status: string
  task: string
  cwd: string
  updated: string
  lines: string[]
}

type InviteRecord = {
  id: string
  recipient: string
  type: "Human" | "Agent"
  role: "Owner" | "Developer" | "Viewer"
  scope: string
  status: "Pending" | "Accepted" | "Expired" | "Needs auth" | "Revoked"
  requestedBy: string
  sent: string
  expires: string
  lastEvent: string
  nextAction: string
}

type TaskLink = {
  label: string
  value: string
  detail: string
}

type Project = {
  id: string
  name: string
  code: string
  status: "active" | "paused" | "archived" | "seeded"
  health: string
  tint: string
  owner: string
  cadence: string
  objective: string
  members: number
  agentsOnline: number
  apiBase: string
}

type Task = {
  id: string
  projectId: string
  title: string
  description?: string
  notes?: string
  status: ColumnId
  priority: Priority
  owner: string
  ownerInitials: string
  operator: "agent" | "human" | "pair"
  operatorName: string
  estimate: string
  updated: string
  due: string
  tags: string[]
  blockers: string[]
  review: string
  history: string[]
}

const columns: {
  id: ColumnId
  title: string
  tone: string
  icon: typeof CircleDotIcon
}[] = [
  {
    id: "not_started",
    title: "Ready",
    tone: "bg-slate-100 text-slate-700 ring-slate-200",
    icon: CircleDotIcon,
  },
  {
    id: "in_progress",
    title: "In Progress",
    tone: "bg-blue-100 text-blue-800 ring-blue-200",
    icon: PlayIcon,
  },
  {
    id: "review",
    title: "Human Review",
    tone: "bg-amber-100 text-amber-800 ring-amber-200",
    icon: ShieldCheckIcon,
  },
  {
    id: "blocked",
    title: "Blocked",
    tone: "bg-rose-100 text-rose-800 ring-rose-200",
    icon: AlertCircleIcon,
  },
  {
    id: "done",
    title: "Done",
    tone: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    icon: CheckCircle2Icon,
  },
]

const flow: ColumnId[] = ["not_started", "in_progress", "review", "done"]

const statusOptions = columns.map((column) => ({
  value: column.id,
  label: column.title,
}))

const priorityOptions = [
  { value: "P0", label: "P0, urgent" },
  { value: "P1", label: "P1, important" },
  { value: "P2", label: "P2, normal" },
]

const projectStatusOptions = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "archived", label: "Archived" },
]

const inviteTypeOptions = [
  { value: "user", label: "User" },
  { value: "agent", label: "Agent" },
]

const syncModeOptions = [
  { value: "realtime", label: "Realtime" },
  { value: "polling", label: "Polling" },
  { value: "manual", label: "Manual" },
]


const messagePriorityOptions = [
  { value: "normal", label: "Normal" },
  { value: "needs-response", label: "Needs response" },
  { value: "blocking", label: "Blocking" },
] satisfies Array<{ value: MessagePriority; label: string }>

const reviewDecisionOptions = [
  { value: "approve", label: "Approve and mark done" },
  { value: "changes", label: "Request changes" },
  { value: "blocked", label: "Block until clarified" },
]

function nextStatus(status: ColumnId): ColumnId {
  if (status === "blocked") return "in_progress"
  const index = flow.indexOf(status)
  return flow[Math.min(index + 1, flow.length - 1)]
}

function previousStatus(status: ColumnId): ColumnId {
  if (status === "blocked") return "not_started"
  const index = flow.indexOf(status)
  return flow[Math.max(index - 1, 0)]
}

function priorityClass(priority: Priority) {
  if (priority === "P0") return "bg-rose-100 text-rose-800 ring-rose-200"
  if (priority === "P1") return "bg-amber-100 text-amber-800 ring-amber-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}

function statusLabel(status?: ColumnId) {
  if (!status) return "External"
  return columns.find((column) => column.id === status)?.title ?? status
}

function relationTone(type: TaskRelation["type"]) {
  if (type === "Blocked by") return "bg-rose-100 text-rose-800 ring-rose-200"
  if (type === "Blocks") return "bg-amber-100 text-amber-800 ring-amber-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}

function getTaskSessions(task: Task): TaskSession[] {
  const active = task.status === "in_progress" || task.status === "review"
  return [
    {
      id: `${task.id}-current`,
      actor: task.operatorName,
      state: active ? "active" : task.status === "blocked" ? "paused" : "complete",
      started: task.updated,
      duration: task.estimate,
      detail: active
        ? "Current focus session is attached to this task and visible to the project room."
        : task.status === "blocked"
          ? "Session is paused until the blocking condition is cleared."
          : "Last focused session was completed and retained for replay.",
    },
    {
      id: `${task.id}-handoff`,
      actor: task.owner,
      state: "complete",
      started: task.due === "Done" ? "Yesterday" : "Previous handoff",
      duration: "18m",
      detail: task.history[0] ?? "Task context captured for the next operator.",
    },
  ]
}

function getTaskRelations(task: Task, projectTasks: Task[]): TaskRelation[] {
  const sameProjectTasks = projectTasks.filter((candidate) => candidate.id !== task.id)
  const blockerRelations = task.blockers.map((blocker, index) => ({
    id: `${task.id}-blocker-${index}`,
    title: blocker,
    type: "Blocked by" as const,
    detail: "Unresolved dependency recorded on this task.",
  }))

  const blockingRelations = sameProjectTasks
    .filter((candidate) =>
      candidate.blockers.some((blocker) => {
        const normalized = blocker.toLowerCase()
        return normalized.includes(task.id.toLowerCase()) || normalized.includes(task.title.toLowerCase())
      })
    )
    .slice(0, 2)
    .map((candidate) => ({
      id: `${task.id}-blocks-${candidate.id}`,
      title: candidate.title,
      type: "Blocks" as const,
      status: candidate.status,
      detail: `This task is referenced by ${candidate.id}.`,
      taskId: candidate.id,
    }))

  const relatedRelations = sameProjectTasks
    .filter((candidate) => candidate.tags.some((tag) => task.tags.includes(tag)))
    .slice(0, Math.max(1, 3 - blockerRelations.length - blockingRelations.length))
    .map((candidate) => ({
      id: `${task.id}-related-${candidate.id}`,
      title: candidate.title,
      type: "Related" as const,
      status: candidate.status,
      detail: `Shares ${candidate.tags.filter((tag) => task.tags.includes(tag)).join(", ")} context.`,
      taskId: candidate.id,
    }))

  const fallbackRelations =
    blockerRelations.length || blockingRelations.length || relatedRelations.length
      ? []
      : sameProjectTasks.slice(0, 2).map((candidate) => ({
          id: `${task.id}-nearby-${candidate.id}`,
          title: candidate.title,
          type: "Related" as const,
          status: candidate.status,
          detail: "Same project context, ready for explicit relation linking.",
          taskId: candidate.id,
        }))

  return [...blockerRelations, ...blockingRelations, ...relatedRelations, ...fallbackRelations]
}

function relationKindLabel(kind: TaskflowWorkspace["taskRelations"][number]["kind"], isSource: boolean): TaskRelation["type"] {
  if (kind === "blocks") return isSource ? "Blocks" : "Blocked by"
  return "Related"
}

function getLiveTaskRelations(task: Task, projectTasks: Task[], workspace: TaskflowWorkspace): TaskRelation[] {
  const taskId = liveId(task.id)
  if (!taskId) return []

  return workspace.taskRelations
    .filter((relation) => relation.source_task === taskId || relation.target_task === taskId)
    .map((relation) => {
      const isSource = relation.source_task === taskId
      const relatedTaskId = isSource ? relation.target_task : relation.source_task
      const relatedTask = projectTasks.find((candidate) => candidate.id === String(relatedTaskId))
      const label = relationKindLabel(relation.kind, isSource)

      return {
        id: String(relation.id),
        title: relatedTask?.title ?? `Task #${relatedTaskId}`,
        type: label,
        status: relatedTask?.status,
        detail: relation.detail_markdown || `Live ${relation.kind.replace(/_/g, " ")} relation from taskflow_task_relation.`,
        taskId: String(relatedTaskId),
      }
    })
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return "Running"
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function sessionDurationSeconds(session: TaskflowWorkspace["taskSessions"][number], end = new Date()) {
  if (session.duration_seconds != null) return session.duration_seconds
  const startedAt = new Date(session.started_at)
  if (Number.isNaN(startedAt.getTime())) return 0
  const endedAt = session.ended_at ? new Date(session.ended_at) : end
  if (Number.isNaN(endedAt.getTime())) return 0
  return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))
}

function getRunningLiveTaskSession(task: Task, workspace: TaskflowWorkspace) {
  const taskId = liveId(task.id)
  if (!taskId) return undefined

  return workspace.taskSessions
    .filter((session) => session.task === taskId && session.state === "running" && !session.ended_at)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .at(0)
}

function getTaskSessionTotalSeconds(task: Task, workspace: TaskflowWorkspace) {
  const taskId = liveId(task.id)
  if (!taskId) return 0
  return workspace.taskSessions
    .filter((session) => session.task === taskId)
    .reduce((total, session) => total + sessionDurationSeconds(session), 0)
}

function mapLiveSessionState(state: TaskflowWorkspace["taskSessions"][number]["state"]): TaskSession["state"] {
  if (state === "running") return "active"
  if (state === "paused") return "paused"
  if (state === "failed") return "failed"
  return "complete"
}

function getLiveTaskSessions(task: Task, workspace: TaskflowWorkspace): TaskSession[] {
  const taskId = liveId(task.id)
  if (!taskId) return []

  return workspace.taskSessions
    .filter((session) => session.task === taskId)
    .slice()
    .sort((a, b) => {
      if (a.state === "running" && b.state !== "running") return -1
      if (a.state !== "running" && b.state === "running") return 1
      return new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    })
    .map((session) => ({
      id: String(session.id),
      liveSessionId: session.id,
      actor: session.actor_label,
      state: mapLiveSessionState(session.state),
      started: formatLiveDate(session.started_at, "Started"),
      duration: formatDuration(sessionDurationSeconds(session)),
      detail: session.summary_markdown || `Live ${session.state} session recorded in taskflow_task_session.`,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      durationSeconds: session.duration_seconds,
    }))
}

function getLiveTaskActivity(task: Task, workspace: TaskflowWorkspace): TaskActivityItem[] {
  const taskId = liveId(task.id)
  if (!taskId) return []

  return workspace.taskActivity
    .filter((event) => event.task === taskId)
    .map((event) => ({
      id: String(event.id),
      actor: event.actor_label,
      action: event.action,
      time: formatLiveDate(event.created_at, "Live"),
      detail: event.body_markdown || event.action.replace(/_/g, " "),
    }))
}

/// The project-wide activity feed, sourced from taskflow_task_activity. Rows
/// arrive newest-first from the API; each is resolved to its task title when the
/// task is loaded, otherwise labelled by its numeric id or the project name.
function mapLiveActivityEvents(workspace: TaskflowWorkspace, projectTasks: Task[]): ActivityEvent[] {
  return workspace.taskActivity.map((event) => {
    const relatedTask =
      event.task != null ? projectTasks.find((task) => liveId(task.id) === event.task) : undefined
    return {
      id: String(event.id),
      title: relatedTask?.title ?? (event.task != null ? `Task #${event.task}` : workspace.project.name),
      detail: event.body_markdown || event.action.replace(/_/g, " "),
      actor: event.actor_label,
      action: event.action,
      entity: relatedTask?.id ?? (event.task != null ? `Task #${event.task}` : "Project"),
      time: formatLiveDate(event.created_at, "Live"),
    }
  })
}

function getFallbackTaskActivity(task: Task): TaskActivityItem[] {
  return task.history.map((event, index) => ({
    id: `${task.id}-history-${index}`,
    actor: task.operatorName,
    action: index === 0 ? "latest_update" : "activity_logged",
    time: index === 0 ? task.updated : `${index + 1} events ago`,
    detail: event,
  }))
}

function getTaskLinks(task: Task, project: Project): TaskLink[] {
  return [
    {
      label: "Task API",
      value: `${project.apiBase}/tasks/${task.id}`,
      detail: "Canonical task payload and status transitions.",
    },
    {
      label: "Activity cursor",
      value: `${project.apiBase}/activity?entity=${task.id}`,
      detail: "Project-scoped replay log for this task.",
    },
    {
      label: "Review gate",
      value: `${project.apiBase}/reviews/${task.id}`,
      detail: "Human decision endpoint for guarded work.",
    },
  ]
}

function getTaskDescription(task: Task) {
  if (task.description?.trim()) return task.description

  const blockers =
    task.blockers.length > 0
      ? `\n\n### Blockers\n${task.blockers.map((blocker) => `- ${blocker}`).join("\n")}`
      : ""

  return `### Outcome\n${task.review}\n\n### Scope\n- Owner: **${task.owner}**\n- Operator: \`${task.operatorName}\`\n- Tags: ${task.tags.map((tag) => `\`${tag}\``).join(", ")}${blockers}`
}

function getTaskNotes(task: Task) {
  if (task.notes?.trim()) return task.notes

  return `- Latest update: ${task.history[0] ?? "No activity yet."}\n- Estimate: **${task.estimate}**\n- Due: **${task.due}**`
}

function toInitials(value: string) {
  return value
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "TF"
}

function slugifyProjectName(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")

  return slug || `project-${Date.now()}`
}

function liveId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function liveProjectTint(index: number) {
  const palette = [
    "oklch(0.58 0.16 238)",
    "oklch(0.55 0.13 155)",
    "oklch(0.57 0.14 30)",
    "oklch(0.56 0.13 300)",
    "oklch(0.52 0.12 190)",
  ]
  return palette[index % palette.length]
}

function formatLiveDate(value: string | null | undefined, fallback = "Live") {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}

function mapLiveStatus(status: TaskflowTaskStatus): ColumnId {
  if (status === "partial_done") return "review"
  if (status === "paused") return "blocked"
  if (status === "archived") return "done"
  return status
}

function toLiveStatus(status: ColumnId): TaskflowTaskStatus {
  if (status === "review") return "partial_done"
  return status
}

function mapLivePriority(priority: TaskflowTaskPriority): Priority {
  if (priority === "critical") return "P0"
  if (priority === "high") return "P1"
  return "P2"
}

function toLivePriority(priority: Priority): TaskflowTaskPriority {
  if (priority === "P0") return "critical"
  if (priority === "P1") return "high"
  return "normal"
}

function mapLiveProjects(summary: TaskflowProjectSummary): Project[] {
  return summary.projects.map((project, index) => {
    const members = summary.members.filter((member) => member.project === project.id && member.status === "active").length
    const agents = summary.agents.filter(
      (agent) => agent.project === project.id && ["connected", "idle", "busy"].includes(agent.status)
    )
    const connectedSessions = summary.sessions.filter(
      (session) => session.project === project.id && session.status === "connected"
    ).length

    return {
      id: String(project.id),
      name: project.name,
      code: toInitials(project.slug || project.name),
      status: project.status,
      health: project.status === "active" ? `${connectedSessions} connected sessions` : project.status,
      tint: liveProjectTint(index),
      owner: project.owner ? `User #${project.owner}` : "Workspace",
      cadence: connectedSessions ? `${connectedSessions} sessions live` : "Realtime ready",
      objective: project.description_markdown || "Live TaskFlow project.",
      members,
      agentsOnline: agents.length,
      apiBase: project.default_api_base_url || "/api",
    }
  })
}

function mapLiveTasks(tasks: TaskflowProjectSummary["tasks"] | TaskflowWorkspace["tasks"]): Task[] {
  return tasks.map((task) => {
    const assignee = task.assignee_label || (task.assigned_agent_id ? `Agent #${task.assigned_agent_id}` : "Unassigned")

    return {
      id: String(task.id),
      projectId: String(task.project),
      title: task.title,
      description: task.description_markdown,
      notes: task.notes_markdown ?? "",
      status: mapLiveStatus(task.status),
      priority: mapLivePriority(task.priority),
      owner: assignee,
      ownerInitials: toInitials(assignee),
      operator: task.assigned_agent_id ? "agent" : task.assigned_user ? "human" : "pair",
      operatorName: assignee,
      estimate: "Live",
      updated: formatLiveDate(task.updated_at ?? task.created_at, "Live API"),
      due: formatLiveDate(task.due_at, "Unscheduled"),
      tags: ["live-api"],
      blockers: [],
      review: task.status === "partial_done" ? "Waiting for human review." : "No explicit review gate on the live task.",
      history: [
        `Loaded from /api/taskflow_task/${task.id}.`,
        task.updated_at ? `Last updated ${formatLiveDate(task.updated_at)}.` : "Waiting for live activity.",
      ],
    }
  })
}

function upsertById<T extends { id: number }>(items: T[], row: T) {
  const index = items.findIndex((item) => item.id === row.id)
  if (index < 0) return [...items, row]
  return [...items.slice(0, index), row, ...items.slice(index + 1)]
}

function removeById<T extends { id: number }>(items: T[], id: number) {
  return items.filter((item) => item.id !== id)
}

function mapLiveProjectRow(project: TaskflowWorkspace["project"], current?: Project, index = 0): Project {
  return {
    id: String(project.id),
    name: project.name,
    code: toInitials(project.slug || project.name),
    status: project.status,
    health: current?.health ?? (project.status === "active" ? "Live project" : project.status),
    tint: current?.tint ?? liveProjectTint(index),
    owner: project.owner ? `User #${project.owner}` : "Workspace",
    cadence: current?.cadence ?? "Realtime ready",
    objective: project.description_markdown || "Live TaskFlow project.",
    members: current?.members ?? 0,
    agentsOnline: current?.agentsOnline ?? 0,
    apiBase: project.default_api_base_url || "/api",
  }
}

function mapLiveMessagePriority(priority: TaskflowAgentMessagePriority): MessagePriority {
  if (priority === "urgent") return "blocking"
  if (priority === "important") return "needs-response"
  return "normal"
}

function toLiveMessagePriority(priority: MessagePriority): TaskflowAgentMessagePriority {
  if (priority === "blocking") return "urgent"
  if (priority === "needs-response") return "important"
  return "normal"
}

function mapLiveInviteRole(role: TaskflowProjectInviteRole): InviteRecord["role"] {
  if (role === "owner" || role === "admin") return "Owner"
  if (role === "viewer") return "Viewer"
  return "Developer"
}

function toLiveInviteRole(role: string): TaskflowProjectInviteRole {
  if (role === "owner") return "owner"
  if (role === "viewer") return "viewer"
  return "developer"
}

function mapLiveInviteStatus(status: TaskflowProjectInviteStatus): InviteRecord["status"] {
  if (status === "accepted") return "Accepted"
  if (status === "expired") return "Expired"
  if (status === "revoked") return "Revoked"
  return "Pending"
}

function formatInviteWindow(invite: TaskflowWorkspace["invites"][number]) {
  const status = mapLiveInviteStatus(invite.status)
  if (status === "Accepted") return "Accepted"
  if (status === "Revoked") return "Revoked"
  if (status === "Expired") return "Expired"
  if (!invite.expires_at) return "No expiry"

  const expiresAt = new Date(invite.expires_at)
  if (Number.isNaN(expiresAt.getTime())) return "No expiry"

  const remainingMs = expiresAt.getTime() - Date.now()
  if (remainingMs <= 0) return "Expired"

  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000))
  if (remainingDays <= 1) return "24h left"
  return `${remainingDays}d left`
}

function isAgentInviteEmail(email: string) {
  return email.toLowerCase().endsWith("@agents.taskflow.local")
}

function normalizeAgentInviteEmail(recipient: string) {
  if (recipient.includes("@")) return recipient.toLowerCase()
  return `${slugifyProjectName(recipient)}@agents.taskflow.local`
}

function mapLiveInvites(workspace: TaskflowWorkspace, currentUser: AuthUser | null): InviteRecord[] {
  return workspace.invites.map((invite) => {
    const type = isAgentInviteEmail(invite.email) ? "Agent" : "Human"
    const recipient = invite.display_name || (type === "Agent" ? invite.email.replace(/@agents\.taskflow\.local$/i, "") : invite.email)
    const status = mapLiveInviteStatus(invite.status)
    const requestedBy =
      currentUser && invite.invited_by === currentUser.id
        ? currentUser.username
        : invite.invited_by
          ? `User #${invite.invited_by}`
          : "System"

    return {
      id: String(invite.id),
      recipient,
      type,
      role: mapLiveInviteRole(invite.role),
      scope: `Project: **${workspace.project.name}**\n\nAccess activates only after identity verification.`,
      status,
      requestedBy,
      sent: formatLiveDate(invite.created_at, "Live"),
      expires: formatInviteWindow(invite),
      lastEvent:
        status === "Accepted"
          ? `Accepted ${formatLiveDate(invite.accepted_at, "recently")}. Project membership should be active.`
          : status === "Pending"
            ? "Invite is pending. The recipient must authenticate before access is activated."
            : `Invite is ${status.toLowerCase()} and no longer grants access.`,
      nextAction: status === "Accepted" ? "Open member" : status === "Pending" ? "Resend" : "Reissue",
    }
  })
}

function uniqueMembers(members: ConversationMember[]) {
  const seen = new Set<string>()
  return members.filter((member) => {
    const key = `${member.type}:${member.name.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function workspaceDefaultMembers(workspace: TaskflowWorkspace, currentUser: AuthUser | null): ConversationMember[] {
  return uniqueMembers([
    ...workspace.members
      .filter((member) => member.status === "active")
      .map((member) => ({ name: member.display_name, type: "human" as const })),
    ...(currentUser ? [{ name: currentUser.username, type: "human" as const }] : []),
    ...workspace.agents.map((agent) => ({ name: agent.display_name, type: "agent" as const })),
  ])
}

function mapLiveChannelMembers(workspace: TaskflowWorkspace, channelId: number, currentUser: AuthUser | null): ConversationMember[] {
  const members = workspace.agentChannelMembers
    .filter((member) => member.channel === channelId)
    .map((member) => ({
      name: member.display_name,
      type: member.member_kind === "agent" ? "agent" as const : "human" as const,
    }))

  return members.length ? uniqueMembers(members) : workspaceDefaultMembers(workspace, currentUser)
}

function primaryAgentName(workspace: TaskflowWorkspace, members: ConversationMember[]) {
  return members.find((member) => member.type === "agent")?.name ?? workspace.agents[0]?.display_name ?? "project"
}

function mapLiveChannelMessages(
  workspace: TaskflowWorkspace,
  channelId: number,
  channelTitle: string,
  currentUser: AuthUser | null
): AgentMessage[] {
  return workspace.agentMessages
    .filter((message) => message.channel === channelId)
    .slice()
    .sort((a, b) => {
      // Pending bubbles have no created_at — they are the newest thing in the
      // room, so they sort last.
      if (isPending(a) && isPending(b)) return 0
      if (isPending(a)) return 1
      if (isPending(b)) return -1
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
      return aTime - bTime || a.id - b.id
    })
    .map((message) => {
      if (isPending(message)) {
        return {
          id: `pending:${message.client_nonce}`,
          nonce: message.client_nonce,
          from: "user",
          to: channelTitle,
          time: message.status === "failed" ? "Failed to send" : "Sending…",
          body: message.body_markdown,
          status: message.status === "failed" ? "failed" : "sending",
          priority: mapLiveMessagePriority(message.priority),
        }
      }
      return {
        id: String(message.id),
        from: message.sender_kind === "user" && currentUser && message.sender_user === currentUser.id ? "user" : message.sender_label,
        to: channelTitle,
        time: formatLiveDate(message.created_at, "Live"),
        body: message.body_markdown,
        status: "posted",
        priority: mapLiveMessagePriority(message.priority),
      }
    })
}

function liveChannelStatus(channel: TaskflowWorkspace["agentChannels"][number]) {
  if (channel.archived) return "Archived"
  if (channel.kind === "task") return "Task room"
  if (channel.kind === "incident") return "Incident room"
  if (channel.kind === "direct") return "Direct"
  return "Project room"
}

function mapLiveChannelChats(workspace: TaskflowWorkspace, currentUser: AuthUser | null): AgentChatContext[] {
  const projectChannels = workspace.agentChannels.filter((channel) => !channel.archived && channel.kind !== "direct")
  const chats = projectChannels.map((channel) => {
    const members = mapLiveChannelMembers(workspace, channel.id, currentUser)
    return {
      id: `live:channel:${channel.id}`,
      mode: "channel" as const,
      liveChannelId: channel.id,
      title: channel.title,
      detail: channel.topic || `Shared ${channel.kind} channel for this project.`,
      status: liveChannelStatus(channel),
      members,
      primaryAgent: primaryAgentName(workspace, members),
      unread: 0,
      messages: mapLiveChannelMessages(workspace, channel.id, channel.title, currentUser),
    }
  })

  if (chats.length) return chats

  const members = workspaceDefaultMembers(workspace, currentUser)
  return [
    {
      id: "live:project-room",
      mode: "channel",
      title: "Project room",
      detail: "Shared group chat for humans and agents in this project. The live channel is created on first send.",
      status: "Ready",
      members,
      primaryAgent: primaryAgentName(workspace, members),
      unread: 0,
      messages: [],
    },
  ]
}

function mapLiveDirectChats(workspace: TaskflowWorkspace, currentUser: AuthUser | null): AgentChatContext[] {
  const directChannels = workspace.agentChannels.filter((channel) => !channel.archived && channel.kind === "direct")
  const chats = directChannels.map((channel) => {
    const rawMembers = workspace.agentChannelMembers.filter((member) => member.channel === channel.id)
    const agentMember = rawMembers.find((member) => member.member_kind === "agent" && member.agent)
    const agent = workspace.agents.find((candidate) => candidate.id === agentMember?.agent)
    const members = mapLiveChannelMembers(workspace, channel.id, currentUser)
    const primaryAgent = agent?.display_name ?? primaryAgentName(workspace, members)

    return {
      id: `live:direct:${channel.id}`,
      mode: "direct" as const,
      liveChannelId: channel.id,
      liveAgentId: agent?.id,
      title: primaryAgent,
      detail: channel.topic || "Private channel",
      status: liveChannelStatus(channel),
      members,
      primaryAgent,
      unread: 0,
      messages: mapLiveChannelMessages(workspace, channel.id, primaryAgent, currentUser),
    }
  })
  const coveredAgentIds = new Set(chats.map((chat) => chat.liveAgentId).filter((id): id is number => Boolean(id)))
  const placeholders = workspace.agents
    .filter((agent) => !coveredAgentIds.has(agent.id))
    .map((agent) => ({
      id: `live:agent:${agent.id}`,
      mode: "direct" as const,
      liveAgentId: agent.id,
      title: agent.display_name,
      detail: agent.project_root || agent.identifier,
      status: agent.status,
      members: uniqueMembers([
        ...(currentUser ? [{ name: currentUser.username, type: "human" as const }] : [{ name: "You", type: "human" as const }]),
        { name: agent.display_name, type: "agent" as const },
      ]),
      primaryAgent: agent.display_name,
      unread: 0,
      messages: [],
    }))

  return [...chats, ...placeholders]
}

function mapLiveTerminalStatus(status: TaskflowWorkspace["agentSessions"][number]["status"]) {
  if (status === "connected") return "Connected"
  if (status === "expired") return "Expired"
  return "Disconnected"
}

function formatTerminalFrame(frame: TaskflowWorkspace["terminalFrames"][number]) {
  if (frame.stream === "stderr") return `[stderr] ${frame.content}`
  if (frame.stream === "stdin") return `$ ${frame.content}`
  if (frame.stream === "system") return `[system] ${frame.content}`
  return frame.content
}

function mapLiveTerminalSessions(workspace: TaskflowWorkspace): AgentTerminalSessionView[] {
  const sessions = workspace.agentSessions.map((session) => {
    const agent = workspace.agents.find((candidate) => candidate.id === session.agent)
    const frames = workspace.terminalFrames
      .filter((frame) => frame.session === session.id || (!frame.session && frame.agent === session.agent))
      .slice()
      .sort((a, b) => a.sequence - b.sequence || a.id - b.id)
    const lines = frames.length
      ? frames.map(formatTerminalFrame)
      : [
          `$ taskflow agent session ${session.session_identifier}`,
          `status: ${session.status}`,
          "No terminal frames recorded yet.",
        ]

    return {
      agent: agent?.display_name ?? `Agent #${session.agent}`,
      status: mapLiveTerminalStatus(session.status),
      task: agent?.status ? `Agent is ${agent.status}` : "Live agent session",
      cwd: session.cwd || agent?.project_root || "/",
      updated: formatLiveDate(session.last_seen_at ?? session.connected_at, "Live"),
      lines,
    }
  })

  if (sessions.length) return sessions

  return workspace.agents.map((agent) => ({
    agent: agent.display_name,
    status: agent.status === "connected" || agent.status === "idle" || agent.status === "busy" ? "Connected" : "Disconnected",
    task: `Agent is ${agent.status}`,
    cwd: agent.project_root || "/",
    updated: formatLiveDate(agent.last_seen_at, "No session"),
    lines: [
      `$ taskflow agent ${agent.identifier}`,
      "No live terminal session has been linked yet.",
    ],
  }))
}

function appendAttachmentMarkdown(body: string, attachments: AgentAttachment[]) {
  if (!attachments.length) return body

  const attachmentMarkdown = attachments
    .map((attachment) => {
      const target = attachment.url ?? attachment.path
      const label = target ? `[${attachment.name}](${target})` : attachment.name
      return `- ${label}: ${attachment.detail}`
    })
    .join("\n")

  return `${body || `Shared ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}.`}\n\n### Attachments\n${attachmentMarkdown}`
}

function realtimeEventRowId(event: TaskflowRealtimeEvent) {
  const id = Number(event.row.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

function mergeProjectTasks(currentTasks: Task[], projectId: string, nextProjectTasks: Task[]) {
  return [
    ...currentTasks.filter((task) => task.projectId !== projectId),
    ...nextProjectTasks,
  ]
}

function reorderTasks(tasks: Task[], taskId: string, target: DropTarget) {
  const movingTask = tasks.find((task) => task.id === taskId)
  if (!movingTask) return tasks

  const targetTitle = columns.find((column) => column.id === target.columnId)?.title ?? target.columnId
  const movedTask: Task = {
    ...movingTask,
    status: target.columnId,
    updated: "Just now",
    history: [`Moved to ${targetTitle}.`, ...movingTask.history],
  }
  const withoutMovingTask = tasks.filter((task) => task.id !== taskId)

  if (target.taskId && target.taskId !== taskId) {
    const targetIndex = withoutMovingTask.findIndex((task) => task.id === target.taskId)
    if (targetIndex >= 0) {
      const insertIndex = target.position === "before" ? targetIndex : targetIndex + 1
      return [
        ...withoutMovingTask.slice(0, insertIndex),
        movedTask,
        ...withoutMovingTask.slice(insertIndex),
      ]
    }
  }

  const lastColumnTaskIndex = withoutMovingTask.reduce((lastIndex, task, index) => {
    return task.projectId === movingTask.projectId && task.status === target.columnId ? index : lastIndex
  }, -1)

  if (lastColumnTaskIndex >= 0) {
    return [
      ...withoutMovingTask.slice(0, lastColumnTaskIndex + 1),
      movedTask,
      ...withoutMovingTask.slice(lastColumnTaskIndex + 1),
    ]
  }

  return [...withoutMovingTask, movedTask]
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [workspaceProjects, setWorkspaceProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [dialogMode, setDialogMode] = useState<DialogMode>(null)
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null)
  const [usesLiveApi, setUsesLiveApi] = useState(false)
  const [isLiveSyncing, setIsLiveSyncing] = useState(false)
  const [liveSyncError, setLiveSyncError] = useState<string | null>(null)
  const [liveWorkspace, setLiveWorkspace] = useState<TaskflowWorkspace | null>(null)
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

  const activeProject: Project | undefined =
    workspaceProjects.find((project) => project.id === activeProjectId) ?? workspaceProjects[0]
  const activeLiveProjectId = activeProject ? liveId(activeProject.id) : null
  const activeLiveWorkspace =
    activeLiveProjectId && liveWorkspace?.project.id === activeLiveProjectId ? liveWorkspace : null
  const projectTasks = useMemo(
    () => (activeProject ? tasks.filter((task) => task.projectId === activeProject.id) : []),
    [activeProject, tasks]
  )
  const selectedTask =
    projectTasks.find((task) => task.id === selectedTaskId) ?? projectTasks[0]
  const openTask = openTaskId ? tasks.find((task) => task.id === openTaskId) : undefined
  const reviewTask = reviewTaskId ? tasks.find((task) => task.id === reviewTaskId) : selectedTask
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
  const activityEvents = useMemo<ActivityEvent[]>(
    () => (activeLiveWorkspace ? mapLiveActivityEvents(activeLiveWorkspace, projectTasks) : []),
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
        const summaryTasks = mapLiveTasks(summary.tasks)

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
          const nextProjectTasks = mapLiveTasks(workspace.tasks)

          setLiveWorkspace(workspace)
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
        case taskflowTables.terminalFrames:
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, terminalFrames: removeById(workspace.terminalFrames, rowId) }))
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
          const [mappedTask] = mapLiveTasks([task])
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
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, taskActivity: upsertById(workspace.taskActivity, activity) }))
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
        case taskflowTables.terminalFrames: {
          const frame = row as TaskflowWorkspace["terminalFrames"][number]
          if (frame.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, terminalFrames: upsertById(workspace.terminalFrames, frame) }))
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

      // Chat tables project their fields server-side, so the event already
      // carries the row. Refetching it would be a round-trip for data we hold.
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
        }
      } catch (error) {
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

  useEffect(() => {
    if (authGateStatus !== "authenticated") return

    const projectId = activeProjectId ? liveId(activeProjectId) : null
    const handleRealtimeEvent = (event: TaskflowRealtimeEvent) => {
      void fetchAndApplyRealtimeEvent(event, projectId)
    }
    const projectSubscription = subscribeToTaskflowProjectEvents(handleRealtimeEvent)
    const closeWorkspaceSubscription = projectId
      ? subscribeToTaskflowWorkspaceEvents(projectId, handleRealtimeEvent)
      : undefined

    return () => {
      projectSubscription.close()
      closeWorkspaceSubscription?.()
    }
  }, [activeProjectId, authGateStatus, fetchAndApplyRealtimeEvent])

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
      status: "active",
    })

    const mappedProject = mapLiveProjectRow(project, undefined, workspaceProjects.length)
    const projectId = String(project.id)
    setLiveSyncError(null)
    setWorkspaceProjects((current) => [...current, mappedProject])
    setActiveProjectId(projectId)
    setSelectedTaskId((current) => tasks.find((task) => task.projectId === projectId)?.id ?? current)
    setLiveWorkspace({
      project,
      members: [],
      invites: [],
      apiEndpoints: [],
      tasks: [],
      taskRelations: [],
      taskActivity: [],
      taskSessions: [],
      agents: [],
      agentCredentials: [],
      agentSessions: [],
      agentChannels: [],
      agentChannelMembers: [],
      agentMessages: [],
      terminalFrames: [],
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

  function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeProject) return
    const formData = new FormData(event.currentTarget)
    const title = String(formData.get("title") ?? "").trim()
    if (!title) return

    const status = String(formData.get("status") ?? "not_started") as ColumnId
    const priority = String(formData.get("priority") ?? "P1") as Priority
    const owner = String(formData.get("owner") ?? "Unassigned").trim() || "Unassigned"
    const operatorName = String(formData.get("operatorName") ?? "human").trim() || "human"
    const due = String(formData.get("due") ?? "Unscheduled").trim() || "Unscheduled"
    const estimate = String(formData.get("estimate") ?? "1h").trim() || "1h"
    const description = String(formData.get("description") ?? "").trim()
    const notes = String(formData.get("notes") ?? "").trim()
    const review = String(formData.get("review") ?? "No review gate defined.").trim() || "No review gate defined."
    const tags = String(formData.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)

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
      operator: "human",
      operatorName,
      estimate,
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
        assignee_label: owner,
        due_at: null,
      })
        .then((createdTask) => {
          const [mappedTask] = mapLiveTasks([createdTask])
          setTasks((currentTasks) => [mappedTask, ...currentTasks.filter((task) => task.id !== newTask.id)])
          setSelectedTaskId(mappedTask.id)
          setOpenTaskId(mappedTask.id)
        })
        .catch((error) => {
          setLiveSyncError(error instanceof Error ? error.message : "Could not create the live task.")
        })
    }
  }

  function applyLiveTaskRow(taskRow: TaskflowWorkspace["tasks"][number]) {
    const [mappedTask] = mapLiveTasks([taskRow])
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
      void updateTaskflowTask(reviewTaskIdNumber, {
        status: toLiveStatus(next),
      }).catch((error) => {
        setLiveSyncError(error instanceof Error ? error.message : "Could not persist the review decision.")
      })
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
          <Button variant="outline" size="sm" onClick={() => void loadLiveWorkspace(activeProjectId)} disabled={isLiveSyncing}>
            <BellIcon />
            {isLiveSyncing ? "Syncing" : usesLiveApi ? "Live" : "Sync"}
          </Button>
          {activeProject ? (
            <Button size="sm" onClick={() => setDialogMode("new-task")}>
              <PlusIcon />
              New Task
            </Button>
          ) : null}
        </header>

        <main className="h-[calc(100svh-3.5rem)] min-h-0 flex-1 overflow-y-auto bg-[linear-gradient(180deg,var(--background),var(--muted))]">
          <Routes>
            <Route path="/dashboard" element={<Navigate to="/dashboard/board" replace />} />
            <Route path="/dashboard/board" element={!activeProject ? (
          <NoProjectEmptyState onNewProject={() => setDialogMode("new-project")} syncing={isLiveSyncing} />
        ) : (
          <section className="grid gap-5 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-w-0 space-y-5">
              <div className="rounded-lg border bg-card p-4 shadow-sm">
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
                    <MarkdownRenderer
                      content={activeProject.objective}
                      compact
                      className="mt-3 max-w-2xl [&_p]:text-sm [&_p]:leading-6"
                    />
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

              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Project Board</h2>
                  <p className="text-sm text-muted-foreground">{activeProject.apiBase}</p>
                </div>
                <div className="hidden items-center gap-2 md:flex">
                  <Button variant="outline" size="sm">
                    <TimerIcon />
                    Focus
                  </Button>
                  <Button variant="outline" size="sm">
                    <ActivityIcon />
                    Activity
                  </Button>
                </div>
              </div>

              <div className="min-h-[34rem] overflow-x-auto pb-2">
                <div className="grid min-w-[1040px] grid-cols-5 gap-3">
                  {columns.map((column) => {
                    const columnTasks = projectTasks.filter((task) => task.status === column.id)
                    const ColumnIcon = column.icon
                    return (
                      <div
                        key={column.id}
                        className={cn(
                          "flex min-h-[32rem] flex-col rounded-lg border bg-card/75 transition",
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
                        <div className="flex items-center justify-between gap-2 border-b px-3 py-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className={cn("inline-flex size-7 items-center justify-center rounded-md ring-1", column.tone)}>
                              <ColumnIcon className="size-3.5" />
                            </span>
                            <div className="min-w-0">
                              <h3 className="truncate text-sm font-semibold">{column.title}</h3>
                              <p className="text-xs text-muted-foreground">{columnTasks.length} tasks</p>
                            </div>
                          </div>
                          <Button variant="ghost" size="icon-sm">
                            <MoreHorizontalIcon />
                          </Button>
                        </div>
                        <div className="relative flex flex-1 flex-col gap-2 p-2">
                          {draggedTaskId && dropTarget?.columnId === column.id && dropTarget.taskId === null ? (
                            <EndDropIndicator label={`Drop at end of ${column.title}`} />
                          ) : null}
                          {columnTasks.map((task) => (
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

            <aside className="space-y-4">
              <ProjectControls
                project={activeProject}
                onEditProject={() => setDialogMode("edit-project")}
                onNewTask={() => setDialogMode("new-task")}
                onInvite={() => setDialogMode("invite")}
                onContract={() => setDialogMode("api-contract")}
              />
              <AgentRoom agents={activeLiveWorkspace?.agents ?? []} onMessage={() => navigate("/dashboard/agents")} />
              <ReviewQueue
                tasks={projectTasks.filter((task) => task.status === "review")}
                onReview={(taskId) => {
                  setReviewTaskId(taskId)
                  setDialogMode("review-decision")
                }}
              />
              <InvitePanel invites={projectInviteRecords} onInvite={() => setDialogMode("invite")} />
              <ActivityPanel events={activityEvents} />
            </aside>
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
                    onMessage={() => navigate("/dashboard/agents")}
                  />
                ) : (
                  <NoProjectEmptyState onNewProject={() => setDialogMode("new-project")} syncing={isLiveSyncing} />
                )
              }
            />
            <Route
              path="/dashboard/reviews"
              element={
                activeProject ? (
                  <ReviewsPage
                    tasks={projectTasks.filter((task) => task.status === "review")}
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
                  <ActivityLogPage title="Activity" events={activityEvents} />
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
      {openTask && activeProject ? (
        <TaskDetailSheet
          task={openTask}
          project={activeProject}
          projectTasks={projectTasks}
          liveWorkspace={activeLiveWorkspace}
          onClose={() => setOpenTaskId(null)}
          onMove={(status) => moveTask(openTask.id, status)}
          onOpenTask={(taskId) => openTaskDetails(taskId)}
          onOpenReview={() => {
            setReviewTaskId(openTask.id)
            setDialogMode("review-decision")
          }}
          onOpenMessage={() => navigate("/dashboard/agents")}
          onStartSession={handleStartTaskSession}
          onPauseSession={handlePauseTaskSession}
          onStopSession={handleStopTaskSession}
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
        key={dialogMode ?? "closed"}
        mode={dialogMode}
        activeProject={activeProject}
        reviewTask={reviewTask}
        onClose={() => {
          setDialogMode(null)
          setReviewTaskId(null)
        }}
        onCreateTask={handleCreateTask}
        onCreateProject={handleCreateProject}
        onUpdateProject={handleUpdateProject}
        onCreateInvite={handleCreateInvite}
        onReviewDecision={handleReviewDecision}
      />
    </SidebarProvider>
  )
}

function LandingPage() {
  const [landingUser, setLandingUser] = useState<AuthUser | null>(() =>
    hasStoredAuthSession() ? getStoredUser() : null
  )
  const isLoggedIn = Boolean(landingUser)
  const landingFeatures = [
    {
      icon: KanbanSquareIcon,
      title: "Project boards with real state",
      detail: "Plan work by project, drag tasks through review gates, and keep every agent anchored to the same board.",
    },
    {
      icon: MessageSquareIcon,
      title: "One room for people and agents",
      detail: "Group chats, direct agent threads, terminal views, and human decisions sit beside the work they affect.",
    },
    {
      icon: FileJsonIcon,
      title: "API-first from the start",
      detail: "The UI is ready for a live API, project keys, session records, and taskflow.json based agent identity.",
    },
    {
      icon: ShieldCheckIcon,
      title: "Human approval built in",
      detail: "Invite developers, link agents to owners, require auth, and keep review outcomes visible in task history.",
    },
  ]
  const workflow = [
    "Create a project and invite the right humans or agents.",
    "Agents connect with a display name, identifier, project key, and session metadata.",
    "Work happens on the board while chats, terminal output, sessions, and review gates stay attached.",
  ]
  useEffect(() => {
    if (!hasStoredAuthSession()) return

    let active = true
    fetchCurrentUser().then((user) => {
      if (!active) return
      setLandingUser(user)
    })

    return () => {
      active = false
    }
  }, [])

  const handleLandingLogout = async () => {
    await logoutUser()
    setLandingUser(null)
  }

  return (
    <main className="min-h-svh bg-background text-foreground">
      <section className="relative min-h-[88svh] overflow-hidden border-b pt-16">
        <img
          src="/landing/dashboard.png"
          alt=""
          className="absolute inset-0 size-full object-cover object-center opacity-40 saturate-[0.92]"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, var(--background) 0%, color-mix(in oklab, var(--background) 94%, transparent) 46%, color-mix(in oklab, var(--background) 62%, transparent) 100%)",
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-36 bg-[linear-gradient(180deg,transparent,var(--background))]" />

        <LandingNav user={landingUser} onLogout={handleLandingLogout} />

        <div className="relative z-10 mx-auto flex min-h-[calc(88svh-8.5rem)] w-full max-w-7xl items-center px-4 pb-12 pt-8 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border bg-background/75 px-3 py-1 text-xs font-semibold text-muted-foreground shadow-sm backdrop-blur">
              <BotIcon className="size-3.5 text-primary" />
              API-ready project management for humans and coding agents
            </div>
            <h1 className="mt-6 text-5xl font-semibold tracking-normal text-foreground sm:text-6xl lg:text-7xl">
              TaskFlow
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
              Run project boards, agent rooms, task sessions, invites, review gates, and API configuration from one
              workspace. It keeps the v1 local-first discipline, then opens the door for live collaboration and proper
              identity.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                to={isLoggedIn ? "/dashboard/board" : "/signup"}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                {isLoggedIn ? "Open Dashboard" : "Start Workspace"}
                <ArrowRightIcon className="size-4" />
              </Link>
              {isLoggedIn ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleLandingLogout()
                  }}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-md border bg-background/75 px-5 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-accent"
                >
                  Log Out
                </button>
              ) : (
                <Link
                  to="/login"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-md border bg-background/75 px-5 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-accent"
                >
                  Log In
                </Link>
              )}
            </div>
            <dl className="mt-10 grid max-w-2xl grid-cols-3 gap-3">
              {[
                ["31", "agent tools from v1"],
                ["1", "shared project view"],
                ["API", "first v2 shell"],
              ].map(([value, label]) => (
                <div key={label} className="border-l pl-3">
                  <dt className="text-2xl font-semibold text-foreground">{value}</dt>
                  <dd className="mt-1 text-xs leading-4 text-muted-foreground">{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section id="features" className="border-b bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-normal text-primary">Built from the v1 lessons</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-normal text-foreground">
              Less context switching, clearer project control.
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              The new UI treats TaskFlow as the operating surface for project work. Boards, history, sessions, agents,
              invites, and API setup are visible without asking users to jump between disconnected screens.
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {landingFeatures.map((feature) => {
              const Icon = feature.icon

              return (
                <article key={feature.title} className="rounded-lg border bg-card p-4 shadow-sm">
                  <div className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold">{feature.title}</h3>
                  <MarkdownRenderer
                    content={feature.detail}
                    compact
                    className="mt-2 [&_p]:text-sm [&_p]:leading-6"
                  />
                </article>
              )
            })}
          </div>
        </div>
      </section>

      <section className="bg-muted/45 px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-primary">Collaboration flow</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-normal">Designed for teams with agents in the loop.</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Every agent session can be tied to the user who linked it, the project where it works, and the identifier
              it uses when returning later. The UI keeps that relationship visible before the backend API lands.
            </p>
          </div>

          <div className="rounded-lg border bg-background p-3 shadow-sm">
            {workflow.map((item, index) => (
              <div key={item} className="grid grid-cols-[2rem_1fr] gap-3 border-b py-4 last:border-b-0">
                <div className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {index + 1}
                </div>
                <div>
                  <p className="text-sm font-semibold">{item}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {index === 0
                      ? "Roles, scopes, and pending auth stay visible to the project owner."
                      : index === 1
                        ? "The API page already models connected, waiting, stale, and revoked agent sessions."
                        : "The board becomes the shared source of truth for work, communication, and review."}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}

function LandingNav({ user, onLogout }: { user: AuthUser | null; onLogout: () => void }) {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b bg-background/94 shadow-sm backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
      <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <KanbanSquareIcon className="size-4" />
        </span>
        TaskFlow
      </Link>
      <nav className="hidden items-center gap-5 text-sm font-medium text-muted-foreground md:flex">
        <a href="#features" className="transition-colors hover:text-foreground">
          Features
        </a>
        <Link to="/dashboard/board" className="transition-colors hover:text-foreground">
          Workspace
        </Link>
        <Link to="/dashboard/api" className="transition-colors hover:text-foreground">
          API
        </Link>
      </nav>
      {user ? (
        <div className="flex min-w-0 items-center gap-2">
          <div className="hidden min-w-0 items-center gap-2 rounded-md border bg-muted/50 px-2.5 py-1.5 sm:flex">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/20">
              {user.username.slice(0, 2).toUpperCase()}
            </span>
            <span className="max-w-36 truncate text-sm font-medium">{user.username}</span>
          </div>
          <Link
            to="/dashboard/board"
            className="inline-flex h-9 items-center rounded-md bg-foreground px-3 text-sm font-semibold text-background shadow-sm transition-colors hover:bg-foreground/90"
          >
            Dashboard
          </Link>
          <button
            type="button"
            onClick={() => {
              void onLogout()
            }}
            className="hidden h-9 items-center rounded-md px-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground md:inline-flex"
          >
            Log Out
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Link
            to="/login"
            className="hidden h-9 items-center rounded-md px-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            Log In
          </Link>
        <Link
          to="/signup"
          className="inline-flex h-9 items-center rounded-md bg-foreground px-3 text-sm font-semibold text-background shadow-sm transition-colors hover:bg-foreground/90"
        >
          Sign Up
        </Link>
        </div>
      )}
      </div>
    </header>
  )
}

function AuthPage({ mode }: { mode: AuthMode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const resetTokenFromUrl = new URLSearchParams(location.search).get("token") ?? ""
  const [authResult, setAuthResult] = useState<AuthResult | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isLogin = mode === "login"
  const isSignup = mode === "signup"
  const isReset = mode === "reset"
  const title = isLogin
    ? "Log in to TaskFlow"
    : isSignup
      ? "Create your workspace"
      : isReset
        ? "Reset your password"
        : "Confirm your new password"
  const description = isLogin
    ? "Return to your project boards, agent rooms, sessions, and pending review gates."
    : isSignup
      ? "Set up the account that will own project invites, agent links, and API access."
      : isReset
        ? "Enter the email tied to your workspace and the API will send recovery instructions."
        : "Choose the password that will protect your workspace and linked agent sessions."
  const submitLabel = isLogin
    ? "Log In"
    : isSignup
      ? "Create Account"
      : isReset
        ? "Send Reset Link"
        : "Update Password"
  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthResult(null)
    setIsSubmitting(true)

    const formData = new FormData(event.currentTarget)
    let result: AuthResult

    if (isLogin) {
      result = await loginUser({
        username: String(formData.get("username") ?? "").trim(),
        password: String(formData.get("password") ?? ""),
      })
      setAuthResult(result)
      setIsSubmitting(false)
      if (result.ok) {
        const nextPath = new URLSearchParams(location.search).get("next")
        navigate(nextPath?.startsWith("/dashboard") ? nextPath : "/dashboard/board")
      }
      return
    }

    if (isSignup) {
      result = await registerUser({
        username: String(formData.get("username") ?? "").trim(),
        email: String(formData.get("email") ?? "").trim(),
        password: String(formData.get("password") ?? ""),
      })
      setAuthResult(result)
      setIsSubmitting(false)
      return
    }

    if (isReset) {
      result = await requestPasswordReset(String(formData.get("email") ?? "").trim())
      setAuthResult(result)
      setIsSubmitting(false)
      return
    }

    const newPassword = String(formData.get("new-password") ?? "")
    const confirmPassword = String(formData.get("confirm-password") ?? "")
    const token = String(formData.get("token") ?? "").trim()

    if (newPassword !== confirmPassword) {
      setAuthResult({ ok: false, message: "Passwords do not match." })
      setIsSubmitting(false)
      return
    }

    result = await confirmPasswordReset({ token, newPassword })
    setAuthResult(result)
    setIsSubmitting(false)
  }

  return (
    <main className="grid min-h-svh bg-background text-foreground lg:grid-cols-[minmax(0,1fr)_minmax(28rem,34rem)]">
      <section className="relative hidden overflow-hidden border-r lg:block">
        <img
          src="/landing/dashboard.png"
          alt=""
          className="absolute inset-0 size-full object-cover object-left opacity-50 saturate-[0.9]"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in oklab, var(--background) 88%, transparent), color-mix(in oklab, var(--primary) 24%, transparent)), linear-gradient(90deg, var(--background), transparent)",
          }}
        />
        <div className="relative z-10 flex h-full flex-col justify-between p-8">
          <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <KanbanSquareIcon className="size-4" />
            </span>
            TaskFlow
          </Link>
          <div className="max-w-lg pb-8">
            <p className="text-sm font-semibold uppercase tracking-normal text-primary">API-ready workspace</p>
            <h1 className="mt-4 text-4xl font-semibold tracking-normal">
              Auth that can own projects, invites, and agent identity.
            </h1>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Users authenticate first, then link agents, manage project keys, and return to the same project context
              across sessions.
            </p>
          </div>
        </div>
      </section>

      <section className="flex min-h-svh items-center justify-center px-4 py-8 sm:px-6">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-8 flex items-center gap-2 text-sm font-semibold lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <KanbanSquareIcon className="size-4" />
            </span>
            TaskFlow
          </Link>

          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div>
              <p className="text-sm font-semibold uppercase tracking-normal text-primary">
                {isReset || mode === "confirm" ? "Account Recovery" : "Workspace Access"}
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-normal">{title}</h2>
              <MarkdownRenderer
                content={description}
                compact
                className="mt-2 [&_p]:text-sm [&_p]:leading-6"
              />
            </div>

            {(isLogin || isSignup) && <SocialAuthButtons />}

            {authResult ? <AuthNotice result={authResult} /> : null}

            <form className="mt-5 space-y-4" onSubmit={handleAuthSubmit}>
              {isSignup && (
                <>
                  <AuthTextInput label="Username" name="username" autoComplete="username" placeholder="ada" />
                  <AuthTextInput
                    label="Workspace name"
                    name="workspace"
                    autoComplete="organization"
                    placeholder="Automation Lab"
                    required={false}
                  />
                </>
              )}

              {isLogin && (
                <AuthTextInput
                  label="Username"
                  name="username"
                  autoComplete="username"
                  placeholder="ada"
                />
              )}

              {(isSignup || isReset) && (
                <AuthTextInput
                  label="Email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                />
              )}

              {(isLogin || isSignup) && (
                <AuthTextInput
                  label="Password"
                  name="password"
                  type="password"
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  placeholder="At least 8 characters"
                />
              )}

              {mode === "confirm" && (
                <>
                  <AuthTextInput
                    label="Reset token"
                    name="token"
                    autoComplete="one-time-code"
                    placeholder="Paste the reset token"
                    defaultValue={resetTokenFromUrl}
                  />
                  <AuthTextInput
                    label="New password"
                    name="new-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                  />
                  <AuthTextInput
                    label="Confirm password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Repeat your new password"
                  />
                </>
              )}

              {isLogin && (
                <div className="flex justify-end">
                  <Link to="/reset-password" className="text-sm font-medium text-primary hover:underline">
                    Forgot password?
                  </Link>
                </div>
              )}

              <Button className="w-full" size="lg" type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Working..." : submitLabel}
                <ArrowRightIcon />
              </Button>
            </form>

            <AuthFooter mode={mode} />
          </div>
        </div>
      </section>
    </main>
  )
}

function SocialAuthButtons() {
  return (
    <div className="mt-5 grid gap-2 sm:grid-cols-2">
      <Button type="button" variant="outline" className="w-full justify-center">
        <span className="flex size-4 items-center justify-center rounded-full bg-foreground text-[0.6rem] font-bold text-background">
          GH
        </span>
        GitHub
      </Button>
      <Button type="button" variant="outline" className="w-full justify-center">
        <span className="flex size-4 items-center justify-center rounded-full border text-[0.65rem] font-bold text-primary">
          G
        </span>
        Google
      </Button>
    </div>
  )
}

function AuthNotice({ result }: { result: AuthResult }) {
  return (
    <div
      className={cn(
        "mt-5 rounded-lg border px-3 py-2.5 text-sm leading-5",
        result.ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-rose-200 bg-rose-50 text-rose-800"
      )}
      role="status"
    >
      {result.message}
    </div>
  )
}

function AuthGateScreen() {
  return (
    <main className="grid min-h-svh place-items-center bg-background px-4 text-foreground">
      <section className="w-full max-w-sm rounded-lg border bg-card p-5 text-center shadow-sm">
        <span className="mx-auto flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
          <LockIcon className="size-5" />
        </span>
        <h1 className="mt-4 text-lg font-semibold">Checking workspace access</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Validating your session before opening the dashboard.
        </p>
      </section>
    </main>
  )
}

function AuthTextInput({
  label,
  name,
  type = "text",
  autoComplete,
  placeholder,
  defaultValue,
  required = true,
}: {
  label: string
  name: string
  type?: string
  autoComplete?: string
  placeholder?: string
  defaultValue?: string
  required?: boolean
}) {
  return (
    <label className="block text-sm font-medium">
      <span>{label}</span>
      <Input
        required={required}
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="mt-2"
      />
    </label>
  )
}

function AuthFooter({ mode }: { mode: AuthMode }) {
  if (mode === "login") {
    return (
      <p className="mt-5 text-center text-sm text-muted-foreground">
        New to TaskFlow?{" "}
        <Link to="/signup" className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    )
  }

  if (mode === "signup") {
    return (
      <p className="mt-5 text-center text-sm text-muted-foreground">
        Already have access?{" "}
        <Link to="/login" className="font-medium text-primary hover:underline">
          Log in
        </Link>
      </p>
    )
  }

  return (
    <p className="mt-5 text-center text-sm text-muted-foreground">
      Remember your credentials?{" "}
      <Link to="/login" className="font-medium text-primary hover:underline">
        Back to login
      </Link>
    </p>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="text-2xl font-semibold">{value}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      </div>
    </div>
  )
}

function TaskCard({
  task,
  selected,
  dragging,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMoveNext,
  onMovePrevious,
}: {
  task: Task
  selected: boolean
  dragging: boolean
  onSelect: () => void
  onDragStart: () => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onMoveNext: () => void
  onMovePrevious: () => void
}) {
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      className={cn(
        "group rounded-lg border bg-background p-3 shadow-sm transition-colors hover:border-primary/35 hover:shadow-md",
        selected && "border-primary/60 ring-2 ring-primary/15",
        dragging && "opacity-55"
      )}
    >
      <div className="flex items-start gap-2">
        <GripVerticalIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("rounded-full px-2 py-0.5 text-[0.68rem] font-semibold ring-1", priorityClass(task.priority))}>
              {task.priority}
            </span>
            <span className="truncate text-xs text-muted-foreground">{task.updated}</span>
          </div>
          <h4 className="mt-2 text-sm font-semibold leading-5">{task.title}</h4>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {task.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="rounded-md bg-muted px-1.5 py-1 text-[0.68rem] font-medium text-muted-foreground">
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar size="sm">
            <AvatarFallback>{task.ownerInitials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{task.owner}</p>
            <p className="truncate text-[0.68rem] text-muted-foreground">{task.operatorName}</p>
          </div>
        </div>
        <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(event) => {
              event.stopPropagation()
              onMovePrevious()
            }}
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(event) => {
              event.stopPropagation()
              onMoveNext()
            }}
          >
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </article>
  )
}

function DropIndicator({ label, position }: { label: string; position: "before" | "after" }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-0 right-0 z-20 flex h-0 items-center",
        position === "before" ? "-top-1" : "-bottom-1"
      )}
      aria-label={label}
    >
      <div className="h-0.5 flex-1 rounded-full bg-primary shadow-[0_0_0_3px_oklch(0.54_0.16_238_/_0.14)]" />
      <span className="mx-2 rounded-full bg-primary px-2 py-0.5 text-[0.65rem] font-semibold text-primary-foreground shadow-sm">
        Drop here
      </span>
      <div className="h-0.5 flex-1 rounded-full bg-primary shadow-[0_0_0_3px_oklch(0.54_0.16_238_/_0.14)]" />
    </div>
  )
}

function EndDropIndicator({ label }: { label: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-2 bottom-2 z-20 flex h-10 items-center justify-center rounded-lg border border-dashed border-primary/60 bg-primary/10 px-3 text-xs font-medium text-primary"
      aria-label={label}
    >
      Drop at end
    </div>
  )
}

function TaskDetailSheet({
  task,
  project,
  projectTasks,
  liveWorkspace,
  onClose,
  onMove,
  onOpenTask,
  onOpenReview,
  onOpenMessage,
  onStartSession,
  onPauseSession,
  onStopSession,
}: {
  task: Task
  project: Project
  projectTasks: Task[]
  liveWorkspace?: TaskflowWorkspace | null
  onClose: () => void
  onMove: (status: ColumnId) => void
  onOpenTask: (taskId: string) => void
  onOpenReview: () => void
  onOpenMessage: () => void
  onStartSession: (task: Task) => void
  onPauseSession: (task: Task) => void
  onStopSession: (task: Task, finalStatus: Extract<TaskflowTaskStatus, "done" | "partial_done" | "blocked">) => void
}) {
  const currentStatus = columns.find((column) => column.id === task.status)
  const sessions = liveWorkspace ? getLiveTaskSessions(task, liveWorkspace) : getTaskSessions(task)
  const runningSession = liveWorkspace ? getRunningLiveTaskSession(task, liveWorkspace) : undefined
  const totalSessionSeconds = liveWorkspace ? getTaskSessionTotalSeconds(task, liveWorkspace) : null
  const relations = liveWorkspace ? getLiveTaskRelations(task, projectTasks, liveWorkspace) : getTaskRelations(task, projectTasks)
  const activity = liveWorkspace ? getLiveTaskActivity(task, liveWorkspace) : getFallbackTaskActivity(task)
  const links = getTaskLinks(task, project)
  const description = getTaskDescription(task)
  const notes = getTaskNotes(task)

  return (
    <>
      <button
        type="button"
        aria-label="Close task details"
        className="fixed inset-0 z-40 bg-foreground/10"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${task.title} details`}
        className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-[1.35rem] border bg-card shadow-2xl sm:inset-auto sm:bottom-4 sm:right-4 sm:top-4 sm:w-[min(54rem,calc(100vw-2rem))] sm:border-x sm:border-b"
      >
        <header
          className="relative shrink-0 overflow-hidden px-5 pb-7 pt-5"
          style={{
            background:
              "radial-gradient(circle at 18% 0%, color-mix(in oklab, var(--primary) 30%, transparent), transparent 34%), linear-gradient(180deg, color-mix(in oklab, var(--primary) 16%, transparent), transparent 74%)",
          }}
        >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-[linear-gradient(180deg,transparent,var(--card))]" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{task.id}</p>
                <span className="rounded-full bg-background/75 px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border/80">
                  {project.name}
                </span>
              </div>
              <h2 className="mt-2 max-w-2xl text-2xl font-semibold leading-8">{task.title}</h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold ring-1", priorityClass(task.priority))}>
                  {task.priority}
                </span>
                <span className="rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground ring-1 ring-border">
                  {currentStatus?.title}
                </span>
                <span className="rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground ring-1 ring-border">
                  {task.updated}
                </span>
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <XIcon />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="space-y-4">
              <section className="rounded-lg border bg-background p-4">
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <Info label="Owner" value={task.owner} />
                  <Info label="Due" value={task.due} />
                  <Info label="Estimate" value={task.estimate} />
                  <Info label="Operator" value={task.operatorName} />
                </div>
              </section>

              <TaskDetailSection
                icon={<FileTextIcon className="size-4 text-primary" />}
                title="Description"
              >
                <MarkdownRenderer content={description} />
              </TaskDetailSection>

              <TaskDetailSection
                icon={<MessageSquareIcon className="size-4 text-primary" />}
                title="Notes"
              >
                <MarkdownRenderer content={notes} />
              </TaskDetailSection>

              <TaskDetailSection
                icon={<ShieldCheckIcon className="size-4 text-amber-700" />}
                title="Human Review Gate"
                action={
                  <Button size="sm" onClick={onOpenReview}>
                    <ClipboardCheckIcon />
                    Decide
                  </Button>
                }
              >
                <MarkdownRenderer content={task.review} />
              </TaskDetailSection>

              <TaskDetailSection
                icon={<GitBranchIcon className="size-4 text-primary" />}
                title="Task Relations"
              >
                <div className="space-y-2">
                  {relations.length ? (
                    relations.map((relation) => (
                      <TaskRelationRow key={relation.id} relation={relation} onOpenTask={onOpenTask} />
                    ))
                  ) : (
                    <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                      No live task relations have been linked yet.
                    </p>
                  )}
                </div>
              </TaskDetailSection>

              <TaskDetailSection
                icon={<TimerIcon className="size-4 text-primary" />}
                title="Sessions"
                action={
                  liveWorkspace ? (
                    <TaskSessionControls
                      task={task}
                      hasRunningSession={Boolean(runningSession)}
                      onStartSession={onStartSession}
                      onPauseSession={onPauseSession}
                      onStopSession={onStopSession}
                    />
                  ) : undefined
                }
              >
                {totalSessionSeconds != null ? (
                  <div className="mb-3 grid gap-2 rounded-lg border bg-muted/35 p-3 text-sm sm:grid-cols-3">
                    <Info label="Total focus" value={formatDuration(totalSessionSeconds)} />
                    <Info label="Sessions" value={String(sessions.length)} />
                    <Info label="Current" value={runningSession ? "Running" : "Idle"} />
                  </div>
                ) : null}
                <div className="space-y-2">
                  {sessions.length ? (
                    sessions.map((session) => (
                      <TaskSessionRow key={session.id} session={session} />
                    ))
                  ) : (
                    <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                      No live sessions are attached to this task yet.
                    </p>
                  )}
                </div>
              </TaskDetailSection>

              <TaskDetailSection
                icon={<ActivityIcon className="size-4 text-primary" />}
                title="Activity"
              >
                <div className="space-y-3">
                  {activity.length ? (
                    activity.map((event) => (
                      <div key={event.id} className="flex gap-3">
                        <Clock3Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <MarkdownRenderer content={event.detail} compact className="[&_p]:text-sm" />
                          <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span>{event.actor}</span>
                            <span>{event.action.replace(/_/g, " ")}</span>
                            <span>{event.time}</span>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                      No live activity has been recorded for this task yet.
                    </p>
                  )}
                </div>
              </TaskDetailSection>
            </div>

            <aside className="space-y-3">
              <section className="rounded-lg border bg-background p-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <LockIcon className="size-4 text-primary" />
                  Agent Access
                </div>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Authenticate the workspace before linking agents, claims, or external accounts.
                </p>
                <div className="mt-3 grid gap-2">
                  <Button size="sm">
                    <ShieldCheckIcon />
                    Authenticate
                  </Button>
                  <Button variant="outline" size="sm" disabled>
                    <BotIcon />
                    Link Agent
                  </Button>
                  <Button variant="outline" size="sm" onClick={onOpenMessage}>
                    <MessageSquareIcon />
                    Message Room
                  </Button>
                </div>
              </section>

              <section className="rounded-lg border bg-background p-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <LinkIcon className="size-4 text-primary" />
                  Links
                </div>
                <div className="mt-3 space-y-2">
                  {links.map((link) => (
                    <TaskLinkRow key={link.label} link={link} />
                  ))}
                </div>
              </section>

              <section className="rounded-lg border bg-background p-3">
                <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Move Task</p>
                <div className="mt-3 grid gap-2">
                  {columns.map((column) => (
                    <MoveTaskButton
                      key={column.id}
                      column={column}
                      active={task.status === column.id}
                      onClick={() => onMove(column.id)}
                    />
                  ))}
                </div>
              </section>

              <section className="rounded-lg border bg-background p-3">
                <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Tags</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {task.tags.map((tag) => (
                    <span key={tag} className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-background px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onMove("blocked")}>
            <PauseIcon />
            Put On Hold
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" onClick={() => onMove(nextStatus(task.status))}>
              <ArrowRightIcon />
              Move Forward
            </Button>
          </div>
        </footer>
      </section>
    </>
  )
}

function TaskDetailSection({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function TaskRelationRow({
  relation,
  onOpenTask,
}: {
  relation: TaskRelation
  onOpenTask?: (taskId: string) => void
}) {
  const content = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{relation.title}</p>
          <MarkdownRenderer content={relation.detail} compact className="mt-1" />
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", relationTone(relation.type))}>
            {relation.type}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {statusLabel(relation.status)}
          </span>
          {relation.taskId ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary ring-1 ring-primary/20">
              Open
              <ArrowRightIcon className="size-3" />
            </span>
          ) : null}
        </div>
      </div>
    </>
  )

  if (relation.taskId && onOpenTask) {
    return (
      <button
        type="button"
        className="block w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/45 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpenTask(relation.taskId!)}
      >
        {content}
      </button>
    )
  }

  return (
    <div className="rounded-lg border bg-card p-3">
      {content}
    </div>
  )
}

function TaskSessionControls({
  task,
  hasRunningSession,
  onStartSession,
  onPauseSession,
  onStopSession,
}: {
  task: Task
  hasRunningSession: boolean
  onStartSession: (task: Task) => void
  onPauseSession: (task: Task) => void
  onStopSession: (task: Task, finalStatus: Extract<TaskflowTaskStatus, "done" | "partial_done" | "blocked">) => void
}) {
  if (!hasRunningSession) {
    return (
      <Button size="sm" onClick={() => onStartSession(task)}>
        <PlayIcon />
        Start
      </Button>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => onPauseSession(task)}>
        <PauseIcon />
        Pause
      </Button>
      <Button variant="outline" size="sm" onClick={() => onStopSession(task, "partial_done")}>
        <ClipboardCheckIcon />
        Review
      </Button>
      <Button variant="outline" size="sm" onClick={() => onStopSession(task, "blocked")}>
        <AlertCircleIcon />
        Block
      </Button>
      <Button size="sm" onClick={() => onStopSession(task, "done")}>
        <CheckIcon />
        Done
      </Button>
    </div>
  )
}

function TaskSessionDock({
  tasks,
  liveWorkspace,
  onOpenTask,
  onStartSession,
  onPauseSession,
  onStopSession,
}: {
  tasks: Task[]
  liveWorkspace?: TaskflowWorkspace | null
  onOpenTask: (taskId: string) => void
  onStartSession: (task: Task) => void
  onPauseSession: (task: Task) => void
  onStopSession: (task: Task, finalStatus: Extract<TaskflowTaskStatus, "done" | "partial_done" | "blocked">) => void
}) {
  const [tick, setTick] = useState(0)
  const taskById = useMemo(() => new Map(tasks.map((task) => [Number(task.id), task])), [tasks])
  const runningSessions = liveWorkspace
    ? liveWorkspace.taskSessions
        .filter((session) => session.state === "running" && !session.ended_at)
        .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
    : []
  const runningTaskIds = new Set(runningSessions.map((session) => session.task))
  const pausedTasks = liveWorkspace
    ? liveWorkspace.tasks
        .filter((task) => task.status === "paused" && !runningTaskIds.has(task.id))
        .map((task) => taskById.get(task.id))
        .filter((task): task is Task => Boolean(task))
    : []

  useEffect(() => {
    if (!runningSessions.length) return
    const interval = window.setInterval(() => setTick((current) => current + 1), 1000)
    return () => window.clearInterval(interval)
  }, [runningSessions.length])

  if (!liveWorkspace || (!runningSessions.length && !pausedTasks.length)) return null

  return (
    <section className="fixed inset-x-3 bottom-3 z-[65] mx-auto flex max-w-5xl items-center gap-2 overflow-hidden rounded-xl border bg-background/95 p-2 shadow-2xl backdrop-blur">
      <div className="hidden shrink-0 items-center gap-2 px-2 text-xs font-semibold text-muted-foreground sm:flex">
        <TimerIcon className="size-4 text-primary" />
        Sessions
      </div>
      <div className="scrollbar-y flex min-w-0 flex-1 gap-2 overflow-x-auto">
        {runningSessions.map((session) => {
          const task = taskById.get(session.task)
          if (!task) return null
          void tick
          return (
            <div key={session.id} className="flex min-w-72 items-center gap-3 rounded-lg border bg-card px-3 py-2">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenTask(task.id)}>
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_oklch(0.72_0.14_155_/_0.16)]" />
                  <p className="truncate text-sm font-medium">{task.title}</p>
                </div>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {formatDuration(sessionDurationSeconds(session))} running
                </p>
              </button>
              <Button variant="ghost" size="icon-sm" onClick={() => onPauseSession(task)}>
                <PauseIcon />
              </Button>
              <Button size="icon-sm" onClick={() => onStopSession(task, "done")}>
                <CheckIcon />
              </Button>
            </div>
          )
        })}
        {pausedTasks.map((task) => (
          <div key={task.id} className="flex min-w-64 items-center gap-3 rounded-lg border bg-card px-3 py-2 opacity-85">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenTask(task.id)}>
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-amber-500" />
                <p className="truncate text-sm font-medium">{task.title}</p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDuration(getTaskSessionTotalSeconds(task, liveWorkspace))} paused
              </p>
            </button>
            <Button size="icon-sm" onClick={() => onStartSession(task)}>
              <PlayIcon />
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}

function TaskSessionRow({ session }: { session: TaskSession }) {
  const tone =
    session.state === "active"
      ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
      : session.state === "paused"
        ? "bg-amber-100 text-amber-800 ring-amber-200"
        : "bg-slate-100 text-slate-700 ring-slate-200"

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{session.actor}</p>
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize ring-1", tone)}>
              {session.state}
            </span>
          </div>
          <MarkdownRenderer content={session.detail} compact className="mt-1" />
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-2 text-right text-xs">
          <span className="text-muted-foreground">Started</span>
          <span className="font-medium">{session.started}</span>
          <span className="text-muted-foreground">Duration</span>
          <span className="font-medium">{session.duration}</span>
        </div>
      </div>
    </div>
  )
}

function TaskLinkRow({ link }: { link: TaskLink }) {
  return (
    <div className="rounded-lg bg-muted/60 p-2.5">
      <p className="text-xs font-semibold text-foreground">{link.label}</p>
      <p className="mt-1 break-all text-[0.72rem] leading-4 text-muted-foreground">{link.value}</p>
      <MarkdownRenderer content={link.detail} compact className="mt-1" />
    </div>
  )
}

function MoveTaskButton({
  column,
  active,
  onClick,
}: {
  column: (typeof columns)[number]
  active: boolean
  onClick: () => void
}) {
  const Icon = column.icon
  return (
    <Button variant={active ? "default" : "outline"} size="sm" onClick={onClick}>
      <Icon />
      {column.title}
    </Button>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background p-2.5">
      <p className="text-[0.68rem] font-medium uppercase tracking-normal text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium">{value}</p>
    </div>
  )
}

function ProjectControls({
  project,
  onEditProject,
  onNewTask,
  onInvite,
  onContract,
}: {
  project: Project
  onEditProject: () => void
  onNewTask: () => void
  onInvite: () => void
  onContract: () => void
}) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <FileJsonIcon className="size-4 text-primary" />
        <h2 className="font-semibold">Workspace Actions</h2>
      </div>
      <p className="mt-2 text-sm leading-5 text-muted-foreground">
        {project.owner} owns this project. Forms below are API-ready surfaces for the live backend.
      </p>
      <div className="mt-4 grid gap-2">
        <Button size="sm" onClick={onNewTask}>
          <PlusIcon />
          Create Task
        </Button>
        <Button variant="outline" size="sm" onClick={onEditProject}>
          <FileTextIcon />
          Edit Project
        </Button>
        <Button variant="outline" size="sm" onClick={onInvite}>
          <UserRoundPlusIcon />
          Invite User Or Agent
        </Button>
        <Button variant="outline" size="sm" onClick={onContract}>
          <FileJsonIcon />
          API Contract
        </Button>
      </div>
    </section>
  )
}

function agentRoomState(status: TaskflowWorkspace["agents"][number]["status"]): "active" | "review" | "idle" {
  if (status === "connected" || status === "idle" || status === "busy") return "active"
  if (status === "blocked") return "review"
  return "idle"
}

function AgentRoom({ agents, onMessage }: { agents: TaskflowWorkspace["agents"]; onMessage: () => void }) {
  const onlineCount = agents.filter(
    (agent) => agent.status === "connected" || agent.status === "idle" || agent.status === "busy"
  ).length

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4 text-primary" />
          <h2 className="font-semibold">Agent Room</h2>
        </div>
        <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
          {onlineCount} online
        </span>
      </div>
      <div className="mt-4 space-y-3">
        {agents.length === 0 ? (
          <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
            No agents in this project yet.
          </p>
        ) : (
          agents.map((agent) => (
            <AgentLine
              key={agent.id}
              name={agent.display_name}
              detail={agent.project_root || agent.identifier}
              state={agentRoomState(agent.status)}
            />
          ))
        )}
      </div>
      <div className="mt-4">
        <Button size="sm" className="w-full" onClick={onMessage}>
          <SendIcon />
          Message agents
        </Button>
      </div>
    </section>
  )
}

function AgentLine({ name, detail, state }: { name: string; detail: string; state: "active" | "review" | "idle" }) {
  const color =
    state === "active"
      ? "bg-emerald-500"
      : state === "review"
        ? "bg-amber-500"
        : "bg-slate-400"
  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted/60 p-2.5">
      <span className={cn("size-2.5 rounded-full", color)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <MessageSquareIcon className="size-4 text-muted-foreground" />
    </div>
  )
}

function ReviewQueue({ tasks, onReview }: { tasks: Task[]; onReview: (taskId: string) => void }) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <InboxIcon className="size-4 text-amber-700" />
          <h2 className="font-semibold">Human Reviews</h2>
        </div>
        <span className="text-sm text-muted-foreground">{tasks.length}</span>
      </div>
      <div className="mt-3 space-y-2">
        {tasks.slice(0, 3).map((task) => (
          <div key={task.id} className="rounded-lg bg-muted/60 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{task.title}</p>
                <MarkdownRenderer
                  content={task.review}
                  compact
                  className="mt-1 [&_p]:line-clamp-2"
                />
              </div>
              <Button variant="outline" size="xs" onClick={() => onReview(task.id)}>
                Decide
              </Button>
            </div>
          </div>
        ))}
        {tasks.length === 0 ? (
          <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">No pending reviews</p>
        ) : null}
      </div>
    </section>
  )
}

function InvitePanel({ invites, onInvite }: { invites: InviteRecord[]; onInvite: () => void }) {
  const pendingCount = invites.filter((invite) => invite.status === "Pending" || invite.status === "Needs auth").length
  const agentCount = invites.filter((invite) => invite.type === "Agent").length

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <UserRoundPlusIcon className="size-4 text-primary" />
          <h2 className="font-semibold">Invites</h2>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {pendingCount} pending
        </span>
      </div>
      <div className="mt-4 flex gap-2">
        <Input className="h-9" readOnly value={invites[0]?.recipient ?? ""} placeholder="No pending invite" />
        <Button size="sm" onClick={onInvite}>
          <UsersIcon />
          Add
        </Button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Button variant="outline" size="sm">{invites.filter((invite) => invite.role === "Owner").length} Owner</Button>
        <Button variant="outline" size="sm">{invites.filter((invite) => invite.role === "Developer").length} Dev</Button>
        <Button variant="outline" size="sm">{agentCount} Agent</Button>
      </div>
    </section>
  )
}

function ActivityPanel({ events }: { events: ActivityEvent[] }) {
  const recent = events.slice(0, 4)
  const uniqueActors = Array.from(new Set(recent.map((event) => event.actor)))

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ActivityIcon className="size-4 text-primary" />
          <h2 className="font-semibold">Activity</h2>
        </div>
        {uniqueActors.length ? (
          <AvatarGroup>
            {uniqueActors.slice(0, 2).map((actor) => (
              <Avatar key={actor} size="sm">
                <AvatarFallback>{toInitials(actor)}</AvatarFallback>
              </Avatar>
            ))}
            {uniqueActors.length > 2 ? <AvatarGroupCount>+{uniqueActors.length - 2}</AvatarGroupCount> : null}
          </AvatarGroup>
        ) : null}
      </div>
      <div className="mt-4 space-y-3">
        {recent.length === 0 ? (
          <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          recent.map((event) => (
            <div key={event.id} className="flex gap-3">
              <Clock3Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <MarkdownRenderer content={event.detail} compact className="[&_p]:text-sm" />
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {event.actor} · {event.time}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function PageShell({
  eyebrow,
  title,
  description,
  children,
  actions,
}: {
  eyebrow: string
  title: string
  description: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className="grid gap-5 p-4 sm:p-5">
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{eyebrow}</p>
            <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
            <MarkdownRenderer
              content={description}
              compact
              className="mt-2 max-w-3xl [&_p]:text-sm [&_p]:leading-6"
            />
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      </div>
      {children}
    </section>
  )
}

// Honest empty state shown across the dashboard when the signed-in user has no
// projects yet (a first-time account, or someone whose invites are still
// pending). This replaces the old fixture fallback — no fake project, no error.
function NoProjectEmptyState({
  onNewProject,
  syncing,
}: {
  onNewProject: () => void
  syncing?: boolean
}) {
  return (
    <section className="grid place-items-center p-4 sm:p-8">
      <div className="w-full max-w-xl rounded-xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
          <FolderKanbanIcon className="size-6" />
        </div>
        <h1 className="mt-4 text-xl font-semibold">No projects yet</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          {syncing
            ? "Loading your workspace…"
            : "You'll see a project here once you create one or accept an invitation to join one."}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={onNewProject}>
            <PlusIcon />
            New Project
          </Button>
          <Button variant="outline" render={<Link to="/account/invitations" />}>
            <InboxIcon />
            View Invitations
          </Button>
        </div>
      </div>
    </section>
  )
}

function AgentsPage({
  project,
  liveWorkspace,
  currentUser,
  onWorkspaceUpdate,
  onRefreshWorkspace,
  onMessage,
}: {
  project: Project
  liveWorkspace: TaskflowWorkspace | null
  currentUser: AuthUser | null
  onWorkspaceUpdate: (updater: (workspace: TaskflowWorkspace) => TaskflowWorkspace) => void
  onRefreshWorkspace: () => Promise<void>
  onMessage: () => void
}) {
  const [selectedChatId, setSelectedChatId] = useState("")
  const [messageError, setMessageError] = useState<string | null>(null)
  const directChats = useMemo<AgentChatContext[]>(
    () => (liveWorkspace ? mapLiveDirectChats(liveWorkspace, currentUser) : []),
    [currentUser, liveWorkspace]
  )
  const channelChats = useMemo<AgentChatContext[]>(
    () => (liveWorkspace ? mapLiveChannelChats(liveWorkspace, currentUser) : []),
    [currentUser, liveWorkspace]
  )
  const allChats = useMemo(() => [...channelChats, ...directChats], [channelChats, directChats])
  const fallbackChat: AgentChatContext = channelChats[0] ?? directChats[0] ?? {
    id: "empty-chat",
    mode: "channel",
    title: "Project room",
    detail: "No channels or agents are available yet.",
    status: "Waiting",
    members: currentUser ? [{ name: currentUser.username, type: "human" }] : [],
    primaryAgent: "project",
    unread: 0,
    messages: [],
  }
  const selectedChat =
    allChats.find((chat) => chat.id === selectedChatId) ?? allChats[0] ?? fallbackChat
  const terminalSessions = useMemo(
    () => (liveWorkspace ? mapLiveTerminalSessions(liveWorkspace) : []),
    [liveWorkspace]
  )
  const selectedSession =
    terminalSessions.find((session) => session.agent === selectedChat.primaryAgent || session.agent === selectedChat.title) ??
    terminalSessions[0]

  useEffect(() => {
    if (!allChats.length) return
    if (!allChats.some((chat) => chat.id === selectedChatId)) {
      setSelectedChatId(allChats[0].id)
    }
  }, [allChats, selectedChatId])

  const createChannelMember = async (
    projectId: number,
    channelId: number,
    member: { kind: "user"; user: number; name: string; role: string } | { kind: "agent"; agent: number; name: string; role: string }
  ) => {
    return createTaskflowAgentChannelMember({
      project: projectId,
      channel: channelId,
      member_kind: member.kind,
      user: member.kind === "user" ? member.user : null,
      agent: member.kind === "agent" ? member.agent : null,
      display_name: member.name,
      role: member.role,
    })
  }

  const ensureLiveChannel = async (chat: AgentChatContext) => {
    if (chat.liveChannelId) return chat.liveChannelId
    const projectId = liveId(project.id)
    if (!projectId || !liveWorkspace) {
      throw new Error("Select a live project before sending project chat messages.")
    }

    const channel = await createTaskflowAgentChannel({
      project: projectId,
      title: chat.mode === "direct" ? chat.title : "Project room",
      topic: chat.detail,
      kind: chat.mode === "direct" ? "direct" : "project",
      created_by_user: currentUser?.id ?? null,
      archived: false,
    })
    onWorkspaceUpdate((workspace) => ({ ...workspace, agentChannels: upsertById(workspace.agentChannels, channel) }))
    const memberWrites: Array<ReturnType<typeof createChannelMember>> = []
    const added = new Set<string>()
    const addUser = (user: number | null | undefined, name: string, role: string) => {
      if (!user) return
      const key = `user:${user}`
      if (added.has(key)) return
      added.add(key)
      memberWrites.push(createChannelMember(projectId, channel.id, { kind: "user", user, name, role }))
    }
    const addAgent = (agent: number | null | undefined, name: string, role: string) => {
      if (!agent) return
      const key = `agent:${agent}`
      if (added.has(key)) return
      added.add(key)
      memberWrites.push(createChannelMember(projectId, channel.id, { kind: "agent", agent, name, role }))
    }

    addUser(currentUser?.id, currentUser?.username ?? "You", "member")

    if (chat.mode === "direct") {
      const agent = liveWorkspace.agents.find((candidate) => candidate.id === chat.liveAgentId)
      addAgent(agent?.id ?? chat.liveAgentId, agent?.display_name ?? chat.primaryAgent, "agent")
    } else {
      liveWorkspace.members
        .filter((member) => member.status === "active")
        .forEach((member) => addUser(member.user, member.display_name, member.role))
      liveWorkspace.agents.forEach((agent) => addAgent(agent.id, agent.display_name, "agent"))
    }

    const members = await Promise.all(memberWrites)
    if (members.length) {
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentChannelMembers: members.reduce(
          (currentMembers, member) => upsertById(currentMembers, member),
          workspace.agentChannelMembers
        ),
      }))
    }
    return channel.id
  }

  const sendLiveMessage = async (
    chat: AgentChatContext,
    body: string,
    priority: MessagePriority,
    attachments: AgentAttachment[]
  ) => {
    const projectId = liveId(project.id)
    if (!projectId || !liveWorkspace) {
      throw new Error("Select a live project before sending project chat messages.")
    }

    const channelId = await ensureLiveChannel(chat)
    const nonce = crypto.randomUUID()
    const body_markdown = appendAttachmentMarkdown(body, attachments)

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: addPending(workspace.agentMessages, {
        client_nonce: nonce,
        body_markdown,
        priority: toLiveMessagePriority(priority),
        channel: channelId,
        status: "pending",
      }),
    }))

    try {
      const saved = await sendTaskflowAgentMessage({
        channel: channelId,
        body_markdown,
        priority: toLiveMessagePriority(priority),
        client_nonce: nonce,
      })
      // Reconcile the response as well as the SSE echo. Whichever lands first
      // wins and the other is a no-op — they key on the same nonce. Relying on
      // the echo alone would strand the bubble as pending whenever SSE is down,
      // even though the message saved fine.
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: reconcile(workspace.agentMessages, saved),
      }))
    } catch (error) {
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: markFailed(workspace.agentMessages, nonce),
      }))
      throw error
    }
  }

  const retryLiveMessage = async (nonce: string) => {
    const failed = findPending(liveWorkspace?.agentMessages ?? [], nonce)
    if (!failed) return

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: markRetrying(workspace.agentMessages, nonce),
    }))

    try {
      const saved = await sendTaskflowAgentMessage({
        channel: failed.channel,
        body_markdown: failed.body_markdown,
        priority: failed.priority,
        client_nonce: nonce,          // same nonce: the send endpoint is idempotent
      })
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: reconcile(workspace.agentMessages, saved),
      }))
    } catch (error) {
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: markFailed(workspace.agentMessages, nonce),
      }))
      setMessageError(error instanceof Error ? error.message : "Could not send the message.")
    }
  }

  const handleSendMessage = (
    chat: AgentChatContext,
    body: string,
    priority: MessagePriority,
    attachments: AgentAttachment[]
  ) => {
    const trimmedBody = body.trim()
    if (!trimmedBody && attachments.length === 0) return

    setMessageError(null)
    void sendLiveMessage(chat, trimmedBody, priority, attachments).catch((error) => {
      setMessageError(error instanceof Error ? error.message : "Could not send the live message.")
    })
  }

  // Active project members who are not already on the selected LIVE channel.
  // "Already a member" is read straight from the channel's member rows (the same
  // data mapLiveChannelMembers renders), keyed by user id so display-name
  // collisions or a differing self-label never let someone be re-added by hand.
  const addMemberCandidates = useMemo<{ user: number; name: string }[]>(() => {
    const channelId = selectedChat.liveChannelId
    if (!liveWorkspace || channelId == null) return []
    const existingUserIds = new Set(
      liveWorkspace.agentChannelMembers
        .filter((member) => member.channel === channelId && member.user != null)
        .map((member) => member.user as number)
    )
    return liveWorkspace.members
      .filter((member) => member.status === "active" && member.user != null && !existingUserIds.has(member.user))
      .map((member) => ({ user: member.user as number, name: member.display_name }))
  }, [liveWorkspace, selectedChat.liveChannelId])

  const handleAddMember = async (userId: number) => {
    const channelId = selectedChat.liveChannelId
    if (channelId == null) return
    await addChannelMember(channelId, userId)
    // Re-fetch so the roster, member counts, and candidate list all reflect the
    // new membership (mirrors how invite-accept re-syncs the workspace).
    await onRefreshWorkspace()
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 p-4 sm:p-5">
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{project.name}</p>
            <h1 className="mt-1 text-2xl font-semibold">Agents</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Coordinate through group chats and DMs, send files or image references, and inspect the active terminal session from one place.
            </p>
          </div>
          <Button size="sm" onClick={onMessage}>
            <SendIcon />
            Message Agents
          </Button>
        </div>
      </div>
      <AgentAuthBanner />
      {messageError ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {messageError}
        </p>
      ) : null}

      <AgentWorkbenchView
        selectedChat={selectedChat}
        selectedSession={selectedSession}
        directChats={directChats}
        channelChats={channelChats}
        selectedChatId={selectedChat.id}
        onSelectDirectChat={(chat) => {
          setSelectedChatId(chat.id)
        }}
        onSelectChannel={(chat) => {
          setSelectedChatId(chat.id)
        }}
        onSendMessage={handleSendMessage}
        onRetryMessage={retryLiveMessage}
        canManageMembers={selectedChat.liveChannelId != null && selectedChat.mode === "channel"}
        addMemberCandidates={addMemberCandidates}
        onAddMember={handleAddMember}
      />
    </section>
  )
}

function AgentAuthBanner() {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
            <LockIcon className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Workspace identity</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Users authenticate first, then link coding agents, providers, inbox messages, and terminal sessions to this project.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm">
            <ShieldCheckIcon />
            Authenticate
          </Button>
          <Button variant="outline" size="sm" disabled>
            <BotIcon />
            Link Agent
          </Button>
        </div>
      </div>
    </section>
  )
}

function AgentWorkbenchView({
  selectedChat,
  selectedSession,
  directChats,
  channelChats,
  selectedChatId,
  onSelectDirectChat,
  onSelectChannel,
  onSendMessage,
  onRetryMessage,
  canManageMembers,
  addMemberCandidates,
  onAddMember,
}: {
  selectedChat: AgentChatContext
  selectedSession?: AgentTerminalSessionView
  directChats: AgentChatContext[]
  channelChats: AgentChatContext[]
  selectedChatId: string
  onSelectDirectChat: (chat: AgentChatContext) => void
  onSelectChannel: (chat: AgentChatContext) => void
  onSendMessage: (chat: AgentChatContext, body: string, priority: MessagePriority, attachments: AgentAttachment[]) => void
  onRetryMessage: (nonce: string) => void
  canManageMembers: boolean
  addMemberCandidates: { user: number; name: string }[]
  onAddMember: (userId: number) => Promise<void>
}) {
  const [draftMessage, setDraftMessage] = useState("")
  const [messagePriority, setMessagePriority] = useState<MessagePriority>("normal")
  const [stagedAttachments, setStagedAttachments] = useState<AgentAttachment[]>([])
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const canSendMessage = draftMessage.trim().length > 0 || stagedAttachments.length > 0
  const focusComposer = () => {
    composerRef.current?.focus()
  }
  const addStagedAttachment = (attachment: AgentAttachment) => {
    setStagedAttachments((current) => [...current, attachment])
  }
  const addContextAttachment = () => {
    addStagedAttachment({
      id: `att-context-${Date.now()}`,
      kind: "markdown",
      name: `${selectedChat.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-context.md`,
      detail: `Thread context generated for ${selectedChat.mode === "channel" ? "group" : "DM"} handoff.`,
      source: "generated",
      path: `/projects/${selectedChat.primaryAgent}/threads/${selectedChat.id.replace(":", "-")}/context.md`,
      size: "Generated",
      mimeType: "text/markdown",
    })
  }
  const addImageUrlAttachment = () => {
    addStagedAttachment({
      id: `att-image-url-${Date.now()}`,
      kind: "image",
      name: "dashboard-reference.png",
      detail: "URL attachment that any project member or agent can request from the server.",
      source: "url",
      path: "/uploads/projects/example-project/dashboard-reference.png",
      url: "/landing/dashboard.png",
      size: "237 KB",
      mimeType: "image/png",
    })
  }
  const handleSendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedMessage = draftMessage.trim()
    if (!trimmedMessage && stagedAttachments.length === 0) return

    onSendMessage(selectedChat, trimmedMessage, messagePriority, stagedAttachments)
    setDraftMessage("")
    setStagedAttachments([])
    setMessagePriority("normal")
    requestAnimationFrame(focusComposer)
  }
  const chatLabel = selectedChat.mode === "channel" ? "Group chat" : "DM"
  const memberSummary = describeMembers(selectedChat.members)
  const composerHint =
    selectedChat.mode === "channel"
      ? `Visible to ${memberSummary}`
      : `Visible to ${selectedChat.members.map((member) => member.name).join(" and ")}`

  return (
    <section className="grid min-h-0 flex-1 grid-rows-[minmax(9rem,12rem)_minmax(0,1fr)_minmax(18rem,0.72fr)] overflow-hidden rounded-lg border bg-card shadow-sm xl:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)_minmax(18rem,0.85fr)] xl:grid-rows-none">
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-b bg-muted/35 p-3 xl:border-b-0 xl:border-r">
        <div className="flex shrink-0 items-center gap-2 text-sm font-semibold">
          <InboxIcon className="size-4 text-primary" />
          Groups And DMs
        </div>
        <div className="scrollbar-y mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
          <div className="flex items-center justify-between gap-2 px-1 text-[0.7rem] font-semibold uppercase tracking-normal text-muted-foreground">
            <span>Group chats</span>
            <span>{channelChats.length}</span>
          </div>
          {channelChats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={cn(
                "w-full min-w-0 overflow-hidden rounded-lg border bg-background p-3 text-left transition hover:border-primary/35",
                selectedChatId === chat.id && "border-primary/50 ring-2 ring-primary/15"
              )}
              onClick={() => onSelectChannel(chat)}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{chat.title}</span>
                {chat.unread ? (
                  <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                    {chat.unread}
                  </span>
                ) : null}
              </div>
              <MarkdownRenderer
                content={chat.detail}
                compact
                className="mt-1 w-full [&_p]:truncate [&_p]:text-xs"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900/60">
                  {chat.members.length} members
                </span>
                <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900/60">
                  {countMemberType(chat.members, "agent")} agents
                </span>
                <span className="min-w-0 max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {chat.status}
                </span>
              </div>
            </button>
          ))}
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3 px-1 text-[0.7rem] font-semibold uppercase tracking-normal text-muted-foreground">
            <span>DMs</span>
            <span>{directChats.length}</span>
          </div>
          {directChats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={cn(
                "w-full min-w-0 overflow-hidden rounded-lg border bg-background p-3 text-left transition hover:border-primary/35",
                selectedChatId === chat.id && "border-primary/50 ring-2 ring-primary/15"
              )}
              onClick={() => onSelectDirectChat(chat)}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{chat.title}</span>
                {chat.unread ? (
                  <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                    {chat.unread}
                  </span>
                ) : null}
              </div>
              <MarkdownRenderer
                content={chat.detail}
                compact
                className="mt-1 w-full [&_p]:truncate [&_p]:text-xs"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1", agentStatusClass(chat.status))}>
                  {chat.status}
                </span>
                <span className="min-w-0 max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {countMemberType(chat.members, "agent")} agents · {chat.members.length} members
                </span>
              </div>
            </button>
          ))}
          {directChats.length === 0 ? (
            <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">No agents to DM yet.</p>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-col border-b xl:border-b-0 xl:border-r">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">{selectedChat.title}</h2>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
                {chatLabel}
              </span>
            </div>
            <MarkdownRenderer
              content={`${selectedChat.detail} · ${memberSummary}`}
              compact
              className="mt-1 [&_p]:text-xs"
            />
          </div>
          <div className="flex items-center gap-2">
            {canManageMembers ? (
              <AddChannelMemberControl candidates={addMemberCandidates} onAddMember={onAddMember} />
            ) : null}
            <Button variant="outline" size="sm" onClick={focusComposer}>
              <SendIcon />
              Compose
            </Button>
          </div>
        </div>

        <div className="chat-thread-bg scrollbar-y min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {selectedChat.messages.map((message) => (
            <AgentChatBubble key={message.id} message={message} onRetry={onRetryMessage} />
          ))}
        </div>

        <form className="shrink-0 border-t bg-background p-3" onSubmit={handleSendMessage}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-1 font-medium text-muted-foreground">
                To {selectedChat.title}
              </span>
              <span className="text-muted-foreground">{composerHint}</span>
            </div>
            {stagedAttachments.length ? (
              <AttachmentList
                attachments={stagedAttachments}
                onRemove={(attachmentId) =>
                  setStagedAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
                }
              />
            ) : null}
            <textarea
              ref={composerRef}
              className={cn(textareaClass, "max-h-44 min-h-24")}
              placeholder={`Message ${selectedChat.title}. Shift+Enter for a new line.`}
              value={draftMessage}
              onChange={(event) => setDraftMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
            />
            <div className="flex flex-wrap justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled
                  title="File upload is coming soon"
                  aria-label="Attach file (coming soon)"
                >
                  <FileTextIcon />
                  Attach File
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={addContextAttachment}>
                  <FileJsonIcon />
                  Context
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={addImageUrlAttachment}>
                  <LinkIcon />
                  Image URL
                </Button>
                <Button type="button" variant="outline" size="sm">Broadcast</Button>
                <div className="flex items-center gap-2">
                  <span id="agent-message-priority-label" className="text-xs font-medium text-muted-foreground">
                    Priority
                  </span>
                  <Select
                    value={messagePriority}
                    onValueChange={(value) => setMessagePriority(value as MessagePriority)}
                  >
                    <SelectTrigger className="w-48" aria-labelledby="agent-message-priority-label">
                      <SelectValue placeholder="Priority" />
                    </SelectTrigger>
                    <SelectContent>
                      {messagePriorityOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button size="sm" type="submit" disabled={!canSendMessage}>
                <SendIcon />
                Send Message
              </Button>
            </div>
          </div>
        </form>
      </div>

      <AgentTerminalPanel selectedSession={selectedSession} onFocusComposer={focusComposer} />
    </section>
  )
}

/// Unobtrusive "+ Add member" picker for the selected LIVE channel. Lists the
/// real project members not yet on the channel (computed upstream from
/// `workspace.members`); selecting one adds them and the parent re-syncs the
/// workspace so the roster + counts update. Pending and error states are kept
/// local so a failed add (e.g. 400 not_a_project_member, 403) shows inline
/// without disturbing the chat.
function AddChannelMemberControl({
  candidates,
  onAddMember,
}: {
  candidates: { user: number; name: string }[]
  onAddMember: (userId: number) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [pendingUser, setPendingUser] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = pendingUser != null

  const handleSelect = async (userId: number) => {
    setError(null)
    setPendingUser(userId)
    try {
      await onAddMember(userId)
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the member.")
    } finally {
      setPendingUser(null)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <DropdownMenu
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (!nextOpen) setError(null)
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" disabled={busy}>
              <UserRoundPlusIcon />
              {busy ? "Adding…" : "Add member"}
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Add to this channel</DropdownMenuLabel>
            {candidates.length === 0 ? (
              <p className="px-1.5 py-2 text-xs text-muted-foreground">
                Everyone in the project is already here.
              </p>
            ) : (
              candidates.map((candidate) => (
                <DropdownMenuItem
                  key={candidate.user}
                  closeOnClick={false}
                  disabled={busy}
                  onClick={() => {
                    void handleSelect(candidate.user)
                  }}
                >
                  {candidate.name}
                  {pendingUser === candidate.user ? (
                    <span className="ml-auto text-xs text-muted-foreground">Adding…</span>
                  ) : null}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuGroup>
          {error ? (
            <p className="px-1.5 pt-1 pb-1.5 text-xs text-rose-600">{error}</p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function messagePriorityLabel(priority: MessagePriority) {
  return messagePriorityOptions.find((option) => option.value === priority)?.label ?? "Normal"
}

function messagePriorityBadgeClass(priority: MessagePriority) {
  if (priority === "blocking") {
    return "bg-rose-100 text-rose-800 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900/60"
  }

  if (priority === "needs-response") {
    return "bg-amber-100 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60"
  }

  return "bg-muted text-muted-foreground ring-border"
}

function countMemberType(members: ConversationMember[], type: ConversationMember["type"]) {
  return members.filter((member) => member.type === type).length
}

function describeMembers(members: ConversationMember[]) {
  const humanCount = countMemberType(members, "human")
  const agentCount = countMemberType(members, "agent")
  const parts = [
    humanCount ? `${humanCount} human${humanCount === 1 ? "" : "s"}` : null,
    agentCount ? `${agentCount} agent${agentCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean)

  return `${members.length} member${members.length === 1 ? "" : "s"}${parts.length ? `, ${parts.join(", ")}` : ""}`
}

function attachmentIcon(attachment: AgentAttachment) {
  if (attachment.kind === "image") return <FileJsonIcon className="size-4" />
  if (attachment.kind === "markdown") return <FileTextIcon className="size-4" />
  if (attachment.kind === "url") return <LinkIcon className="size-4" />
  return <FileJsonIcon className="size-4" />
}

function AttachmentList({
  attachments,
  onRemove,
}: {
  attachments: AgentAttachment[]
  onRemove?: (attachmentId: string) => void
}) {
  return (
    <div className="grid gap-2">
      {attachments.map((attachment) => {
        const accessPath = attachment.url ?? attachment.path
        return (
          <div key={attachment.id} className="overflow-hidden rounded-lg border bg-background/90">
            {attachment.kind === "image" && attachment.url ? (
              <img
                src={attachment.url}
                alt={attachment.name}
                className="max-h-44 w-full border-b object-cover object-left-top"
              />
            ) : null}
            <div className="flex gap-3 p-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
                {attachmentIcon(attachment)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-semibold">{attachment.name}</p>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                    {attachment.kind}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {attachment.source}
                  </span>
                </div>
                <MarkdownRenderer content={attachment.detail} compact className="mt-1" />
                {accessPath ? (
                  <p className="mt-2 break-all rounded-md bg-muted px-2 py-1 font-mono text-[0.7rem] leading-4 text-muted-foreground">
                    {accessPath}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {attachment.size ? <span>{attachment.size}</span> : null}
                  {attachment.mimeType ? <span>{attachment.mimeType}</span> : null}
                </div>
              </div>
              {onRemove ? (
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => onRemove(attachment.id)}>
                  <XIcon />
                </Button>
              ) : accessPath ? (
                <Button type="button" variant="outline" size="xs" render={<a href={accessPath} target="_blank" rel="noreferrer" />}>
                  Open
                </Button>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AgentChatBubble({ message, onRetry }: { message: AgentMessage; onRetry?: (nonce: string) => void }) {
  const fromUser = message.from === "user"
  const alignRight = fromUser
  return (
    <article className={cn("flex", alignRight ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[42rem] rounded-lg border p-3 shadow-sm",
          fromUser ? "agent-sent-bubble" : alignRight ? "bg-accent/75" : "bg-background/95"
        )}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold">{fromUser ? "You" : message.from}</span>
          <span className={cn("text-muted-foreground", message.status === "failed" && "text-rose-600 dark:text-rose-300")}>
            {message.time}
          </span>
          {message.priority && message.priority !== "normal" ? (
            <span className={cn("rounded-full px-2 py-0.5 font-medium ring-1", messagePriorityBadgeClass(message.priority))}>
              {messagePriorityLabel(message.priority)}
            </span>
          ) : null}
        </div>
        <MarkdownRenderer
          content={message.body}
          compact
        />
        {message.attachments?.length ? (
          <div className="mt-3">
            <AttachmentList attachments={message.attachments} />
          </div>
        ) : null}
        {message.choices ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.choices.map((choice) => (
              <Button key={choice} variant="outline" size="xs" className="bg-background/85">
                {choice}
              </Button>
            ))}
          </div>
        ) : null}
        {message.status === "failed" && message.nonce && onRetry ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-rose-700 dark:text-rose-300">
            <span>Message failed to send.</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="bg-background/85"
              onClick={() => onRetry(message.nonce!)}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  )
}

function AgentTerminalPanel({
  selectedSession,
  onFocusComposer,
}: {
  selectedSession?: AgentTerminalSessionView
  onFocusComposer: () => void
}) {
  if (!selectedSession) {
    return (
      <div className="flex min-h-0 min-w-0 flex-col bg-muted/20">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <TerminalIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Terminal</h2>
          </div>
        </div>
        <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted-foreground">
          No terminal session yet. Connected agents and their terminal frames will appear here.
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col bg-muted/20">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <TerminalIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">{selectedSession.agent}</h2>
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium ring-1", terminalStatusClass(selectedSession.status))}>
              {selectedSession.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{selectedSession.cwd}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onFocusComposer}>
            <MessageSquareIcon />
            Message
          </Button>
          <Button size="sm">
            <TerminalIcon />
            Refresh
          </Button>
        </div>
      </div>

      <div className="scrollbar-y min-h-0 flex-1 overflow-y-auto p-4">
        <TerminalTranscript session={selectedSession} />
      </div>

      <div className="shrink-0 border-t bg-background p-3">
        <div className="flex flex-wrap gap-2">
          {["Esc", "Enter", "Tab", "Ctrl+C"].map((key) => (
            <Button key={key} variant="outline" size="sm">
              {key}
            </Button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Input className="h-9 font-mono" placeholder="Send keys or command to selected session" />
          <Button size="sm">
            <SendIcon />
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}

function TerminalTranscript({ session }: { session: AgentTerminalSessionView }) {
  return (
    <div className="rounded-lg bg-[oklch(0.18_0.015_238)] p-4 font-mono text-xs leading-6 text-[oklch(0.88_0.018_238)] shadow-inner">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2">
        <span>{session.task}</span>
        <span className="text-[oklch(0.72_0.02_238)]">{session.updated}</span>
      </div>
      {session.lines.map((line, index) => (
        <div key={`${session.agent}-${index}`} className="whitespace-pre-wrap">
          {line || " "}
        </div>
      ))}
    </div>
  )
}

function agentStatusClass(status: string) {
  if (status === "Active" || status === "connected" || status === "idle" || status === "busy") {
    return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  }
  if (status === "Review" || status === "blocked") return "bg-amber-100 text-amber-800 ring-amber-200"
  if (status === "revoked" || status === "offline") return "bg-rose-100 text-rose-800 ring-rose-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}

function terminalStatusClass(status: string) {
  if (status === "Awaiting input") return "bg-amber-100 text-amber-800 ring-amber-200"
  if (status === "Running" || status === "Connected") return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  if (status === "Expired" || status === "Disconnected") return "bg-rose-100 text-rose-800 ring-rose-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}

function ReviewsPage({ tasks, onReview }: { tasks: Task[]; onReview: (taskId: string) => void }) {
  return (
    <PageShell
      eyebrow="Human in the loop"
      title="Review Queue"
      description="Review gates collect decisions that should not be left to autonomous execution."
    >
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Pending Decisions</h2>
              <p className="mt-1 text-xs text-muted-foreground">{tasks.length} review gates need a human response.</p>
            </div>
            <Button variant="outline" size="sm">
              <ActivityIcon />
              Export Queue
            </Button>
          </div>
          {tasks.length ? (
            <div className="scrollbar-y overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead className="bg-muted/55 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">Task</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Owner</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Gate</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Due</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.id} className="border-t">
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", priorityClass(task.priority))}>
                            {task.priority}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            {statusLabel(task.status)}
                          </span>
                        </div>
                        <p className="mt-2 font-medium">{task.title}</p>
                      </td>
                      <td className="px-4 py-3 align-top text-muted-foreground">
                        <p className="font-medium text-foreground">{task.owner}</p>
                        <p className="mt-1 text-xs">{task.operatorName}</p>
                      </td>
                      <td className="max-w-md px-4 py-3 align-top text-muted-foreground">
                        <MarkdownRenderer
                          content={task.review}
                          compact
                          className="[&_p]:line-clamp-2 [&_p]:text-sm"
                        />
                      </td>
                      <td className="px-4 py-3 align-top text-muted-foreground">{task.due}</td>
                      <td className="px-4 py-3 text-right align-top">
                        <Button size="sm" onClick={() => onReview(task.id)}>
                          <ClipboardCheckIcon />
                          Decide
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
        <section className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheckIcon className="size-4 text-primary" />
            Review Rules
          </div>
          <div className="mt-4 space-y-3">
            <ReviewRule title="Approve" detail="Marks the task done and writes the decision into activity." />
            <ReviewRule title="Request changes" detail="Returns the task to active work with the reviewer note attached." />
            <ReviewRule title="Block" detail="Moves the task into blocked until the project owner resolves it." />
          </div>
        </section>
        {tasks.length === 0 ? (
          <section className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground xl:col-span-2">
            No pending human reviews.
          </section>
        ) : null}
      </div>
    </PageShell>
  )
}

function ReviewRule({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg bg-muted/55 p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
    </div>
  )
}

function ActivityLogPage({ title, events }: { title: string; events: ActivityEvent[] }) {
  return (
    <PageShell
      eyebrow="Project log"
      title={title}
      description="A replayable record of task movement, agent work, human decisions, and project context."
    >
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b pb-3">
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Activity Feed</h2>
          </div>
          <span className="text-xs text-muted-foreground">{events.length} entries</span>
        </div>
        {events.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed bg-muted/40 p-8 text-center text-sm text-muted-foreground">
            No activity yet. Task moves, agent work, and review decisions will show up here.
          </div>
        ) : (
        <div className="relative mt-4">
          <div className="absolute bottom-0 left-3 top-0 w-px bg-border" />
          <div className="space-y-4">
            {events.map((event) => (
              <div key={event.id} className="relative flex gap-4">
                <span className="relative z-10 mt-1 flex size-6 items-center justify-center rounded-full border bg-background">
                  <Clock3Icon className="size-3.5 text-primary" />
                </span>
                <div className="min-w-0 flex-1 rounded-lg border bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="truncate text-sm font-semibold">{event.title}</h3>
                    <span className="text-xs text-muted-foreground">{event.time}</span>
                  </div>
                  <MarkdownRenderer content={event.detail} compact className="mt-1 [&_p]:text-sm" />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                      {event.action.replace(/_/g, " ")}
                    </span>
                    <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                      {event.entity}
                    </span>
                    <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                      {event.actor}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        )}
      </section>
    </PageShell>
  )
}

function InvitesPage({ project, invites, onInvite }: { project: Project; invites: InviteRecord[]; onInvite: () => void }) {
  const pendingCount = invites.filter((invite) => invite.status === "Pending" || invite.status === "Needs auth").length
  const acceptedCount = invites.filter((invite) => invite.status === "Accepted").length
  const agentInviteCount = invites.filter((invite) => invite.type === "Agent").length
  const expiringCount = invites.filter((invite) => invite.expires.includes("left")).length

  return (
    <PageShell
      eyebrow="Access"
      title="Invites"
      description="Invite humans and agents into project channels, reviews, API scopes, and activity history with explicit access."
      actions={
        <Button size="sm" onClick={onInvite}>
          <UserRoundPlusIcon />
          New Invite
        </Button>
      }
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <AccessMetric label="Pending" value={String(pendingCount)} detail="Awaiting acceptance or auth" />
        <AccessMetric label="Accepted" value={String(acceptedCount)} detail="Active project members" />
        <AccessMetric label="Agent invites" value={String(agentInviteCount)} detail={`${project.agentsOnline} agents online`} />
        <AccessMetric label="Expiring" value={String(expiringCount)} detail="Links with time remaining" />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Invite Requests</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {invites.length} access requests for {project.name}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm">
                <ShieldCheckIcon />
                Audit Access
              </Button>
              <Button size="sm" onClick={onInvite}>
                <UserRoundPlusIcon />
                Invite
              </Button>
            </div>
          </div>
          <div className="scrollbar-y overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-sm">
              <thead className="bg-muted/55 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">Recipient</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Role</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Scope</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Lifecycle</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr key={invite.id} className="border-t">
                    <td className="px-4 py-3 align-top">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/20">
                          {invite.type === "Agent" ? "AI" : invite.recipient.slice(0, 2).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{invite.recipient}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{invite.type} · requested by {invite.requestedBy}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", inviteRoleClass(invite.role))}>
                        {invite.role}
                      </span>
                    </td>
                    <td className="max-w-[15rem] px-4 py-3 align-top">
                      <MarkdownRenderer
                        content={invite.scope}
                        compact
                        className="[&_p]:truncate"
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", inviteStatusClass(invite.status))}>
                        {invite.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <MarkdownRenderer
                        content={invite.lastEvent}
                        compact
                        className="[&_p]:text-sm"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">Sent {invite.sent} · {invite.expires}</p>
                    </td>
                    <td className="px-4 py-3 text-right align-top">
                      <Button variant={invite.status === "Accepted" ? "outline" : "default"} size="sm">
                        {invite.nextAction}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {invites.length === 0 ? (
            <div className="border-t p-8 text-center text-sm text-muted-foreground">
              No invites have been created for this project yet.
            </div>
          ) : null}
        </section>

        <aside className="space-y-3">
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <UserRoundPlusIcon className="size-4 text-primary" />
              What Happens
            </div>
            <div className="mt-4 space-y-3">
              <InviteFlowStep index="1" title="Invite is created" detail="A pending project invite stores the recipient, role, token, sender, and expiry." />
              <InviteFlowStep index="2" title="Identity is verified" detail="Humans authenticate. Agents link through the API base before they can act." />
              <InviteFlowStep index="3" title="Access is activated" detail="Acceptance should create or activate the project member and add them to the right rooms." />
              <InviteFlowStep index="4" title="History is preserved" detail="Resends, expirations, revocations, and acceptances stay visible in project activity." />
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheckIcon className="size-4 text-primary" />
              Role Policy
            </div>
            <div className="mt-4 space-y-2">
              <InviteRole title="Owner" detail="Can manage API base, access, and production decisions." />
              <InviteRole title="Developer" detail="Can claim tasks, coordinate with agents, and update work state." />
              <InviteRole title="Viewer" detail="Can read board state, logs, reviews, and activity without editing." />
            </div>
          </section>
        </aside>
      </div>
    </PageShell>
  )
}

function AccessMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </section>
  )
}

function InviteFlowStep({ index, title, detail }: { index: string; title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/20">
        {index}
      </span>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

function InviteRole({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg bg-muted/55 p-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
    </div>
  )
}

function inviteStatusClass(status: InviteRecord["status"]) {
  if (status === "Accepted") return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  if (status === "Pending") return "bg-amber-100 text-amber-800 ring-amber-200"
  if (status === "Needs auth") return "bg-sky-100 text-sky-800 ring-sky-200"
  if (status === "Revoked") return "bg-rose-100 text-rose-800 ring-rose-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}

function inviteRoleClass(role: InviteRecord["role"]) {
  if (role === "Owner") return "bg-primary/10 text-primary ring-primary/20"
  if (role === "Developer") return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}

function ApiBasePage({
  project,
  workspace,
  onContract,
  onUpdateProject,
}: {
  project: Project
  workspace: TaskflowWorkspace | null
  onContract: () => void
  onUpdateProject: (event: FormEvent<HTMLFormElement>) => void
}) {
  const sessions = workspace?.agentSessions ?? []
  const credentials = workspace?.agentCredentials ?? []
  const agents = workspace?.agents ?? []
  const connectedSessions = sessions.filter((session) => session.status === "connected").length
  const disconnectedSessions = sessions.filter((session) => session.status === "disconnected").length
  const expiredSessions = sessions.filter((session) => session.status === "expired").length
  const activeKeys = credentials.filter((credential) => credential.status === "active").length
  const restBase = "/api"
  const realtimeBase = "/realtime"

  return (
    <PageShell
      eyebrow={project.name}
      title="API Base"
      description="Configure the live API target, agent session identity, authentication handshake, callback links, and project integration surfaces."
      actions={
        <Button size="sm" onClick={onContract}>
          <FileJsonIcon />
          API Contract
        </Button>
      }
    >
      <div className="grid gap-3 lg:grid-cols-3">
        <InfoCard icon={<GitBranchIcon />} title="API base" value={project.apiBase} />
        <InfoCard icon={<UsersIcon />} title="Members" value={`${project.members} collaborators`} />
        <InfoCard icon={<BotIcon />} title="Agents" value={`${project.agentsOnline} online`} />
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <InfoCard icon={<TerminalIcon />} title="Connected sessions" value={`${connectedSessions} live`} />
        <InfoCard icon={<Clock3Icon />} title="Disconnected sessions" value={`${disconnectedSessions} idle`} />
        <InfoCard icon={<AlertCircleIcon />} title="Expired sessions" value={`${expiredSessions} expired`} />
        <InfoCard icon={<LockIcon />} title="Active keys" value={`${activeKeys} active`} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <form className="rounded-lg border bg-card p-4 shadow-sm" onSubmit={onUpdateProject}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileJsonIcon className="size-4 text-primary" />
            Runtime API
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Base URL</span>
              <Input name="default_api_base_url" defaultValue={project.apiBase || restBase} />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Sync mode</span>
              <Select defaultValue="realtime">
                <SelectTrigger>
                  <SelectValue placeholder="Choose sync mode" />
                </SelectTrigger>
                <SelectContent>
                  {syncModeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Auth callback</span>
              <Input defaultValue={`${restBase}/auth/login`} readOnly />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Realtime stream</span>
              <Input defaultValue={`${realtimeBase}/sse`} readOnly />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" type="submit">
              <CheckIcon />
              Save API Base
            </Button>
            <Button variant="outline" size="sm" onClick={onContract}>
              <FileJsonIcon />
              View Contract
            </Button>
          </div>
        </form>

        <section className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <LockIcon className="size-4 text-primary" />
            Auth And Links
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The user identity links the project, agents, repositories, and API credentials before collaboration starts.
          </p>
          <div className="mt-4 grid gap-2">
            <Button size="sm">
              <ShieldCheckIcon />
              Authenticate User
            </Button>
            <Button variant="outline" size="sm" disabled>
              <BotIcon />
              Link Coding Agent
            </Button>
          </div>
          <div className="mt-4 space-y-2">
            <IntegrationLink label="OpenAPI schema" value="/openapi/openapi.json" />
            <IntegrationLink label="Projects REST" value={`${restBase}/taskflow_project/`} />
            <IntegrationLink label="Active project" value={`${restBase}/taskflow_project/${project.id}`} />
            <IntegrationLink label="Tasks REST" value={`${restBase}/taskflow_task/?project=${project.id}`} />
            <IntegrationLink label="Agents REST" value={`${restBase}/taskflow_agent/?project=${project.id}`} />
            <IntegrationLink label="Agent messages" value={`${restBase}/taskflow_agent_message/?project=${project.id}`} />
            <IntegrationLink label="Terminal frames" value={`${restBase}/taskflow_agent_terminal_frame/?project=${project.id}`} />
            <IntegrationLink label="Realtime runtime" value={`${realtimeBase}/client.js`} />
            <IntegrationLink label="Realtime SSE" value={`${realtimeBase}/sse`} />
            <IntegrationLink label="Realtime WS" value={`${realtimeBase}/ws`} />
          </div>
        </section>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <AgentSessionsTable sessions={sessions} agents={agents} credentials={credentials} />
        <AgentIdentityPanel project={project} agents={agents} />
      </div>
    </PageShell>
  )
}

function AgentSessionsTable({
  sessions,
  agents,
  credentials,
}: {
  sessions: TaskflowWorkspace["agentSessions"]
  agents: TaskflowWorkspace["agents"]
  credentials: TaskflowWorkspace["agentCredentials"]
}) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <TerminalIcon className="size-4 text-primary" />
            Agent Sessions
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Live sessions from taskflow_agent_session, with each agent's stable identifier and the credential prefix it authenticated with.
          </p>
        </div>
      </div>
      {sessions.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No agent sessions yet. Connected agents will appear here once they link to this project.
        </div>
      ) : (
        <div className="scrollbar-y overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-sm">
            <thead className="bg-muted/55 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Agent</th>
                <th className="px-4 py-2.5 text-left font-semibold">Stable identifier</th>
                <th className="px-4 py-2.5 text-left font-semibold">Credential</th>
                <th className="px-4 py-2.5 text-left font-semibold">Linked by</th>
                <th className="px-4 py-2.5 text-left font-semibold">Session</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => {
                const agent = agents.find((candidate) => candidate.id === session.agent)
                const credential =
                  credentials.find((item) => item.agent === session.agent && item.status === "active") ??
                  credentials.find((item) => item.agent === session.agent)
                const linkedBy =
                  agent?.linked_user_label ??
                  (session.connected_by != null ? `User #${session.connected_by}` : "Unlinked")
                return (
                  <tr key={session.id} className="border-t">
                    <td className="px-4 py-3 align-top">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                          <BotIcon className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{agent?.display_name ?? `Agent #${session.agent}`}</p>
                            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", agentSessionStatusClass(session.status))}>
                              {session.status}
                            </span>
                          </div>
                          <p className="mt-1 max-w-[16rem] truncate text-xs text-muted-foreground">
                            {agent?.runtime ? `${agent.runtime}${agent.version ? ` · ${agent.version}` : ""}` : "Runtime not reported"}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <code className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{agent?.identifier ?? "—"}</code>
                      <p className="mt-2 max-w-[16rem] truncate text-xs text-muted-foreground">
                        {agent?.taskflow_file_path ?? agent?.project_root ?? "No marker file recorded"}
                      </p>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {credential ? (
                        <>
                          <code className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary ring-1 ring-primary/20">
                            {credential.key_prefix}
                          </code>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {credential.name} · {credential.status}
                          </p>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">No credential linked</span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="font-medium">{linkedBy}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{formatLiveDate(session.connected_at, "—")}</p>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <code className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{session.session_identifier}</code>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {[session.host, session.pid != null ? `pid ${session.pid}` : null].filter(Boolean).join(" · ") || "No host reported"}
                        {" · "}
                        {formatLiveDate(session.last_seen_at ?? session.connected_at, "—")}
                      </p>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function AgentIdentityPanel({ project, agents }: { project: Project; agents: TaskflowWorkspace["agents"] }) {
  const agent = agents[0]
  const identity = agent
    ? {
        project_id: agent.project,
        display_name: agent.display_name,
        agent_identifier: agent.identifier,
        fingerprint: agent.fingerprint,
        status: agent.status,
        runtime: agent.runtime,
        version: agent.version,
        linked_by: agent.linked_user_label,
        project_root: agent.project_root,
        taskflow_file_path: agent.taskflow_file_path,
        last_seen_at: agent.last_seen_at,
        api_base: project.apiBase,
      }
    : null

  return (
    <aside className="space-y-3">
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <FileJsonIcon className="size-4 text-primary" />
          Identity Handshake
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Every agent writes a project-local identity marker before it can join sessions, channels, tasks, or activity.
        </p>
        <div className="mt-4 rounded-lg border bg-background p-3">
          {identity ? (
            <code className="block whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
              {JSON.stringify(identity, null, 2)}
            </code>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              No agents connected yet. Once an agent links to this project, its identity marker shows up here.
            </p>
          )}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheckIcon className="size-4 text-primary" />
          Link Rules
        </div>
        <div className="mt-4 space-y-3">
          <IdentityRule title="Display name is human readable" detail="It can be reused across sessions, so the stable identifier decides identity." />
          <IdentityRule title="Identifier survives restarts" detail="Returning agents should resume the same identity instead of creating duplicates." />
          <IdentityRule title="Credential prefix is safe to show" detail="Only the key prefix and label are ever displayed — the full key is never surfaced in the UI." />
          <IdentityRule title="Credentials are scoped" detail="Keys are issued per project and can be rotated or revoked without touching the agent identity." />
          <IdentityRule title="Linked by is explicit" detail="Every agent records the human or owner that connected it to the project." />
        </div>
      </section>
    </aside>
  )
}

function IdentityRule({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg bg-muted/55 p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
    </div>
  )
}

function agentSessionStatusClass(status: TaskflowWorkspace["agentSessions"][number]["status"]) {
  if (status === "connected") return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  if (status === "expired") return "bg-rose-100 text-rose-800 ring-rose-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}

function IntegrationLink({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/60 p-2.5">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <LinkIcon className="size-3.5 text-primary" />
        {label}
      </div>
      <p className="mt-1 break-all text-[0.72rem] leading-4 text-muted-foreground">{value}</p>
    </div>
  )
}

function InfoCard({ icon, title, value }: { icon: React.ReactNode; title: string; value: string }) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="text-primary">{icon}</span>
        {title}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{value}</p>
    </section>
  )
}

function WorkspaceDialog({
  mode,
  activeProject,
  reviewTask,
  onClose,
  onCreateProject,
  onUpdateProject,
  onCreateTask,
  onCreateInvite,
  onReviewDecision,
}: {
  mode: DialogMode
  activeProject: Project | undefined
  reviewTask?: Task
  onClose: () => void
  onCreateProject: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onUpdateProject: (event: FormEvent<HTMLFormElement>) => void
  onCreateTask: (event: FormEvent<HTMLFormElement>) => void
  onCreateInvite: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onReviewDecision: (event: FormEvent<HTMLFormElement>) => void
}) {
  // Dialog-local submit state so create/invite errors show INLINE and the
  // dialog stays open on failure. The dialog is keyed by `mode` at its call
  // site, so a mode change remounts it and resets this state — no effect needed.
  const [submitting, setSubmitting] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [formError, setFormError] = useState<string | null>(null)

  // Wrap an async submit handler: show the spinner, clear prior errors, and on
  // failure map ProjectFormError field errors + form message and stay open. On
  // success, close the dialog.
  async function runSubmit(
    event: FormEvent<HTMLFormElement>,
    handler: (event: FormEvent<HTMLFormElement>) => Promise<void>
  ) {
    event.preventDefault()
    setSubmitting(true)
    setFieldErrors({})
    setFormError(null)
    try {
      await handler(event)
      onClose()
    } catch (error) {
      if (error instanceof ProjectFormError) {
        setFieldErrors(error.fieldErrors)
        setFormError(error.message || "Please fix the errors below.")
      } else {
        setFormError(error instanceof Error ? error.message : "Something went wrong. Please try again.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (!mode) return null
  // Every mode except "new-project" acts on the active project. If there is no
  // active project, only project creation is valid.
  if (mode !== "new-project" && !activeProject) return null

  const titles: Record<Exclude<DialogMode, null>, string> = {
    "new-project": "Create Project",
    "edit-project": "Edit Project",
    "new-task": "Create Task",
    invite: "Invite User Or Agent",
    "api-contract": "API Contract",
    "review-decision": "Human Review",
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close dialog"
        className="fixed inset-0 z-[60] bg-foreground/15"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={titles[mode]}
        className="fixed inset-2 z-[70] flex flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[90svh] sm:w-[min(39rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2"
      >
        <header
          className="flex shrink-0 items-start justify-between gap-4 border-b px-5 py-4"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in oklab, var(--primary) 16%, transparent), transparent)",
          }}
        >
          <div>
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{activeProject?.name ?? "New workspace"}</p>
            <h2 className="mt-1 text-xl font-semibold">{titles[mode]}</h2>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <XIcon />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {mode === "new-project" ? (
          <form className="space-y-4 p-5" onSubmit={(event) => void runSubmit(event, onCreateProject)}>
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <FormField label="Project name" error={fieldErrors.name?.[0]}>
                <Input name="name" required placeholder="Acme Web App" />
              </FormField>
              <FormField label="Slug" error={fieldErrors.slug?.[0]}>
                <Input name="slug" placeholder="acme-web-app" />
              </FormField>
            </div>
            <FormField label="Description, markdown" error={fieldErrors.description_markdown?.[0]}>
              <textarea
                name="description_markdown"
                className={textareaClass}
                placeholder={"### Mission\nDescribe what this project owns and how humans/agents should operate."}
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Repository URL" error={fieldErrors.repository_url?.[0]}>
                <Input name="repository_url" placeholder="https://github.com/org/repo" />
              </FormField>
              <FormField label="API base" error={fieldErrors.default_api_base_url?.[0]}>
                <Input name="default_api_base_url" defaultValue="/api" />
              </FormField>
            </div>
            <DialogFormError message={formError} />
            <DialogActions onClose={onClose} submitLabel="Create Project" submitIcon={<FolderKanbanIcon />} submitting={submitting} />
          </form>
        ) : null}

        {mode === "edit-project" ? (
          <form className="space-y-4 p-5" onSubmit={onUpdateProject}>
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <FormField label="Project name">
                <Input name="name" required defaultValue={activeProject?.name ?? ""} />
              </FormField>
              <FormField label="Slug">
                <Input name="slug" defaultValue={slugifyProjectName(activeProject?.name ?? "")} />
              </FormField>
            </div>
            <FormField label="Description, markdown">
              <textarea
                name="description_markdown"
                className={textareaClass}
                defaultValue={activeProject?.objective ?? ""}
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Repository URL">
                <Input name="repository_url" placeholder="https://github.com/org/repo" />
              </FormField>
              <FormField label="API base">
                <Input name="default_api_base_url" defaultValue={activeProject?.apiBase ?? ""} />
              </FormField>
              <FormField label="Status">
                <SelectField
                  name="status"
                  defaultValue={activeProject?.status === "seeded" ? "active" : activeProject?.status ?? "active"}
                  options={projectStatusOptions}
                />
              </FormField>
            </div>
            <DialogActions onClose={onClose} submitLabel="Save Project" submitIcon={<CheckIcon />} />
          </form>
        ) : null}

        {mode === "new-task" ? (
          <form className="space-y-4 p-5" onSubmit={onCreateTask}>
            <FormField label="Task title">
              <Input name="title" required placeholder="Write the outcome, not just the activity" />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Status">
                <SelectField name="status" defaultValue="not_started" options={statusOptions} />
              </FormField>
              <FormField label="Priority">
                <SelectField name="priority" defaultValue="P1" options={priorityOptions} />
              </FormField>
              <FormField label="Owner">
                <Input name="owner" placeholder="Name, or leave unassigned" />
              </FormField>
              <FormField label="Operator">
                <Input name="operatorName" placeholder="Agent or human" />
              </FormField>
              <FormField label="Due">
                <Input name="due" placeholder="Date or milestone" />
              </FormField>
              <FormField label="Estimate">
                <Input name="estimate" placeholder="2h" />
              </FormField>
            </div>
            <FormField label="Tags">
              <Input name="tags" placeholder="api, review, frontend" />
            </FormField>
            <FormField label="Description, markdown">
              <textarea
                name="description"
                className={textareaClass}
                placeholder={"### Goal\nDescribe the outcome, acceptance criteria, and constraints."}
              />
            </FormField>
            <FormField label="Notes, markdown">
              <textarea
                name="notes"
                className={textareaClass}
                placeholder={"- Implementation detail\n- Link to related decision\n- Follow-up to verify"}
              />
            </FormField>
            <FormField label="Review gate">
              <textarea name="review" className={textareaClass} placeholder="What must a human approve before this can ship?" />
            </FormField>
            <DialogActions onClose={onClose} submitLabel="Create Task" submitIcon={<PlusIcon />} />
          </form>
        ) : null}

        {mode === "invite" ? (
          <form className="space-y-4 p-5" onSubmit={(event) => void runSubmit(event, onCreateInvite)}>
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <FormField label="Email or agent name">
                <Input name="recipient" required placeholder="teammate@example.com" />
              </FormField>
              <FormField label="Type">
                <SelectField name="type" defaultValue="user" options={inviteTypeOptions} />
              </FormField>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className={choiceClass}>
                <input type="radio" name="role" defaultChecked value="owner" />
                <span>Owner</span>
                <small>Full project control</small>
              </label>
              <label className={choiceClass}>
                <input type="radio" name="role" value="developer" />
                <span>Developer</span>
                <small>Tasks, agents, code</small>
              </label>
              <label className={choiceClass}>
                <input type="radio" name="role" value="viewer" />
                <span>Viewer</span>
                <small>Read-only context</small>
              </label>
            </div>
            <FormField label="Message">
              <textarea name="message" className={textareaClass} placeholder="Add context for the invite." />
            </FormField>
            <DialogFormError message={formError} />
            <DialogActions onClose={onClose} submitLabel="Send Invite" submitIcon={<UserRoundPlusIcon />} submitting={submitting} />
          </form>
        ) : null}

        {mode === "api-contract" ? (
          <form className="space-y-4 p-5" onSubmit={onUpdateProject}>
            <div className="rounded-xl border bg-background p-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FileJsonIcon className="size-4 text-primary" />
                Live API Preview
              </div>
              <code className="mt-3 block overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                GET {activeProject?.apiBase ?? ""}/workspace?include=tasks,agents,reviews,activity
              </code>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="API base">
                <Input name="default_api_base_url" defaultValue={activeProject?.apiBase ?? ""} />
              </FormField>
              <FormField label="Sync mode">
                <SelectField name="syncMode" defaultValue="realtime" options={syncModeOptions} />
              </FormField>
            </div>
            <FormField label="Required response keys">
              <textarea
                className={textareaClass}
                defaultValue={"project\nmembers\ntasks[].description\ntasks[].notes\nagents\nreviewQueue\nactivityCursor"}
              />
            </FormField>
            <DialogActions onClose={onClose} submitLabel="Save Contract" submitIcon={<CheckIcon />} />
          </form>
        ) : null}

        {mode === "review-decision" ? (
          <form className="space-y-4 p-5" onSubmit={onReviewDecision}>
            <div className="rounded-xl border bg-background p-3">
              <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Reviewing</p>
              <p className="mt-1 text-sm font-semibold">{reviewTask?.title ?? "No task selected"}</p>
              <MarkdownRenderer
                content={reviewTask?.review ?? "Select a task that needs review."}
                compact
                className="mt-2 [&_p]:text-sm"
              />
            </div>
            <FormField label="Decision">
              <SelectField name="decision" defaultValue="approve" options={reviewDecisionOptions} />
            </FormField>
            <FormField label="Decision note">
              <textarea name="note" className={textareaClass} placeholder="Add the reason. This becomes part of activity." />
            </FormField>
            <DialogActions onClose={onClose} submitLabel="Submit Decision" submitIcon={<ClipboardCheckIcon />} />
          </form>
        ) : null}
        </div>
      </section>
    </>
  )
}

const textareaClass =
  "min-h-24 w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50"

const choiceClass =
  "grid cursor-pointer gap-1 rounded-xl border bg-background p-3 text-sm transition has-checked:border-primary has-checked:bg-primary/10"

function FormField({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
      {error ? (
        <span className="text-xs font-normal text-destructive" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  )
}

/// Form-level error shown near a dialog's submit button. Renders nothing when
/// there is no message.
function DialogFormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  )
}

function SelectField({
  name,
  defaultValue,
  options,
  placeholder = "Select an option",
}: {
  name: string
  defaultValue: string
  options: { value: string; label: string }[]
  placeholder?: string
}) {
  return (
    <Select name={name} defaultValue={defaultValue} items={options}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function DialogActions({
  onClose,
  submitLabel,
  submitIcon,
  submitting = false,
}: {
  onClose: () => void
  submitLabel: string
  submitIcon: React.ReactNode
  submitting?: boolean
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t pt-4">
      <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button type="submit" size="sm" disabled={submitting}>
        {submitIcon}
        {submitting ? "Working…" : submitLabel}
      </Button>
    </div>
  )
}

export default App
