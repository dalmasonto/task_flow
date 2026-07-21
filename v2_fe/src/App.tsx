import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type UIEvent } from "react"
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom"
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BellIcon,
  BotIcon,
  CheckCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  Clock3Icon,
  ClipboardCheckIcon,
  CopyIcon,
  FileIcon,
  FileTextIcon,
  FileJsonIcon,
  GitBranchIcon,
  ImageIcon,
  InfoIcon,
  PaperclipIcon,
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
  RadioIcon,
  RotateCcwIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  SmileIcon,
  TerminalIcon,
  TimerIcon,
  UserIcon,
  UserRoundPlusIcon,
  UsersIcon,
  XIcon,
  Trash2 as Trash2Icon,
  PencilIcon,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { MarkdownRenderer, TaskChipContext } from "@/components/markdown-renderer"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
  API_BASE_URL,
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
  TaskflowAgent,
  TaskflowAgentMessage,
  TaskflowAgentMessagePriority,
  TaskflowAgentSession,
  TaskflowMessageAttachment,
  TaskflowProjectMember,
  TaskflowProjectInviteRole,
  TaskflowProjectInviteStatus,
  TaskflowProjectUpdate,
  TaskflowTaskPriority,
  TaskflowTaskReviewDecision,
  TaskflowTaskStatus,
} from "@/api/client"
import {
  addChannelMember,
  archiveTaskflowProject,
  createTaskflowChannel,
  createTaskflowProjectInvite,
  createTaskflowTaskActivity,
  createTaskflowTaskSession,
  createTaskflowTask,
  answerAgentPrompt,
  createTaskflowProject,
  ProjectFormError,
  fetchMyInvites,
  fetchTaskflowProjectSummary,
  fetchTaskflowWorkspace,
  linkAgent,
  markChannelRead,
  openTaskflowRealtimeStream,
  taskflowRealtimeGroups,
  isScopeDenial,
  realtimeEventHasInlineRow,
  reviewTask as submitTaskReview,
  sendTaskflowAgentMessage,
  taskflowApi,
  taskflowTables,
  updateTaskflowProject,
  updateTaskflowTask,
  updateTaskflowTaskSession,
  uploadTaskAttachment,
  sendTerminalKey,
  type LinkAgentResult,
  type RealtimeStatus,
  type TaskflowRealtimeEvent,
  type TaskflowProjectSummary,
  type TaskflowWorkspace,
} from "@/lib/taskflow-api"
import {
  addPending,
  dismissPending,
  findPending,
  isPending,
  markFailed,
  markRetrying,
  reconcile,
  removeMessage,
  type PendingAttachment,
} from "@/lib/message-store"
import { cn } from "@/lib/utils"
import { spliceAtCaret, fileReferenceText } from "@/lib/composer"
import { detectMention } from "@/lib/mention"
import { formatBytes } from "@/lib/attachment-kind"
import { formatEstimateMinutes, parseEstimateMinutes } from "@/lib/tasks"
import { firstLine } from "@/lib/markdown"
import { isoToDatetimeLocalInput, datetimeLocalInputToIso } from "@/lib/datetime"
import { activityTools, filterActivityEvents, ALL_TOOLS } from "@/lib/activity-filter"
import { filterBoardTasks, ALL_PRIORITIES, BOARD_PRIORITIES } from "@/lib/board-filter"
import { MessageAttachments } from "@/components/message-attachments"
import { AttachableTextarea, type AttachableFile } from "@/components/attachable-textarea"
import { useIsBelowLg } from "@/hooks/use-mobile"
import { AccountLayout } from "@/pages/account/AccountLayout"
import { ProfilePage } from "@/pages/account/ProfilePage"
import { SettingsPage } from "@/pages/account/SettingsPage"
import { InvitationsPage } from "@/pages/account/InvitationsPage"
import { SecurityPage } from "@/pages/account/SecurityPage"

type ColumnId = "not_started" | "in_progress" | "review" | "blocked" | "done"

type Priority = "critical" | "high" | "normal" | "low"

type DialogMode = "new-project" | "edit-project" | "project-info" | "new-task" | "edit-task" | "invite" | "api-contract" | "review-decision" | null

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
  /// Raw tool payload, rendered in the detail sheet. Absent for events that
  /// carry none (a status change has nothing more to show).
  metadata?: string | null
  /// Full timestamp for the sheet — the row shows a short one.
  timestamp?: string | null
  /// Whether this event is about a task, so the sheet can say which.
  taskLabel?: string | null
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

/// The view model for a rendered attachment — populated from real
/// `TaskflowMessageAttachment` rows (stored) or from staged files still being
/// uploaded (`pending`). `url` is `/media/<key>` for stored attachments and an
/// in-browser object URL for a pending image.
type AgentAttachment = {
  id: string
  name: string
  contentType: string
  sizeBytes: number
  url: string
  pending?: boolean
}

/// A file the user has staged in the composer but not yet sent. Keeps the real
/// File for upload plus an optional object URL used to preview images.
type StagedFile = {
  id: string
  file: File
  previewUrl?: string
}

type AgentMessage = {
  id: string
  from: string
  to?: string
  time: string
  /// Raw ISO timestamp from `message.created_at` — used for calendar-date
  /// grouping in the thread. Null/undefined for pending (optimistic) bubbles,
  /// which have not been acknowledged by the server and group under "Today".
  createdAt?: string | null
  body: string
  status: string
  priority?: MessagePriority
  choices?: string[]
  attachments?: AgentAttachment[]
  /// Set only on optimistic bubbles the server has not acknowledged. Carries the
  /// client_nonce so a failed bubble can be retried against the idempotent send.
  nonce?: string
  /// On a failed bubble, the reason the send was rejected (server `detail`, e.g.
  /// a too-large-file message) so the user sees WHY, not just that it failed.
  error?: string
  /// Set on the user's OWN last posted message once ANOTHER channel member's
  /// (user or agent) read cursor has advanced past it — drives the "Seen" caption.
  seen?: boolean
}

type ConversationMember = {
  name: string
  type: "human" | "agent"
  /// The agent's numeric id, for directing a channel message to it (#29). Set
  /// only on agent members.
  agentId?: number
}

type AgentChatContext = {
  id: string
  mode: "direct" | "channel"
  liveChannelId?: number
  liveAgentId?: number
  /// Set only on a human (member-to-member) DM: the target member's auth user id.
  /// Presence of this field (vs. liveAgentId) is how we tell a human DM from an
  /// agent DM — it drives the roster we create and whether the terminal appears.
  liveMemberUserId?: number
  title: string
  detail: string
  status: string
  members: ConversationMember[]
  primaryAgent: string
  unread: number
  /// Live presence for an agent DM (live session + heartbeat within 90s).
  /// Undefined for channels and human DMs, which have no agent presence.
  online?: boolean
  messages: AgentMessage[]
}

/// One streamed terminal frame, kept structured (stream + content) so the
/// transcript can colour by stream instead of flattening to prefixed text.
type TerminalLine = { stream: string; content: string }

type AgentTerminalSessionView = {
  agent: string
  /// The agent's numeric id — the target for terminal key presses (#12).
  agentId: number
  status: string
  connected: boolean
  /// Whether this session has real terminal frames. Drives which session the
  /// panel picks: one that is actually streaming beats one that merely exists.
  hasStream: boolean
  task: string
  cwd: string
  updated: string
  frames: TerminalLine[]
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
  createdBy: string
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
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
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

// Hand-rolled emoji picker data for the chat composer — a tiny inline set (no
// dependency) grouped into generic buckets. Insertion splices at the caret.
const composerEmojiGroups = [
  { label: "Recent", emojis: ["👍", "✅", "🎯", "🚀", "⏱️", "🙏", "💪", "🔥"] },
  { label: "Smileys", emojis: ["😀", "😄", "😂", "🙂", "😎", "🤝", "🙌", "👏"] },
  { label: "Objects", emojis: ["📦", "🧾", "📌", "⚠️", "🐛", "💡", "📸", "💵"] },
]

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
  if (priority === "critical") return "bg-rose-100 text-rose-800 ring-rose-200"
  if (priority === "high") return "bg-amber-100 text-amber-800 ring-amber-200"
  if (priority === "normal") return "bg-slate-100 text-slate-700 ring-slate-200"
  return "bg-muted text-muted-foreground ring-border"
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
  // Sort here rather than trusting insertion order. The initial fetch arrives
  // newest-first, but a realtime upsert APPENDS — so a live event landed at the
  // end of a 1500-row list and never appeared, even though the feed is paged
  // from the top. Ordering at the point that defines the display order makes
  // that impossible to get wrong again.
  return [...workspace.taskActivity]
    .sort((a, b) => {
      const byTime = Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "")
      return Number.isFinite(byTime) && byTime !== 0 ? byTime : b.id - a.id
    })
    .map((event) => {
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
      metadata: event.metadata_json,
      timestamp: event.created_at,
      taskLabel: relatedTask?.title ?? (event.task != null ? `Task #${event.task}` : null),
      }
    })
}

type ReviewFeedItem = {
  id: string
  taskId: string
  taskTitle: string
  reviewerLabel: string
  decision: TaskflowTaskReviewDecision
  body: string
  time: string
}

/// Maps the live workspace's real task reviews (from taskflow_task_review) into a
/// display feed, newest-first, resolving each review to its task title when the
/// task is loaded. Feeds both the Reviews queue "Latest review" column and the
/// "Recent reviews" panel.
function mapLiveReviews(workspace: TaskflowWorkspace, projectTasks: Task[]): ReviewFeedItem[] {
  return [...workspace.taskReviews]
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((review) => {
      const relatedTask = projectTasks.find((task) => liveId(task.id) === review.task)
      return {
        id: String(review.id),
        taskId: String(review.task),
        taskTitle: relatedTask?.title ?? `Task #${review.task}`,
        reviewerLabel: review.reviewer_label,
        decision: review.decision,
        body: review.body_markdown?.trim() ?? "",
        time: formatLiveDate(review.created_at, "Live"),
      }
    })
}

type TaskReviewEntry = {
  id: string
  reviewerLabel: string
  decision: TaskflowTaskReviewDecision
  body: string
  time: string
}

/// The reviews recorded on one task (taskflow_task_review), newest first,
/// resolved to a display feed for the sheet's Human Review Gate. The reviews ride
/// in the workspace payload and update over realtime (see applyRealtimeRow for
/// taskflow_task_review), so a review left while the sheet is open appears live.
function getLiveTaskReviews(task: Task, workspace: TaskflowWorkspace): TaskReviewEntry[] {
  const taskId = liveId(task.id)
  return workspace.taskReviews
    .filter((review) => review.task === taskId)
    .slice()
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id)
    .map((review) => ({
      id: String(review.id),
      reviewerLabel: review.reviewer_label,
      decision: review.decision,
      body: review.body_markdown?.trim() ?? "",
      time: formatLiveDate(review.created_at, "Live"),
    }))
}

/// A task's stored file attachments as display view models (reusing the message
/// attachment shape + renderer). `file` is a storage key → resolved to /media.
function getTaskAttachments(task: Task, workspace: TaskflowWorkspace): AgentAttachment[] {
  const taskId = liveId(task.id)
  return workspace.taskAttachments
    .filter((attachment) => attachment.task === taskId)
    .map((attachment) => ({
      id: String(attachment.id),
      name: attachment.name,
      contentType: attachment.content_type,
      sizeBytes: attachment.size_bytes,
      url: resolveAttachmentUrl(attachment.file),
    }))
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

/// A full, unambiguous timestamp for a detail view — the row shows the short
/// form, so the sheet is where seconds and the year belong.
function formatFullDate(value: string | null | undefined, fallback = "") {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date)
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

/// Time-only stamp for chat bubbles. The thread groups messages under sticky
/// date separators, so the per-message stamp carries just the clock time to
/// avoid repeating the date on every bubble.
function formatMessageTime(value: string | null | undefined, fallback = "Live") {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}

/// Conversation ids are structured like `live:channel:1` / `live:project-room`.
/// Colons must be percent-encoded in a URL path segment (ugly `%3A`), so map to
/// and from a clean slug for the route: strip the `live:` prefix and swap the
/// remaining colons for dashes (`channel-1`, `project-room`).
function chatIdToSlug(id: string): string {
  return id.replace(/^live:/, "").replace(/:/g, "-")
}

function slugToChatId(slug: string): string {
  const typed = /^(channel|direct|member|agent)-(\d+)$/.exec(slug)
  if (typed) return `live:${typed[1]}:${typed[2]}`
  return `live:${slug}`
}

/// How many messages a conversation renders at once. The thread windows to the
/// last N messages and reveals another page of N as the user scrolls to the top
/// (reverse-infinite-scroll). One constant serves both DMs and rooms — it's a
/// per-conversation window, not a global cap.
const MESSAGE_PAGE_SIZE = 20

/// Start-of-day timestamp (local time) for calendar-day comparisons.
function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/// Resolve a message's ISO `createdAt` to a real Date, falling back to "now" for
/// pending/undated bubbles — they are the newest thing in the room, so grouping
/// them under today's date is correct.
function messageDay(value: string | null | undefined): Date {
  if (value) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

/// A stable local calendar-day key for grouping consecutive messages.
function messageDayKey(value: string | null | undefined): string {
  const day = messageDay(value)
  return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
}

/// A friendly separator label: "Today" / "Yesterday" for the two most recent
/// days, otherwise a locale date like "Jul 18, 2026".
function formatDateSeparatorLabel(value: string | null | undefined): string {
  const day = messageDay(value)
  const today = startOfLocalDay(new Date())
  const target = startOfLocalDay(day)
  const oneDay = 24 * 60 * 60 * 1000
  if (target === today) return "Today"
  if (target === today - oneDay) return "Yesterday"
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

/// One rendered row in the thread: either a message bubble or a date separator
/// that sits above the first message of its calendar-day group.
type ThreadItem =
  | { type: "date"; key: string; label: string }
  | { type: "message"; message: AgentMessage }

/// Interleave centered date separators into a (windowed) message list so the
/// separators render in the right places without touching AgentChatBubble.
function buildThreadItems(messages: AgentMessage[]): ThreadItem[] {
  const items: ThreadItem[] = []
  let lastKey: string | null = null
  for (const message of messages) {
    const key = messageDayKey(message.createdAt)
    if (key !== lastKey) {
      items.push({ type: "date", key: `date:${key}`, label: formatDateSeparatorLabel(message.createdAt) })
      lastKey = key
    }
    items.push({ type: "message", message })
  }
  return items
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

// The board Priority now mirrors the backend priority 1:1 (critical/high/
// normal/low), so these are faithful identities — no lossy 3-level P-code
// squashing that used to make `low` indistinguishable from `normal` (and turn
// a `low` task into `normal` on edit).
function mapLivePriority(priority: TaskflowTaskPriority): Priority {
  return priority
}

function toLivePriority(priority: Priority): TaskflowTaskPriority {
  return priority
}

/// An agent heartbeats while it holds a live session; a stale heartbeat means it
/// went away without a clean disconnect. 90s is the backend's liveness window
/// (`AGENT_HEARTBEAT_WINDOW_SECS` in taskflow-agents/src/views.rs — keep equal).
const AGENT_HEARTBEAT_WINDOW_MS = 90_000

/// How often the app re-evaluates liveness.
///
/// Liveness is a function of TIME, not of data: an agent that dies sends nothing,
/// so no realtime event arrives and no re-render happens. Deriving it only when
/// the workspace changes froze the last known answer — a dead agent kept showing
/// a green "online" dot indefinitely, because the `now` used to judge it was
/// itself minutes stale. This tick is the clock that makes staleness observable.
const LIVENESS_TICK_MS = 30_000

/// A wall-clock reading that refreshes on a fixed interval, so time-derived state
/// (online dots, "connected" badges) goes stale on its own.
///
/// Returns the timestamp rather than a bare counter so callers PASS it into the
/// mappers. That keeps `now` an explicit input — a mapper that reads the clock
/// internally looks pure but silently depends on when it ran, which is what let
/// a dead agent keep a green dot.
function useLivenessNow(enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), LIVENESS_TICK_MS)
    return () => window.clearInterval(timer)
  }, [enabled])
  return now
}

function isRecentHeartbeat(timestamp: string | null | undefined, now: number): boolean {
  if (!timestamp) return false
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) && now - parsed <= AGENT_HEARTBEAT_WINDOW_MS
}

/// THE definition of a live session, so every counter and badge agrees.
///
/// `status === "connected"` alone is not proof of life: nothing sweeps sessions,
/// so a process that dies without closing leaves a row claiming to be connected
/// forever. Counting those is how the sidebar came to advertise "2 connected
/// sessions" for an agent that had been gone for twelve minutes.
function isSessionLive(
  session: Pick<TaskflowAgentSession, "status" | "last_seen_at">,
  now: number
): boolean {
  return session.status === "connected" && isRecentHeartbeat(session.last_seen_at, now)
}

/// Live online state for an agent: it must have a CONNECTED session heartbeated
/// within the window, or (fallback) the agent row itself must be in a live status
/// and heartbeated within the window. A disconnected/expired session, or a status
/// row that stopped heartbeating, reads as offline.
function isAgentOnline(
  agentId: number,
  agents: Pick<TaskflowAgent, "id" | "status" | "last_seen_at">[],
  sessions: Pick<TaskflowAgentSession, "agent" | "status" | "last_seen_at">[],
  now: number
): boolean {
  const hasLiveSession = sessions.some(
    (session) => session.agent === agentId && isSessionLive(session, now)
  )
  if (hasLiveSession) return true
  const agent = agents.find((item) => item.id === agentId)
  return (
    !!agent &&
    ["connected", "idle", "busy"].includes(agent.status) &&
    isRecentHeartbeat(agent.last_seen_at, now)
  )
}

/// Count of agents online at `now` (live session, or a live status still inside
/// the heartbeat window). `now` is a parameter so the caller controls when the
/// judgement is made — see useLivenessNow.
function countOnlineAgents(workspace: TaskflowWorkspace, now: number): number {
  return workspace.agents.filter((agent) =>
    isAgentOnline(agent.id, workspace.agents, workspace.agentSessions, now)
  ).length
}

function mapLiveProjects(summary: TaskflowProjectSummary): Project[] {
  const now = Date.now()
  return summary.projects.map((project, index) => {
    const members = summary.members.filter((member) => member.project === project.id && member.status === "active").length
    const onlineAgents = summary.agents.filter(
      (agent) => agent.project === project.id && isAgentOnline(agent.id, summary.agents, summary.sessions, now)
    ).length
    const connectedSessions = summary.sessions.filter(
      (session) => session.project === project.id && isSessionLive(session, now)
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
      agentsOnline: onlineAgents,
      apiBase: project.default_api_base_url || "/api",
    }
  })
}

function mapLiveTasks(
  tasks: TaskflowProjectSummary["tasks"] | TaskflowWorkspace["tasks"],
  members: TaskflowProjectMember[],
  agents: TaskflowAgent[]
): Task[] {
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
      operatorName: task.operator_user
        ? (members.find((m) => m.user === task.operator_user)?.display_name ?? `User #${task.operator_user}`)
        : task.operator_agent_id
          ? (agents.find((a) => a.id === task.operator_agent_id)?.display_name ?? `Agent #${task.operator_agent_id}`)
          : assignee,
      createdBy: task.created_by_agent_id
        ? (agents.find((a) => a.id === task.created_by_agent_id)?.display_name ?? `Agent #${task.created_by_agent_id}`)
        : task.created_by
          ? (members.find((m) => m.user === task.created_by)?.display_name ?? `User #${task.created_by}`)
          : "Unknown",
      estimate: formatEstimateMinutes(task.estimate_minutes),
      updated: formatLiveDate(task.updated_at ?? task.created_at, "Live API"),
      due: formatLiveDate(task.due_at, "Unscheduled"),
      tags: ["live-api"],
      blockers: [],
      review: task.review_gate ?? (task.status === "partial_done" ? "Waiting for human review." : "No explicit review gate on the live task."),
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
    ...workspace.agents.map((agent) => ({ name: agent.display_name, type: "agent" as const, agentId: agent.id })),
  ])
}

function mapLiveChannelMembers(
  workspace: TaskflowWorkspace,
  channelId: number,
  currentUser: AuthUser | null,
  // A group room always includes the current user, the active project members
  // and the project's agents. A DM does NOT — it is exactly its two rostered
  // participants — so this stays false there.
  includeWorkspace = false
): ConversationMember[] {
  const recorded = workspace.agentChannelMembers
    .filter((member) => member.channel === channelId)
    .map((member) => ({
      name: member.display_name,
      type: member.member_kind === "agent" ? ("agent" as const) : ("human" as const),
      agentId: member.member_kind === "agent" ? (member.agent ?? undefined) : undefined,
    }))

  // Recorded rows can be partial — an agent posts before every human is rostered,
  // say — so for a group room they ADD to the workspace roster rather than
  // replacing it. Otherwise a member (even you) "randomly" vanishes once any row
  // exists for the channel.
  if (includeWorkspace) {
    return uniqueMembers([...recorded, ...workspaceDefaultMembers(workspace, currentUser)])
  }

  return recorded.length ? uniqueMembers(recorded) : workspaceDefaultMembers(workspace, currentUser)
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
  // Read receipt: the highest message id any OTHER member (user or agent) has
  // read in this channel. The user's own last message counts as "Seen" once it
  // sits at or below that watermark.
  const otherCursorWatermark = workspace.channelReadCursors
    .filter(
      (cursor) =>
        cursor.channel === channelId &&
        !(cursor.member_kind === "user" && currentUser != null && cursor.member_user === currentUser.id)
    )
    .reduce((max, cursor) => Math.max(max, cursor.last_read_message ?? 0), 0)
  const ownMessageIds = workspace.agentMessages
    .filter(
      (message): message is TaskflowAgentMessage =>
        !isPending(message) &&
        message.channel === channelId &&
        message.sender_kind === "user" &&
        currentUser != null &&
        message.sender_user === currentUser.id
    )
    .map((message) => message.id)
  const lastOwnMessageId = ownMessageIds.length ? Math.max(...ownMessageIds) : null
  const seenOwnMessageId =
    lastOwnMessageId != null && lastOwnMessageId <= otherCursorWatermark ? lastOwnMessageId : null

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
          createdAt: null,
          body: message.body_markdown,
          status: message.status === "failed" ? "failed" : "sending",
          error: message.error,
          priority: mapLiveMessagePriority(message.priority),
          attachments: (message.attachments ?? []).map(mapPendingAttachment),
        }
      }
      return {
        id: String(message.id),
        from: message.sender_kind === "user" && currentUser && message.sender_user === currentUser.id ? "user" : message.sender_label,
        to: channelTitle,
        time: formatMessageTime(message.created_at, "Live"),
        createdAt: message.created_at,
        body: message.body_markdown,
        status: "posted",
        priority: mapLiveMessagePriority(message.priority),
        seen: seenOwnMessageId != null && message.id === seenOwnMessageId,
        attachments: workspace.messageAttachments
          .filter((attachment) => attachment.message === message.id)
          .map(mapStoredAttachment),
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

/// Unread count for the current user in a channel: saved messages newer than
/// the user's own read cursor that the user did NOT author. With no cursor, it's
/// every message not authored by the user. Pending (unsent) bubbles never count.
function channelUnreadCount(
  workspace: TaskflowWorkspace,
  channelId: number,
  currentUser: AuthUser | null
): number {
  if (!currentUser) return 0
  const cursor = workspace.channelReadCursors.find(
    (row) => row.channel === channelId && row.member_kind === "user" && row.member_user === currentUser.id
  )
  const lastRead = cursor?.last_read_message ?? 0
  return workspace.agentMessages.filter(
    (message) =>
      !isPending(message) &&
      message.channel === channelId &&
      message.id > lastRead &&
      !(message.sender_kind === "user" && message.sender_user === currentUser.id)
  ).length
}

function mapLiveChannelChats(workspace: TaskflowWorkspace, currentUser: AuthUser | null): AgentChatContext[] {
  const projectChannels = workspace.agentChannels.filter((channel) => !channel.archived && channel.kind !== "direct")
  const chats = projectChannels.map((channel) => {
    const members = mapLiveChannelMembers(workspace, channel.id, currentUser, true)
    return {
      id: `live:channel:${channel.id}`,
      mode: "channel" as const,
      liveChannelId: channel.id,
      title: channel.title,
      detail: channel.topic || `Shared ${channel.kind} channel for this project.`,
      status: liveChannelStatus(channel),
      members,
      primaryAgent: primaryAgentName(workspace, members),
      unread: channelUnreadCount(workspace, channel.id, currentUser),
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

/// A direct message has one participant on each side — you and exactly one other
/// person or agent. More than that is a group conversation wearing a DM's name.
const DIRECT_CHANNEL_PARTICIPANTS = 2

function mapLiveDirectChats(workspace: TaskflowWorkspace, currentUser: AuthUser | null, now: number): AgentChatContext[] {
  // A DM is EXACTLY two participants, and you must be one of them.
  //
  // The server now scopes these rows too, so this is defence in depth rather
  // than the gate — but it also enforces the shape: a "direct" channel that has
  // somehow collected a third participant is not a private conversation, and
  // showing it as one would put two other people's words under a title that
  // claims it is just you and them. Anything wider belongs in a group room.
  const directChannels = workspace.agentChannels.filter((channel) => {
    if (channel.archived || channel.kind !== "direct") return false
    const roster = workspace.agentChannelMembers.filter((member) => member.channel === channel.id)
    const onRoster = roster.some(
      (member) => member.member_kind === "user" && member.user != null && member.user === currentUser?.id
    )
    return onRoster && roster.length === DIRECT_CHANNEL_PARTICIPANTS
  })
  const chats = directChannels.map((channel) => {
    const rawMembers = workspace.agentChannelMembers.filter((member) => member.channel === channel.id)
    const agentMember = rawMembers.find((member) => member.member_kind === "agent" && member.agent)
    const agent = workspace.agents.find((candidate) => candidate.id === agentMember?.agent)
    // The other human on the roster (not me) — the counterpart of a human DM.
    const otherUserMember = rawMembers.find(
      (member) => member.member_kind === "user" && member.user != null && member.user !== currentUser?.id
    )
    const members = mapLiveChannelMembers(workspace, channel.id, currentUser)
    // Identity follows the roster: an agent DM is named for its agent (and drives
    // the terminal); a human DM is named for the other person — NOT the first
    // agent in the project, which the old fallback wrongly used.
    const title = agent?.display_name ?? otherUserMember?.display_name ?? channel.title

    return {
      id: `live:direct:${channel.id}`,
      mode: "direct" as const,
      liveChannelId: channel.id,
      liveAgentId: agent?.id,
      liveMemberUserId: agent ? undefined : (otherUserMember?.user ?? undefined),
      title,
      detail: channel.topic || (agent ? agent.project_root || agent.identifier : "Direct message"),
      status: liveChannelStatus(channel),
      members,
      primaryAgent: title,
      unread: channelUnreadCount(workspace, channel.id, currentUser),
      online: agent ? isAgentOnline(agent.id, workspace.agents, workspace.agentSessions, now) : undefined,
      messages: mapLiveChannelMessages(workspace, channel.id, title, currentUser),
    }
  })
  // A direct channel already covers a member/agent when its roster holds that
  // user/agent besides the current user, so we don't double-list it as a
  // placeholder. Keyed by user id / agent id read straight off the roster rows.
  const coveredAgentIds = new Set<number>()
  const coveredUserIds = new Set<number>()
  for (const channelChat of chats) {
    const rawMembers = workspace.agentChannelMembers.filter((member) => member.channel === channelChat.liveChannelId)
    for (const member of rawMembers) {
      if (member.member_kind === "agent" && member.agent) coveredAgentIds.add(member.agent)
      if (member.member_kind === "user" && member.user && member.user !== currentUser?.id) coveredUserIds.add(member.user)
    }
  }

  const selfMember: ConversationMember = currentUser
    ? { name: currentUser.username, type: "human" }
    : { name: "You", type: "human" }

  // Every active project member (except me) becomes a DM target. The live
  // channel is created lazily on first send (see ensureLiveChannel).
  const memberPlaceholders = workspace.members
    .filter(
      (member) =>
        member.status === "active" &&
        member.user != null &&
        member.user !== currentUser?.id &&
        !coveredUserIds.has(member.user)
    )
    .map((member) => ({
      id: `live:member:${member.user}`,
      mode: "direct" as const,
      liveMemberUserId: member.user as number,
      title: member.display_name,
      detail: member.role || "Direct message",
      status: "Direct",
      members: uniqueMembers([selfMember, { name: member.display_name, type: "human" as const }]),
      primaryAgent: member.display_name,
      unread: 0,
      messages: [],
    }))

  const agentPlaceholders = workspace.agents
    .filter((agent) => !coveredAgentIds.has(agent.id))
    .map((agent) => ({
      id: `live:agent:${agent.id}`,
      mode: "direct" as const,
      liveAgentId: agent.id,
      title: agent.display_name,
      detail: agent.project_root || agent.identifier,
      status: agent.status,
      members: uniqueMembers([selfMember, { name: agent.display_name, type: "agent" as const }]),
      primaryAgent: agent.display_name,
      unread: 0,
      online: isAgentOnline(agent.id, workspace.agents, workspace.agentSessions, now),
      messages: [],
    }))

  return [...chats, ...memberPlaceholders, ...agentPlaceholders]
}

/// Label for a session, given the stored status and whether it is actually live.
/// `expired` is kept distinct from a plain disconnect — it says the backend aged
/// the session out, which is a different story from a clean close.
function mapLiveTerminalStatus(
  status: TaskflowWorkspace["agentSessions"][number]["status"],
  live: boolean
) {
  if (status === "expired") return "Expired"
  return live ? "Connected" : "Disconnected"
}

function mapLiveTerminalSessions(workspace: TaskflowWorkspace, now: number): AgentTerminalSessionView[] {
  const sessions = workspace.agentSessions.map((session) => {
    const agent = workspace.agents.find((candidate) => candidate.id === session.agent)
    const rows = workspace.terminalFrames
      .filter((frame) => frame.session === session.id || (!frame.session && frame.agent === session.agent))
      .slice()
      .sort((a, b) => a.sequence - b.sequence || a.id - b.id)
    // A session row saying `connected` proves nothing on its own: a process that
    // dies never closes it. The same rule as isAgentOnline — connected AND
    // heartbeated recently — so the terminal header and the roster dot can never
    // disagree about the same agent.
    const live = isSessionLive(session, now)
    const frames: TerminalLine[] = rows.length
      ? rows.map((frame) => ({ stream: frame.stream, content: frame.content }))
      : [
          { stream: "system", content: `agent session ${session.session_identifier}` },
          // Honest about WHY it is empty. Registering a session does not stream a
          // terminal — only the tmux mirror does — so "waiting for output" was a
          // promise nothing was going to keep.
          {
            stream: "system",
            content: live
              ? "No terminal stream for this session. To watch this agent's terminal, run:"
              : "This session is not live, and never streamed a terminal. To mirror one, run:",
          },
          { stream: "system", content: "  taskflow-v2-mcp --tmux <pane>    (see: tmux list-panes -a)" },
        ]

    return {
      agent: agent?.display_name ?? `Agent #${session.agent}`,
      agentId: session.agent,
      status: mapLiveTerminalStatus(session.status, live),
      connected: live,
      hasStream: rows.length > 0,
      task: agent?.status ? `Agent is ${agent.status}` : "Live agent session",
      cwd: session.cwd || agent?.project_root || "/",
      updated: formatLiveDate(session.last_seen_at ?? session.connected_at, "Live"),
      frames,
    }
  })

  // Order the pick: a session actually streaming a terminal first, then a live
  // one, then the rest. Selecting by array order handed the panel whichever
  // session happened to be created first — usually the hook's claude-code
  // session, which never streams — while the mirror sat further down the list.
  sessions.sort((a, b) => {
    if (a.hasStream !== b.hasStream) return a.hasStream ? -1 : 1
    if (a.connected !== b.connected) return a.connected ? -1 : 1
    return 0
  })

  if (sessions.length) return sessions

  return workspace.agents.map((agent) => {
    // Same rule again: a live-looking status column with a stale heartbeat is a
    // dead agent, not a connected one.
    const online =
      ["connected", "idle", "busy"].includes(agent.status) &&
      isRecentHeartbeat(agent.last_seen_at, now)
    return {
      agent: agent.display_name,
      agentId: agent.id,
      status: online ? "Connected" : "Disconnected",
      connected: online,
      hasStream: false,
      task: `Agent is ${agent.status}`,
      cwd: agent.project_root || "/",
      updated: formatLiveDate(agent.last_seen_at, "No session"),
      frames: [
        { stream: "system", content: "No agent session has registered yet." },
        { stream: "system", content: "  taskflow-v2-mcp --tmux <pane>    to mirror a terminal here" },
      ],
    }
  })
}

/// The FileField value reaches the client in three shapes depending on the
/// delivery path: the send-response returns a bare storage key (plus an explicit
/// resolved `url`), a REST read resolves it to `/media/<key>`, and realtime
/// projects the bare key. Normalize them: honor a value that is already an
/// absolute URL/path (or a local blob preview), and only prepend the media mount
/// to a bare storage key. Never double-prefix a value the backend already
/// resolved.
function resolveAttachmentUrl(raw: string | null | undefined): string {
  if (!raw) return ""
  if (/^(https?:|blob:|\/)/.test(raw)) return raw
  return `/media/${raw}`
}

/// Resolve a stored attachment row to the display view model.
function mapStoredAttachment(attachment: TaskflowMessageAttachment): AgentAttachment {
  return {
    id: String(attachment.id),
    name: attachment.name,
    contentType: attachment.content_type,
    sizeBytes: attachment.size_bytes,
    url: resolveAttachmentUrl((attachment as { url?: string | null }).url ?? attachment.file),
  }
}

/// A staged-but-unsent file's local preview → view model. Object URLs stand in
/// for images until the server echoes the stored attachment back.
function mapPendingAttachment(attachment: PendingAttachment): AgentAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    contentType: attachment.content_type,
    sizeBytes: attachment.size_bytes,
    url: attachment.url,
    pending: true,
  }
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
  // The task.id being edited; the edit dialog reuses the Create Task form.
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  // Controlled state for the Create Task dialog's owner/operator/due fields.
  // shadcn Select and datetime-local are controlled, and handleCreateTask reads
  // these from state (not FormData); the rest of the form stays uncontrolled.
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
  const activityEvents = useMemo<ActivityEvent[]>(
    () => (activeLiveWorkspace ? mapLiveActivityEvents(activeLiveWorkspace, projectTasks) : []),
    [activeLiveWorkspace, projectTasks]
  )
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
          applyWorkspaceUpdate(projectId, (workspace) => ({ ...workspace, terminalFrames: upsertById(workspace.terminalFrames, frame) }))
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
                    <Button variant="outline" size="sm" onClick={() => setDialogMode("new-task")}>
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
                    // Each column is ordered by task #id (ascending). Dragging a
                    // card to another column still changes its status; within a
                    // column the id-sort wins, so manual reordering is dropped.
                    const columnTasks = boardFilteredTasks
                      .filter((task) => task.status === column.id)
                      .sort((a, b) => {
                        const na = Number(a.id)
                        const nb = Number(b.id)
                        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
                        return a.id.localeCompare(b.id)
                      })
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
                              <p className="text-xs text-muted-foreground">{columnTasks.length} tasks</p>
                            </div>
                          </div>
                          <Button variant="ghost" size="icon-sm">
                            <MoreHorizontalIcon />
                          </Button>
                        </div>
                        <div className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
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
                  />
                ) : (
                  <NoProjectEmptyState onNewProject={() => setDialogMode("new-project")} syncing={isLiveSyncing} />
                )
              }
            >
              <Route index element={<AgentsConversationEmpty />} />
              <Route path=":conversationId" element={<AgentsConversationView />} />
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
          onEdit={() => {
            const row = activeLiveWorkspace?.tasks.find((task) => String(task.id) === openTask.id)
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
            setEditTaskId(openTask.id)
            setDialogMode("edit-task")
          }}
          onDelete={() => handleDeleteTask(openTask.id)}
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
          onUploadAttachment={(files) => void handleUploadTaskAttachment(openTask.id, files)}
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
        editTask={editTaskSeed}
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
    </SidebarProvider>
    </TaskChipContext.Provider>
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
            <span className={cn("rounded-full px-2 py-0.5 text-[0.68rem] font-semibold capitalize ring-1", priorityClass(task.priority))}>
              {task.priority}
            </span>
            {/* The task # so a card can be identified at a glance / referenced. */}
            <span className="shrink-0 font-mono text-[0.68rem] font-medium text-muted-foreground">#{task.id}</span>
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
  onEdit,
  onDelete,
  onMove,
  onOpenTask,
  onOpenReview,
  onOpenMessage,
  onStartSession,
  onPauseSession,
  onStopSession,
  onUploadAttachment,
}: {
  task: Task
  project: Project
  projectTasks: Task[]
  liveWorkspace?: TaskflowWorkspace | null
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onMove: (status: ColumnId) => void
  onOpenTask: (taskId: string) => void
  onOpenReview: () => void
  onOpenMessage: () => void
  onStartSession: (task: Task) => void
  onPauseSession: (task: Task) => void
  onStopSession: (task: Task, finalStatus: Extract<TaskflowTaskStatus, "done" | "partial_done" | "blocked">) => void
  onUploadAttachment: (files: File[]) => void
}) {
  const currentStatus = columns.find((column) => column.id === task.status)
  const attachments = liveWorkspace ? getTaskAttachments(task, liveWorkspace) : []
  // Two-step delete: the first click arms it, the second confirms — no
  // AlertDialog component exists and window.confirm is off-brand.
  const [confirmDelete, setConfirmDelete] = useState(false)
  const sessions = liveWorkspace ? getLiveTaskSessions(task, liveWorkspace) : getTaskSessions(task)
  const runningSession = liveWorkspace ? getRunningLiveTaskSession(task, liveWorkspace) : undefined
  const totalSessionSeconds = liveWorkspace ? getTaskSessionTotalSeconds(task, liveWorkspace) : null
  const relations = liveWorkspace ? getLiveTaskRelations(task, projectTasks, liveWorkspace) : getTaskRelations(task, projectTasks)
  const activity = liveWorkspace ? getLiveTaskActivity(task, liveWorkspace) : getFallbackTaskActivity(task)
  const reviews = liveWorkspace ? getLiveTaskReviews(task, liveWorkspace) : []
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
                <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold capitalize ring-1", priorityClass(task.priority))}>
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
            <div className="flex shrink-0 items-center gap-1.5">
              {confirmDelete ? null : (
                <Button variant="ghost" size="sm" onClick={onEdit}>
                  <PencilIcon className="size-4" />
                  Edit
                </Button>
              )}
              {confirmDelete ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setConfirmDelete(false)
                      onDelete()
                    }}
                  >
                    Confirm delete
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2Icon className="size-4" />
                  Delete
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" onClick={onClose}>
                <XIcon />
              </Button>
            </div>
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
                  <Info label="Created by" value={task.createdBy} />
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
                icon={<PaperclipIcon className="size-4 text-primary" />}
                title="Attachments"
                action={
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition hover:bg-muted">
                    <PaperclipIcon className="size-3.5" />
                    Attach
                    <input
                      type="file"
                      multiple
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? [])
                        if (files.length) onUploadAttachment(files)
                        event.target.value = ""
                      }}
                    />
                  </label>
                }
              >
                {attachments.length ? (
                  <MessageAttachments attachments={attachments} />
                ) : (
                  <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                    No attachments yet. Attach an image to give the agent visual context.
                  </p>
                )}
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

                <div className="mt-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                    {reviews.length ? `Reviews (${reviews.length})` : "Reviews"}
                  </p>
                  {reviews.length ? (
                    reviews.map((review) => (
                      <div key={review.id} className="rounded-lg border bg-background/60 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-semibold">{review.reviewerLabel}</span>
                            <span
                              className={cn(
                                "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                                reviewDecisionClass(review.decision)
                              )}
                            >
                              {reviewDecisionLabel(review.decision)}
                            </span>
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">{review.time}</span>
                        </div>
                        {review.body ? (
                          <MarkdownRenderer content={review.body} compact className="mt-2 [&_p]:text-sm" />
                        ) : (
                          <p className="mt-2 text-sm italic text-muted-foreground">No note left.</p>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                      No human reviews yet.
                    </p>
                  )}
                </div>
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
  // #35: minimized by default so the dock never covers the chat input / terminal
  // keypad at the bottom; expand to see and control sessions.
  const [expanded, setExpanded] = useState(false)
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

  const sessionCount = runningSessions.length + pausedTasks.length
  if (!liveWorkspace || sessionCount === 0) return null

  // Minimized: a compact pill in the corner so it never overlaps the chat input
  // or terminal keypad (which live at the bottom-center). Click to expand.
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title="Show active sessions"
        className="fixed bottom-3 right-3 z-[65] inline-flex items-center gap-2 rounded-full border bg-background/95 px-3 py-2 text-xs font-medium shadow-lg backdrop-blur transition hover:bg-muted"
      >
        <TimerIcon className="size-4 text-primary" />
        {runningSessions.length ? (
          <span className="inline-block size-2 animate-pulse rounded-full bg-emerald-500" />
        ) : null}
        {sessionCount} session{sessionCount === 1 ? "" : "s"}
        <ChevronUpIcon className="size-3.5 text-muted-foreground" />
      </button>
    )
  }

  return (
    <section className="fixed bottom-3 right-3 z-[65] flex max-h-[60vh] w-[min(30rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-background/95 shadow-2xl backdrop-blur">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <TimerIcon className="size-4 text-primary" />
          Sessions ({sessionCount})
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setExpanded(false)}
          title="Minimize"
          aria-label="Minimize sessions"
        >
          <ChevronDownIcon />
        </Button>
      </div>
      <div className="scrollbar-y flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {runningSessions.map((session) => {
          const task = taskById.get(session.task)
          if (!task) return null
          void tick
          return (
            <div key={session.id} className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2">
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
          <div key={task.id} className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2 opacity-85">
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
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{session.actor}</p>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize ring-1", tone)}>
          {session.state}
        </span>
      </div>
      <MarkdownRenderer content={session.detail} compact className="mt-1" />
      {/* Left-aligned label/value grid: labels in a fixed first column so
          Started and Duration line up under each other on the left. */}
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-left text-xs">
        <span className="text-muted-foreground">Started</span>
        <span className="font-medium">{session.started}</span>
        <span className="text-muted-foreground">Duration</span>
        <span className="font-medium">{session.duration}</span>
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

/// The data + handlers the layout hands to whichever conversation route renders
/// in its <Outlet/>. `selectedChat` is resolved from the route param upstream;
/// it is null on the index route or when the param doesn't match a real chat.
export type AgentsOutletContext = {
  selectedChat: AgentChatContext | null
  selectedSession?: AgentTerminalSessionView
  onSendMessage: (chat: AgentChatContext, body: string, priority: MessagePriority, files: File[], targetAgent?: number | null) => void
  onRetryMessage: (nonce: string) => void
  onCancelMessage: (nonce: string) => void
  canManageMembers: boolean
  addMemberCandidates: { user: number; name: string }[]
  onAddMember: (userId: number) => Promise<void>
  currentUser: AuthUser | null
  /// The question the selected agent is blocked on, if any.
  pendingPrompt?: TaskflowWorkspace["agentPrompts"][number]
  onAnswerPrompt: (promptId: number, answers: number[][], cancel?: boolean, texts?: (string | null)[]) => Promise<void>
}

function useAgentsOutletContext() {
  return useOutletContext<AgentsOutletContext>()
}

function AgentsPage({
  project,
  liveWorkspace,
  currentUser,
  onWorkspaceUpdate,
  onRefreshWorkspace,
}: {
  project: Project
  liveWorkspace: TaskflowWorkspace | null
  currentUser: AuthUser | null
  onWorkspaceUpdate: (updater: (workspace: TaskflowWorkspace) => TaskflowWorkspace) => void
  onRefreshWorkspace: () => Promise<void>
}) {
  const navigate = useNavigate()
  const { conversationId } = useParams()
  const isBelowLg = useIsBelowLg()
  const [messageError, setMessageError] = useState<string | null>(null)
  // `livenessNow` is passed in, not read inside: these mappers decide who is
  // online, and without a refreshing clock a silent agent keeps its last known
  // (green) state forever — no data changes, no re-map, no staleness.
  const livenessNow = useLivenessNow()
  const directChats = useMemo<AgentChatContext[]>(
    () => (liveWorkspace ? mapLiveDirectChats(liveWorkspace, currentUser, livenessNow) : []),
    [currentUser, liveWorkspace, livenessNow]
  )
  const channelChats = useMemo<AgentChatContext[]>(
    () => (liveWorkspace ? mapLiveChannelChats(liveWorkspace, currentUser) : []),
    [currentUser, liveWorkspace]
  )
  const allChats = useMemo(() => [...channelChats, ...directChats], [channelChats, directChats])
  // The active conversation is addressed by the route param, not local state.
  // Ids contain colons (e.g. "live:direct:2"); they map to a clean URL slug
  // (`direct-2`) via chatIdToSlug/slugToChatId so the address bar stays readable.
  // null on the index route (no param) or when the param doesn't resolve to a
  // real chat — the message area shows an empty state in both cases.
  const selectedChat = useMemo<AgentChatContext | null>(() => {
    if (!conversationId) return null
    const decodedId = slugToChatId(conversationId)
    return allChats.find((chat) => chat.id === decodedId) ?? null
  }, [allChats, conversationId])
  // Default to the project room (the first group chat) on the index route, so
  // the page opens on a conversation rather than the empty state. Falls back to
  // the first DM; the empty state shows only when there are no conversations.
  // Only auto-open on DESKTOP: on mobile the index route must land on the
  // full-screen conversation LIST so the user taps in deliberately (jumping
  // straight into a thread would hide the list behind a back button).
  useEffect(() => {
    if (conversationId || isBelowLg) return
    const first = channelChats[0] ?? directChats[0]
    if (first) navigate(chatIdToSlug(first.id), { replace: true })
  }, [conversationId, isBelowLg, channelChats, directChats, navigate])
  const terminalSessions = useMemo(
    () => (liveWorkspace ? mapLiveTerminalSessions(liveWorkspace, livenessNow) : []),
    [liveWorkspace, livenessNow]
  )
  // The terminal is an agent-only surface: resolve a session only when the
  // selected chat is an agent DM, and only for THAT agent (matched by the
  // agent's display name, which is how mapLiveTerminalSessions labels each
  // session). Non-agent conversations get no session, so the terminal shows its
  // honest empty state rather than some other agent's global first session.
  const selectedSession = useMemo(() => {
    if (!selectedChat?.liveAgentId) return undefined
    const agent = liveWorkspace?.agents.find((candidate) => candidate.id === selectedChat.liveAgentId)
    const agentName = agent?.display_name ?? selectedChat.primaryAgent
    return terminalSessions.find((session) => session.agent === agentName)
  }, [liveWorkspace, selectedChat, terminalSessions])

  const ensureLiveChannel = async (chat: AgentChatContext) => {
    if (chat.liveChannelId) return chat.liveChannelId
    const projectId = liveId(project.id)
    if (!projectId || !liveWorkspace) {
      throw new Error("Select a live project before sending project chat messages.")
    }

    // The other participants; the server adds the caller. A DM is named for who
    // it is with: an agent DM rosters that agent, a human DM that person, and a
    // shared room every active member plus every agent.
    const members: Array<{ kind: "user"; user: number } | { kind: "agent"; agent: number }> = []
    if (chat.mode === "direct" && chat.liveMemberUserId) {
      members.push({ kind: "user", user: chat.liveMemberUserId })
    } else if (chat.mode === "direct") {
      const agentId = liveWorkspace.agents.find((c) => c.id === chat.liveAgentId)?.id ?? chat.liveAgentId
      if (agentId) members.push({ kind: "agent", agent: agentId })
    } else {
      for (const member of liveWorkspace.members) {
        if (member.status === "active" && member.user && member.user !== currentUser?.id) {
          members.push({ kind: "user", user: member.user })
        }
      }
      for (const agent of liveWorkspace.agents) members.push({ kind: "agent", agent: agent.id })
    }

    const channel = await createTaskflowChannel({
      project: projectId,
      kind: chat.mode === "direct" ? "direct" : "project",
      title: chat.mode === "direct" ? chat.title : "Project room",
      topic: chat.detail,
      members,
    })

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentChannels: upsertById(workspace.agentChannels, channel),
      agentChannelMembers: channel.members.reduce(
        (current, member) => upsertById(current, member),
        workspace.agentChannelMembers
      ),
    }))
    return channel.id
  }

  const sendLiveMessage = async (
    chat: AgentChatContext,
    body: string,
    priority: MessagePriority,
    files: File[],
    targetAgent: number | null = null
  ) => {
    const projectId = liveId(project.id)
    if (!projectId || !liveWorkspace) {
      throw new Error("Select a live project before sending project chat messages.")
    }

    const channelId = await ensureLiveChannel(chat)
    const nonce = crypto.randomUUID()

    // Local previews for the optimistic bubble: object URLs for images so the
    // thumbnail shows immediately; non-images render from name + size. These
    // URLs are revoked once the server echo replaces the pending bubble.
    const pendingAttachments: PendingAttachment[] = files.map((file, index) => ({
      id: `pending:${nonce}:${index}`,
      name: file.name,
      content_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      url: file.type.startsWith("image/") ? URL.createObjectURL(file) : "",
    }))
    const revokePreviews = () => {
      for (const attachment of pendingAttachments) {
        if (attachment.url) URL.revokeObjectURL(attachment.url)
      }
    }

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: addPending(workspace.agentMessages, {
        client_nonce: nonce,
        body_markdown: body,
        priority: toLiveMessagePriority(priority),
        channel: channelId,
        status: "pending",
        attachments: pendingAttachments,
      }),
    }))

    try {
      const saved = await sendTaskflowAgentMessage(
        {
          channel: channelId,
          body_markdown: body,
          priority: toLiveMessagePriority(priority),
          client_nonce: nonce,
          target_agent: targetAgent,
        },
        files
      )
      // Reconcile the response as well as the SSE echo. Whichever lands first
      // wins and the other is a no-op — they key on the same nonce. Relying on
      // the echo alone would strand the bubble as pending whenever SSE is down,
      // even though the message saved fine. The response also carries the stored
      // attachments, which we merge so the bubble swaps its object-URL previews
      // for the real /media links even if the attachment SSE frames never land.
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: reconcile(workspace.agentMessages, saved),
        messageAttachments: saved.attachments.reduce(
          (rows, attachment) => upsertById(rows, attachment),
          workspace.messageAttachments
        ),
      }))
      revokePreviews()
    } catch (error) {
      // Keep the previews: the failed bubble still shows what was staged. Carry
      // the server's reason (e.g. "…too large…") onto the bubble so the user
      // learns WHY, not just that it failed.
      const reason = error instanceof Error ? error.message : undefined
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: markFailed(workspace.agentMessages, nonce, reason),
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
      // A retry does not re-upload files (the staged File objects are gone), but
      // an idempotent hit returns the attachments the first attempt stored, so
      // merge them to recover the real /media links.
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: reconcile(workspace.agentMessages, saved),
        messageAttachments: saved.attachments.reduce(
          (rows, attachment) => upsertById(rows, attachment),
          workspace.messageAttachments
        ),
      }))
    } catch (error) {
      const reason = error instanceof Error ? error.message : undefined
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: markFailed(workspace.agentMessages, nonce, reason),
      }))
      setMessageError(reason ?? "Could not send the message.")
    }
  }

  // Drop a failed optimistic bubble from the view. The message never reached the
  // server (or was rejected), so there is nothing to delete server-side — just
  // remove the local pending row keyed by its nonce.
  const cancelLiveMessage = (nonce: string) => {
    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: dismissPending(workspace.agentMessages, nonce),
    }))
  }

  const handleSendMessage = (
    chat: AgentChatContext,
    body: string,
    priority: MessagePriority,
    files: File[],
    targetAgent: number | null = null
  ) => {
    const trimmedBody = body.trim()
    if (!trimmedBody && files.length === 0) return

    setMessageError(null)
    void sendLiveMessage(chat, trimmedBody, priority, files, targetAgent).catch((error) => {
      setMessageError(error instanceof Error ? error.message : "Could not send the live message.")
    })
  }

  // Active project members who are not already on the selected LIVE channel.
  // "Already a member" is read straight from the channel's member rows (the same
  // data mapLiveChannelMembers renders), keyed by user id so display-name
  // collisions or a differing self-label never let someone be re-added by hand.
  const addMemberCandidates = useMemo<{ user: number; name: string }[]>(() => {
    const channelId = selectedChat?.liveChannelId
    if (!liveWorkspace || channelId == null) return []
    const existingUserIds = new Set(
      liveWorkspace.agentChannelMembers
        .filter((member) => member.channel === channelId && member.user != null)
        .map((member) => member.user as number)
    )
    return liveWorkspace.members
      .filter((member) => member.status === "active" && member.user != null && !existingUserIds.has(member.user))
      .map((member) => ({ user: member.user as number, name: member.display_name }))
  }, [liveWorkspace, selectedChat?.liveChannelId])

  const handleAddMember = async (userId: number) => {
    const channelId = selectedChat?.liveChannelId
    if (channelId == null) return
    await addChannelMember(channelId, userId)
    // Re-fetch so the roster, member counts, and candidate list all reflect the
    // new membership (mirrors how invite-accept re-syncs the workspace).
    await onRefreshWorkspace()
  }

  // The active conversation is addressed by the URL; clicking navigates so the
  // conversation is deep-linkable and the browser Back button works.
  const activeChatId = selectedChat?.id ?? ""
  const openChat = (chat: AgentChatContext) => navigate(chatIdToSlug(chat.id))

  // The question THIS agent is blocked on. Newest pending wins: an agent can
  // only be stopped at one keypress at a time, and older pending rows are stale
  // (the terminal moved on without anyone answering here).
  const pendingPrompt = useMemo(() => {
    const agentId = selectedChat?.liveAgentId
    if (!agentId || !liveWorkspace) return undefined
    return liveWorkspace.agentPrompts
      .filter(
        (prompt) =>
          prompt.agent === agentId &&
          prompt.status === "pending" &&
          // #6: a targeted question is only for that user; an untargeted one
          // (the agent had no DM context) still shows to every member.
          (prompt.target_user == null || prompt.target_user === currentUser?.id)
      )
      .sort((a, b) => b.id - a.id)[0]
  }, [selectedChat, liveWorkspace, currentUser])

  const handleAnswerPrompt = useCallback(
    async (promptId: number, answers: number[][], cancel = false, texts: (string | null)[] = []) => {
      await answerAgentPrompt(promptId, answers, cancel, texts)
    },
    []
  )

  const outletContext: AgentsOutletContext = {
    selectedChat,
    selectedSession,
    onSendMessage: handleSendMessage,
    onRetryMessage: retryLiveMessage,
    onCancelMessage: cancelLiveMessage,
    canManageMembers: selectedChat?.liveChannelId != null && selectedChat.mode === "channel",
    addMemberCandidates,
    onAddMember: handleAddMember,
    currentUser,
    pendingPrompt,
    onAnswerPrompt: handleAnswerPrompt,
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 lg:p-4 xl:p-5">
      {messageError ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {messageError}
        </p>
      ) : null}

      {/* Responsive master/detail. On mobile it's a single full-height pane:
          the list fills the screen on the index route and hides once a
          conversation is open (the thread takes over, with a back button). On
          lg+ both panes sit side-by-side as columns. The list stays mounted
          across the swap so its scroll position survives. */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden lg:grid lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)] lg:rounded-lg lg:border lg:bg-card lg:shadow-sm">
        {/* Conversation list — a persistent layout panel that stays mounted
            while the message area swaps via the <Outlet/> below. */}
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted/35 p-3 lg:border-r",
            conversationId ? "hidden lg:flex" : "flex"
          )}
        >
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
                  "w-full min-w-0 overflow-hidden p-3 text-left transition max-lg:border-b max-lg:border-border/60 max-lg:hover:bg-muted/40 lg:rounded-lg lg:border lg:border-border lg:bg-background lg:hover:border-primary/35",
                  activeChatId === chat.id && "max-lg:bg-muted lg:border-primary/50 lg:ring-2 lg:ring-primary/15"
                )}
                onClick={() => openChat(chat)}
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{chat.title}</span>
                  {chat.unread ? (
                    <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                      {chat.unread > 99 ? "99+" : chat.unread}
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
                </div>
              </button>
            ))}
            <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3 px-1 text-[0.7rem] font-semibold uppercase tracking-normal text-muted-foreground">
              <span>DMs</span>
              <span>{directChats.length}</span>
            </div>
            {directChats.map((chat) => {
              // An agent DM carries liveAgentId; a human (member) DM carries
              // liveMemberUserId. Existing direct channels created against an
              // agent still carry liveAgentId, so the icon stays correct there too.
              const isAgentDm = Boolean(chat.liveAgentId)
              return (
                <button
                  key={chat.id}
                  type="button"
                  className={cn(
                    "w-full min-w-0 overflow-hidden p-3 text-left transition max-lg:border-b max-lg:border-border/60 max-lg:hover:bg-muted/40 lg:rounded-lg lg:border lg:border-border lg:bg-background lg:hover:border-primary/35",
                    activeChatId === chat.id && "max-lg:bg-muted lg:border-primary/50 lg:ring-2 lg:ring-primary/15"
                  )}
                  onClick={() => openChat(chat)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="relative shrink-0">
                      <span
                        className={cn(
                          "inline-flex size-7 items-center justify-center rounded-full ring-1",
                          isAgentDm
                            ? "bg-violet-100 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900/60"
                            : "bg-sky-100 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900/60"
                        )}
                        aria-hidden
                      >
                        {isAgentDm ? <BotIcon className="size-4" /> : <UserIcon className="size-4" />}
                      </span>
                      {isAgentDm && chat.online !== undefined ? (
                        <span
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background",
                            chat.online ? "bg-emerald-500" : "bg-muted-foreground/40"
                          )}
                          title={chat.online ? "Online" : "Offline"}
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{chat.title}</span>
                    <span className="shrink-0 text-[0.65rem] font-medium uppercase tracking-normal text-muted-foreground">
                      {isAgentDm ? "Agent" : "Member"}
                    </span>
                    {chat.unread ? (
                      <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                        {chat.unread > 99 ? "99+" : chat.unread}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{chat.detail}</p>
                  {/* Only an agent DM carries a meaningful status (connected/offline/…).
                      A human DM's status is just "Direct" — redundant under the DMS
                      header — so it's dropped. */}
                  {isAgentDm ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1", agentStatusClass(chat.status))}>
                        {chat.status}
                      </span>
                    </div>
                  ) : null}
                </button>
              )
            })}
            {directChats.length === 0 ? (
              <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                No members or agents to DM yet.
              </p>
            ) : null}
          </div>
        </div>

        {/* Message area — route-addressable: index shows the empty state, a
            :conversationId child renders that conversation's messages. */}
        <Outlet context={outletContext} />
      </section>
    </section>
  )
}

/// Index-route element for /dashboard/agents: an honest empty state shown in the
/// message area before any conversation is opened. No message content loads here.
function AgentsConversationEmpty() {
  return (
    // Desktop-only: on mobile the index route shows the full-screen conversation
    // list, so this empty state (the outlet's index element) is hidden there.
    <div className="hidden min-h-0 min-w-0 place-items-center p-8 text-center lg:grid">
      <div className="max-w-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
          <InboxIcon className="size-6" />
        </div>
        <h2 className="mt-4 text-lg font-semibold">Select a conversation</h2>
        <p className="mx-auto mt-2 text-sm leading-6 text-muted-foreground">
          Pick a group chat or a DM from the list to start messaging, share files, and inspect the active terminal session.
        </p>
      </div>
    </div>
  )
}

/// Child route element for /dashboard/agents/:conversationId. Reads the resolved
/// conversation + handlers from the layout's <Outlet/> context and renders the
/// message thread, composer, and the agent-DM-aware minimizable terminal. When
/// the route param doesn't resolve to a real chat it falls back to the empty
/// state, so a stale or hand-typed id never renders a broken conversation.

/// One option as stored in a prompt's `options_json`.
type AgentPromptOption = { number: number; label: string; description?: string; preview?: string; isOther?: boolean }

/// One question and its options.
type AgentPromptQuestion = { question: string; kind: string; options: AgentPromptOption[] }

/// The questions a prompt is asking, in either stored shape.
///
/// `AskUserQuestion` accepts SEVERAL questions per call. Rows written before
/// that was supported hold a bare option list for one question, and they are
/// still in the table — reading one must keep working, because an unrenderable
/// prompt leaves its agent blocked with no way to answer.
function parsePromptQuestions(
  optionsJson: string,
  fallbackKind: string,
  fallbackQuestion: string
): AgentPromptQuestion[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(optionsJson)
  } catch {
    return []
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return []

  // The discriminator is a nested `options` array: the set shape wraps each
  // question, the legacy shape IS the option list.
  const isSet = parsed.every((e) => typeof e === "object" && e !== null && "options" in e)
  if (!isSet) {
    return [{ question: fallbackQuestion, kind: fallbackKind, options: parsed as AgentPromptOption[] }]
  }
  return (parsed as Array<Partial<AgentPromptQuestion>>)
    .map((e) => ({
      question: typeof e.question === "string" ? e.question : fallbackQuestion,
      kind: typeof e.kind === "string" ? e.kind : "single",
      options: Array.isArray(e.options) ? e.options : [],
    }))
    .filter((q) => q.options.length > 0)
}

/// Where an unsent selection is kept across a reload.
///
/// The QUESTION already survives a refresh — prompts are server rows and the
/// workspace refetches pending ones on load. What did not survive was a
/// half-made choice, which matters more now that answering is a deliberate
/// submit and a prompt can carry several questions: answer two of three, hit
/// refresh, lose both.
///
/// Deliberately NOT a persisted copy of the question itself. The server owns
/// that, and a local duplicate goes stale in a nasty way — the agent is
/// cancelled or someone answers from another tab, and this client would still
/// render a live question against a prompt that no longer exists.
const PROMPT_DRAFT_PREFIX = "taskflow.promptDraft."

function loadPromptDraft(promptId: number, questionCount: number): number[][] | null {
  try {
    const raw = window.localStorage.getItem(`${PROMPT_DRAFT_PREFIX}${promptId}`)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    // A draft saved against a DIFFERENT set of questions must not be applied —
    // the prompt was re-reported with a new shape and the indexes would no
    // longer line up with the questions on screen.
    if (!Array.isArray(parsed) || parsed.length !== questionCount) return null
    return parsed.map((set) => (Array.isArray(set) ? set.filter((n) => typeof n === "number") : []))
  } catch {
    return null
  }
}

function savePromptDraft(promptId: number, sets: number[][]): void {
  try {
    window.localStorage.setItem(`${PROMPT_DRAFT_PREFIX}${promptId}`, JSON.stringify(sets))
  } catch {
    // A full or disabled store must never break answering the question.
  }
}

function clearPromptDraft(promptId: number): void {
  try {
    window.localStorage.removeItem(`${PROMPT_DRAFT_PREFIX}${promptId}`)
  } catch {
    /* nothing to recover from */
  }
}

/// The yellow box above the composer: a question the agent is BLOCKED on.
///
/// This is not a notification — the agent is stopped at a keypress until someone
/// answers, so it is rendered where a reply would be typed, in the one place the
/// human is already looking.
function AgentPromptCard({
  prompt,
  onAnswer,
}: {
  prompt: TaskflowWorkspace["agentPrompts"][number]
  onAnswer: (promptId: number, answers: number[][], cancel?: boolean, texts?: (string | null)[]) => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const questions = useMemo(
    () => parsePromptQuestions(prompt.options_json, prompt.kind, prompt.question),
    [prompt.options_json, prompt.kind, prompt.question]
  )

  // One selection set per question, positionally aligned with `questions`,
  // seeded from any draft left by a previous visit.
  const [selected, setSelected] = useState<number[][]>(
    () => loadPromptDraft(prompt.id, questions.length) ?? questions.map(() => [])
  )

  // One Other-text value per question, "" where none. Indexed like `questions`.
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ""))

  // Persist every change, so a reload mid-answer does not discard the work.
  useEffect(() => {
    if (selected.some((set) => set.length > 0)) savePromptDraft(prompt.id, selected)
  }, [prompt.id, selected])

  const toggle = (qIndex: number, number: number) => {
    setError(null)
    // Single-select: picking a listed option clears any Other text, so the two
    // can't both count (the effective answer must be exactly one).
    if (questions[qIndex]?.kind !== "multi") {
      setTexts((cur) => cur.map((t, i) => (i === qIndex ? "" : t)))
    }
    setSelected((current) =>
      current.map((set, i) => {
        if (i !== qIndex) return set
        // Radio vs checkbox, mirroring how the agent's own terminal behaves.
        return questions[i]?.kind === "multi"
          ? set.includes(number)
            ? set.filter((n) => n !== number)
            : [...set, number].sort((a, b) => a - b)
          : [number]
      })
    )
  }

  // Effective selection per question: the toggled numbers, plus the Other
  // option's number when its text box is non-empty. A filled Other box counts
  // as picking Other even if the human never clicked it.
  const effective = questions.map((q, i) => {
    const other = q.options.find((o) => o.isOther)
    const hasText = Boolean(other && (texts[i] ?? "").trim())
    // Single-select (#30): exactly ONE answer. A filled Other box IS the answer
    // and supersedes any picked option; otherwise the picked option stands.
    if (q.kind !== "multi") {
      if (hasText) return [other!.number]
      return [...(selected[i] ?? [])]
    }
    // Multi-select: a filled Other box counts as an extra pick.
    const picks = [...(selected[i] ?? [])]
    if (hasText && !picks.includes(other!.number)) picks.push(other!.number)
    return picks.sort((a, b) => a - b)
  })

  // The agent is woken once, with the whole set. Answering questions one at a
  // time would replay digits into a screen the terminal has already left.
  const complete = questions.length > 0 && effective.every((set) => set.length > 0)

  const submit = async (cancel = false) => {
    if (!complete || pending) return
    setPending(true)
    setError(null)
    try {
      await onAnswer(prompt.id, effective, cancel, texts.map((t) => (t.trim() ? t : null)))
      // Answered: the draft has served its purpose and would otherwise be
      // re-applied if this prompt id were ever rendered again.
      clearPromptDraft(prompt.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not answer.")
      setPending(false)
    }
  }

  if (!questions.length) return null

  return (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
        <AlertCircleIcon className="size-4 shrink-0" />
        <p className="text-sm font-medium">Agent is waiting for your answer</p>
      </div>
      {/* Bounded and scrollable: three questions with previews ran past the
          bottom of the card and the submit button could not be reached at all
          — the only way to answer was to zoom the whole browser out. */}
      <div className="mt-1 max-h-[45vh] overflow-y-auto pr-1">
      {questions.map((q, qIndex) => (
        <div key={qIndex} className={qIndex === 0 ? "" : "mt-4"}>
          <p className="mt-2 text-sm text-foreground">
            {questions.length > 1 ? (
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                {qIndex + 1}/{questions.length}
              </span>
            ) : null}
            {q.question}
          </p>

          <div className="mt-3 space-y-1.5">
        {q.options.map((option) => {
          const active = selected[qIndex]?.includes(option.number) ?? false
          return option.isOther ? (
            <div
              key={option.number}
              className="rounded-md border border-transparent bg-background/60 px-2.5 py-2"
            >
              <label className="mb-1 block text-xs text-muted-foreground">{option.label}</label>
              <textarea
                value={texts[qIndex] ?? ""}
                disabled={pending}
                rows={2}
                placeholder="Type your own answer…"
                onChange={(e) => {
                  setError(null)
                  setTexts((cur) => cur.map((t, i) => (i === qIndex ? e.target.value : t)))
                  // Single-select: typing Other deselects any picked option.
                  if (q.kind !== "multi" && e.target.value.trim()) {
                    setSelected((cur) => cur.map((set, i) => (i === qIndex ? [] : set)))
                  }
                }}
                className="w-full resize-y rounded border bg-background px-2 py-1 text-sm"
              />
            </div>
          ) : (
            <button
              key={option.number}
              type="button"
              disabled={pending}
              // Always a toggle now, never an immediate send: with several
              // questions the agent must not be woken until every one of them
              // has an answer.
              onClick={() => toggle(qIndex, option.number)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition disabled:opacity-60",
                active
                  ? "border-amber-500 bg-amber-100 dark:bg-amber-900/40"
                  : "border-transparent bg-background/60 hover:border-amber-300"
              )}
            >
              <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
                {q.kind === "multi" ? (active ? "[x]" : "[ ]") : `${option.number}.`}
              </span>
              <span className="min-w-0">
                <span className="block font-medium">{option.label}</span>
                {option.description ? (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                ) : null}
                {/* Shown only for the chosen option: previews are often long
                    (a mockup, a diff, a config block) and rendering every one
                    at once buries the question itself. */}
                {option.preview && active ? (
                  <span className="mt-2 block overflow-x-auto whitespace-pre rounded border bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                    {option.preview}
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
          </div>
        </div>
      ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={!complete || pending} onClick={() => void submit()}>
          {pending ? "Sending…" : "Submit answers"}
        </Button>
        {/* Cancel is the OTHER option on the terminal's review screen, and that
            screen only exists for a question SET — a single question submits the
            moment it is answered, so there is no cancel key to press. Gated on
            `complete` for the same reason submit is: the agent has to replay
            every answer to reach the review screen. */}
        {questions.length > 1 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!complete || pending}
            onClick={() => void submit(true)}
          >
            Cancel
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {complete
            ? "The agent resumes as soon as you send."
            : questions.length > 1
              ? "Answer every question, then submit."
              : "Choose an option, then submit."}
        </span>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

function AgentsConversationView() {
  const {
    selectedChat,
    selectedSession,
    onSendMessage,
    onRetryMessage,
    onCancelMessage,
    canManageMembers,
    addMemberCandidates,
    onAddMember,
    pendingPrompt,
    onAnswerPrompt,
  } = useAgentsOutletContext()
  const navigate = useNavigate()

  const [draftMessage, setDraftMessage] = useState("")
  const [messagePriority, setMessagePriority] = useState<MessagePriority>("normal")
  // #29: in a group channel, optionally direct a message at one agent's pane.
  const [targetAgent, setTargetAgent] = useState<number | null>(null)
  // #29: the in-progress `@mention` (an `@` being typed), for the agent picker.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const canSendMessage = draftMessage.trim().length > 0 || stagedFiles.length > 0
  const focusComposer = () => {
    composerRef.current?.focus()
  }

  // Auto-grow the single-line pill textarea with its content, up to ~136px.
  useEffect(() => {
    const textarea = composerRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 136)}px`
  }, [draftMessage])

  // Restore the caret after an emoji is spliced into the draft.
  useEffect(() => {
    if (pendingCaret.current === null || !composerRef.current) return
    composerRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [draftMessage])

  /// Insert text at the caret, replacing any selection, and put the caret after
  /// it once React has re-rendered (see the `pendingCaret` effect above).
  /// Shared by the emoji picker and the newline shortcuts so the caret cannot
  /// jump to the end on one path and not the other.
  const insertAtCaret = (text: string) => {
    const textarea = composerRef.current
    const start = textarea?.selectionStart ?? draftMessage.length
    const end = textarea?.selectionEnd ?? draftMessage.length
    const { value, caret } = spliceAtCaret(draftMessage, start, end, text)
    pendingCaret.current = caret
    setDraftMessage(value)
    textarea?.focus()
  }

  const insertEmoji = (emoji: string) => insertAtCaret(emoji)

  // Clicking a staged file drops [its-name] at the caret, so a message can point
  // at one specific attachment among several.
  const insertFileReference = (name: string) => insertAtCaret(fileReferenceText(name))

  // #29: everyone in the room matching the in-progress @mention (by display
  // name) — humans AND agents, online or offline, so anyone can always be
  // addressed. Agents come first, since only they can be directed to a pane.
  const mentionMembers = mention
    ? (selectedChat?.members ?? [])
        .filter((member) => member.name.toLowerCase().includes(mention.query.toLowerCase()))
        .sort((a, b) => (a.type === b.type ? 0 : a.type === "agent" ? -1 : 1))
        .slice(0, 6)
    : []

  const selectMention = (member: ConversationMember) => {
    if (!mention) return
    const textarea = composerRef.current
    const caret = textarea?.selectionStart ?? draftMessage.length
    const token = `@${member.name} `
    const next = draftMessage.slice(0, mention.start) + token + draftMessage.slice(caret)
    pendingCaret.current = mention.start + token.length
    setDraftMessage(next)
    // Only an agent has a pane to route to: picking one directs the message
    // there (delivered on reconnect if it is offline). Mentioning a human is
    // attribution only, so it leaves any existing target untouched.
    if (member.type === "agent" && member.agentId != null) {
      setTargetAgent(member.agentId)
    }
    setMention(null)
    textarea?.focus()
  }

  // The terminal stays CLOSED by default and is opened on demand from the header
  // terminal icon, showing as an overlay over the chat area. Switching
  // conversations closes it so the new chat starts clean. Resetting during
  // render (rather than in an effect) is the React-blessed "adjust state when a
  // prop changes" pattern and avoids a set-state-in-effect lint error.
  const chatKey = selectedChat?.id ?? ""
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalChatId, setTerminalChatId] = useState(chatKey)
  // Client-side window: the thread renders only the last `visibleCount` messages
  // and reveals another page of MESSAGE_PAGE_SIZE as the user scrolls to the top.
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE)
  if (terminalChatId !== chatKey) {
    setTerminalChatId(chatKey)
    setTerminalOpen(false)
    // A directed target is per-conversation; switching chats resets it.
    setTargetAgent(null)
    setMention(null)
    // Switching conversations starts a fresh window at the most recent page.
    setVisibleCount(MESSAGE_PAGE_SIZE)
  }

  // Keep the thread pinned to the latest message: scroll to the bottom when the
  // conversation changes or a new message arrives (optimistic send, echo, or a
  // realtime message from someone else). Keyed on the TOTAL message count (and
  // chatKey), NOT on visibleCount — revealing older messages must preserve the
  // reading position (see the reveal anchor below), not jump to the bottom.
  const messageCount = selectedChat?.messages.length ?? 0
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatKey, messageCount])

  // Mark-read: advance the current user's read cursor to the newest SAVED message
  // whenever this thread is open (mount / channel switch / a new message lands).
  // Only real channels with a real latest message id qualify — a pending bubble
  // has no server id yet. Debounced so a burst of arrivals fires at most one POST
  // once activity settles, and best-effort (a failed cursor update is silent).
  const liveChannelId = selectedChat?.liveChannelId ?? null
  const latestReadableMessageId = useMemo(() => {
    if (!selectedChat) return null
    for (let index = selectedChat.messages.length - 1; index >= 0; index -= 1) {
      const message = selectedChat.messages[index]
      if (message.status !== "posted") continue
      const numericId = Number(message.id)
      if (Number.isFinite(numericId)) return numericId
    }
    return null
  }, [selectedChat])
  useEffect(() => {
    if (!liveChannelId || latestReadableMessageId == null) return
    const timer = setTimeout(() => {
      void markChannelRead(liveChannelId, latestReadableMessageId).catch(() => {})
    }, 800)
    return () => clearTimeout(timer)
  }, [liveChannelId, latestReadableMessageId])

  // The window shows the last N messages; a new message lands at the end, so it
  // is always inside the window and the bottom-scroll effect above reveals it.
  const windowedMessages = useMemo(
    () => (selectedChat ? selectedChat.messages.slice(Math.max(0, messageCount - visibleCount)) : []),
    [selectedChat, messageCount, visibleCount]
  )
  const hasMoreOlder = visibleCount < messageCount

  // Reverse-infinite-scroll anchor: revealing older messages grows the container
  // at the top, which would shove the reading position down. We snapshot the
  // pre-growth scrollHeight on the scroll that triggers a reveal, then — after
  // the DOM grows — add the height delta back onto scrollTop so the messages the
  // user was reading stay exactly in place (no jump to the top).
  const pendingRevealAnchor = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = threadRef.current
    const anchor = pendingRevealAnchor.current
    if (el && anchor != null) {
      el.scrollTop += el.scrollHeight - anchor
      pendingRevealAnchor.current = null
    }
  }, [visibleCount])

  const handleThreadScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    if (el.scrollTop < 48 && visibleCount < messageCount) {
      pendingRevealAnchor.current = el.scrollHeight
      setVisibleCount((current) => Math.min(current + MESSAGE_PAGE_SIZE, messageCount))
    }
  }

  // Revoke every staged preview URL when the composer unmounts so switching
  // chats mid-compose doesn't leak object URLs.
  useEffect(() => {
    return () => {
      setStagedFiles((current) => {
        for (const staged of current) {
          if (staged.previewUrl) URL.revokeObjectURL(staged.previewUrl)
        }
        return current
      })
    }
  }, [])

  /// Stage files for upload. The picker and drag-and-drop both land here so the
  /// two entry points cannot drift on preview URLs, id shape, or which types get
  /// a thumbnail — a dropped image must behave exactly like a picked one.
  const stageFiles = (incoming: File[]) => {
    if (!incoming.length) return
    setStagedFiles((current) => [
      ...current,
      ...incoming.map((file) => ({
        id: `staged:${Date.now()}:${file.name}:${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      })),
    ])
  }

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    stageFiles(Array.from(event.target.files ?? []))
    // Reset so picking the same file again re-fires change.
    event.target.value = ""
  }

  // Drag-and-drop onto the conversation. `dragenter`/`dragleave` fire for every
  // child element the cursor crosses, so a boolean would flicker off the moment
  // the pointer moved from the thread onto a message bubble. Counting enters
  // against leaves tracks the section as a whole.
  const dragDepth = useRef(0)
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)

  /// Only FILE drags. Dragging selected text, a link, or one of the board's
  /// cards also fires these events, and offering to "drop files here" for a text
  /// selection would be a lie.
  const isFileDrag = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files")

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setIsDraggingFiles(true)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return
    // Without preventDefault the browser refuses the drop and opens the file in
    // a new tab instead — the default action for a dragged file.
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDraggingFiles(false)
  }

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setIsDraggingFiles(false)
    stageFiles(Array.from(event.dataTransfer.files ?? []))
    // The files are staged, not sent — the composer keeps them so the user can
    // add a message, review, or remove one before sending.
    requestAnimationFrame(focusComposer)
  }

  const removeStagedFile = (id: string) => {
    setStagedFiles((current) => {
      const target = current.find((staged) => staged.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return current.filter((staged) => staged.id !== id)
    })
  }

  const handleSendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedChat) return
    const trimmedMessage = draftMessage.trim()
    if (!trimmedMessage && stagedFiles.length === 0) return

    onSendMessage(
      selectedChat,
      trimmedMessage,
      messagePriority,
      stagedFiles.map((staged) => staged.file),
      selectedChat.mode === "channel" ? targetAgent : null
    )
    // Revoke the composer's own preview URLs; the optimistic bubble mints its
    // own from the same File objects, so these are no longer needed.
    for (const staged of stagedFiles) {
      if (staged.previewUrl) URL.revokeObjectURL(staged.previewUrl)
    }
    setDraftMessage("")
    setStagedFiles([])
    setMessagePriority("normal")
    setEmojiPickerOpen(false)
    requestAnimationFrame(focusComposer)
  }

  // A hand-typed or stale conversation id doesn't resolve to a chat — show the
  // same empty state as the index route rather than a broken thread.
  if (!selectedChat) {
    return <AgentsConversationEmpty />
  }

  const chatLabel = selectedChat.mode === "channel" ? "Group chat" : "DM"

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop affordance. Rendered only while a file drag is in flight, and
          pointer-events-none so it cannot swallow the drop it is advertising —
          the events stay on the section underneath. */}
      {isDraggingFiles ? (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/80 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 text-center">
            <PaperclipIcon className="h-7 w-7 text-primary" />
            <p className="text-sm font-medium text-foreground">Drop files to attach</p>
            <p className="text-xs text-muted-foreground">
              They'll be added to your message — nothing sends until you do.
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {/* Mobile-only back control: returns to the full-screen list. On
                lg+ the list is always visible beside the thread, so it's hidden. */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="-ml-1 shrink-0 lg:hidden"
              onClick={() => navigate("/dashboard/agents")}
            >
              <ArrowLeftIcon />
              <span className="sr-only">Back to conversations</span>
            </Button>
            <h2 className="truncate text-sm font-semibold">{selectedChat.title}</h2>
            <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
              {chatLabel}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTerminalOpen((open) => !open)}
              aria-label="Toggle terminal"
              title="Terminal"
            >
              <TerminalIcon />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions">
                    <MoreHorizontalIcon />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Add member</DropdownMenuLabel>
                  {canManageMembers ? (
                    addMemberCandidates.length === 0 ? (
                      <p className="px-1.5 py-2 text-xs text-muted-foreground">
                        Everyone in the project is already here.
                      </p>
                    ) : (
                      addMemberCandidates.map((candidate) => (
                        <DropdownMenuItem
                          key={candidate.user}
                          onClick={() => {
                            void onAddMember(candidate.user).catch(() => {})
                          }}
                        >
                          {candidate.name}
                        </DropdownMenuItem>
                      ))
                    )
                  ) : (
                    <p className="px-1.5 py-2 text-xs text-muted-foreground">
                      You can't manage members here.
                    </p>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div
          ref={threadRef}
          onScroll={handleThreadScroll}
          className="chat-thread-bg scrollbar-y min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
        >
          {hasMoreOlder ? (
            <div className="pb-1 text-center text-xs text-muted-foreground/70">Scroll up for older messages</div>
          ) : messageCount > 0 ? (
            <div className="pb-1 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground/50">
              Beginning of conversation
            </div>
          ) : null}
          {buildThreadItems(windowedMessages).map((item) =>
            item.type === "date" ? (
              <div
                key={item.key}
                className="sticky top-0 z-10 -mx-4 flex items-center justify-center bg-gradient-to-b from-background via-background/85 to-transparent px-4 py-1"
              >
                <span className="rounded-full bg-muted px-3 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border">
                  {item.label}
                </span>
              </div>
            ) : (
              <AgentChatBubble
                key={item.message.id}
                message={item.message}
                onRetry={onRetryMessage}
                onCancel={onCancelMessage}
              />
            )
          )}
        </div>

        {pendingPrompt ? (
          <div className="shrink-0 border-t bg-background px-3 pt-3">
            <AgentPromptCard prompt={pendingPrompt} onAnswer={onAnswerPrompt} />
          </div>
        ) : null}

        <form className="shrink-0 border-t bg-background p-3" onSubmit={handleSendMessage}>
          {emojiPickerOpen ? (
            <button
              type="button"
              className="fixed inset-0 z-20 cursor-default"
              aria-label="Close emoji picker"
              onClick={() => setEmojiPickerOpen(false)}
            />
          ) : null}

          <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border/75 bg-background/90 px-2 py-2 shadow-inner transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25">
            {stagedFiles.length ? (
              <div className="px-1">
                <StagedFileList
                  files={stagedFiles}
                  onRemove={removeStagedFile}
                  onReference={(staged) => insertFileReference(staged.file.name)}
                />
              </div>
            ) : null}

            <div className="relative">
            {/* #29: typing `@` surfaces everyone in the room — humans and agents,
                online or offline — so anyone can be addressed by picking from a
                list instead of typing a long, spaced handle by hand. */}
            {mentionMembers.length ? (
              <div className="absolute bottom-full left-0 z-30 mb-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-2xl">
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                  Mention
                </div>
                {mentionMembers.map((member) => (
                  <button
                    key={`${member.type}:${member.name}`}
                    type="button"
                    // Mousedown (not click) so the textarea keeps focus and its
                    // caret — click would blur first and lose the insert point.
                    onMouseDown={(event) => {
                      event.preventDefault()
                      selectMention(member)
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <span className="truncate">{member.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {member.type === "agent" ? "agent" : "user"}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              ref={composerRef}
              rows={1}
              className="max-h-[8.5rem] min-h-9 w-full resize-none bg-transparent px-1 py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground"
              placeholder={`Message ${selectedChat.title}…`}
              value={draftMessage}
              onChange={(event) => {
                const value = event.target.value
                setDraftMessage(value)
                // #29: opening/updating an @mention as the human types.
                setMention(detectMention(value, event.target.selectionStart ?? value.length))
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                // An IME uses Enter to accept a candidate. Submitting there
                // would send half-composed text and swallow the keystroke that
                // was meant to finish the word.
                if (event.nativeEvent.isComposing) return

                // Alt+Enter inserts a newline. Shift+Enter already did, via the
                // textarea's own default, but Alt+Enter has no default insert to
                // fall through to — so it is done explicitly rather than left to
                // the browser, which varies by platform.
                if (event.altKey) {
                  event.preventDefault()
                  insertAtCaret("\n")
                  return
                }

                // Shift+Enter: let the textarea insert the newline itself.
                if (event.shiftKey) return

                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }}
            />
            </div>

            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-0.5">
                <div className="relative">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-xl"
                    aria-label="Emoji"
                    onClick={() => setEmojiPickerOpen((open) => !open)}
                  >
                    <SmileIcon />
                  </Button>

                  {emojiPickerOpen ? (
                    <div className="absolute bottom-full left-0 z-30 mb-2 w-[21rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-2xl">
                      <div className="grid gap-3">
                        {composerEmojiGroups.map((group) => (
                          <div key={group.label}>
                            <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                              {group.label}
                            </div>
                            <div className="grid grid-cols-8 gap-1">
                              {group.emojis.map((emoji) => (
                                <button
                                  key={`${group.label}-${emoji}`}
                                  type="button"
                                  className="flex size-8 items-center justify-center rounded-lg text-lg transition-colors hover:bg-accent"
                                  onClick={() => insertEmoji(emoji)}
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />

                {/* #29: in a group channel, optionally direct the message at one
                    agent's terminal instead of every connected agent. */}
                {selectedChat.mode === "channel"
                  ? (() => {
                      const channelAgents = selectedChat.members.filter(
                        (member) => member.type === "agent" && member.agentId != null
                      )
                      if (!channelAgents.length) return null
                      const targetItems = [
                        { value: "everyone", label: "To: everyone" },
                        ...channelAgents.map((agent) => ({
                          value: String(agent.agentId),
                          label: `To: ${agent.name}`,
                        })),
                      ]
                      return (
                        <Select
                          value={targetAgent != null ? String(targetAgent) : "everyone"}
                          onValueChange={(value) =>
                            setTargetAgent(value === "everyone" ? null : Number(value))
                          }
                          items={targetItems}
                        >
                          <SelectTrigger
                            aria-label="Direct this message to one agent's terminal"
                            className={cn(
                              "ml-0.5 h-auto w-auto max-w-[11rem] gap-1 rounded-lg py-1 text-xs",
                              targetAgent != null
                                ? "border-primary/40 bg-primary/10 text-primary"
                                : "text-muted-foreground"
                            )}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {targetItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )
                    })()
                  : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-xl"
                  aria-label="Attach file"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon />
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-xl"
                  aria-label="Broadcast"
                >
                  <RadioIcon />
                </Button>

                <Select
                  value={messagePriority}
                  onValueChange={(value) => setMessagePriority(value as MessagePriority)}
                  items={messagePriorityOptions}
                >
                  <SelectTrigger
                    className="w-auto gap-1 border-0 bg-transparent text-xs shadow-none"
                    aria-label="Message priority"
                  >
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

              <Button
                type="submit"
                size="icon-lg"
                className="rounded-2xl"
                disabled={!canSendMessage}
                aria-label="Send"
              >
                <SendIcon />
              </Button>
            </div>
          </div>
        </form>
      </div>

      {terminalOpen ? (
        // Opened from the header terminal icon: an overlay the size of the chat
        // column (anchored to the relative <section>), dismissable via its own
        // close (X) control, on every screen size.
        <AgentTerminalPanel
          selectedSession={selectedSession}
          onFocusComposer={focusComposer}
          onClose={() => setTerminalOpen(false)}
          className="absolute inset-0 z-30 bg-card shadow-xl animate-in slide-in-from-right duration-200"
        />
      ) : null}
    </section>
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

/// Removable chips/thumbnails for files staged in the composer before send.
/// Images preview from their local object URL; other files show an icon + size.
function StagedFileList({
  files,
  onRemove,
  onReference,
}: {
  files: StagedFile[]
  onRemove: (id: string) => void
  /** Drop [filename] at the composer caret so a message can point at this file. */
  onReference?: (staged: StagedFile) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((staged) => {
        const isImage = staged.file.type.startsWith("image/")
        return (
          <div
            key={staged.id}
            className="flex items-center gap-2 rounded-lg border bg-background/90 py-1 pl-1 pr-1.5"
          >
            {/* The icon + name is the reference trigger; the X (below) removes.
                Clicking here inserts [name] at the composer caret. mousedown is
                prevented so the textarea keeps its selection instead of blurring
                to this button first. */}
            <button
              type="button"
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md text-left",
                onReference && "cursor-pointer hover:opacity-80",
              )}
              disabled={!onReference}
              title={onReference ? "Insert reference into the message" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onReference?.(staged)}
            >
              {isImage && staged.previewUrl ? (
                <img
                  src={staged.previewUrl}
                  alt={staged.file.name}
                  className="size-9 shrink-0 rounded-md object-cover"
                />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
                  {isImage ? <ImageIcon className="size-4" /> : <FileIcon className="size-4" />}
                </span>
              )}
              <div className="min-w-0">
                <p className="max-w-[10rem] truncate text-xs font-medium">{staged.file.name}</p>
                <p className="text-[0.7rem] text-muted-foreground">{formatBytes(staged.file.size)}</p>
              </div>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${staged.file.name}`}
              onClick={() => onRemove(staged.id)}
            >
              <XIcon />
            </Button>
          </div>
        )
      })}
    </div>
  )
}

function AgentChatBubble({
  message,
  onRetry,
  onCancel,
}: {
  message: AgentMessage
  onRetry?: (nonce: string) => void
  onCancel?: (nonce: string) => void
}) {
  const fromUser = message.from === "user"
  const alignRight = fromUser
  return (
    <article className={cn("flex", alignRight ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] rounded-lg border p-3 shadow-sm sm:max-w-[82%]",
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
            <MessageAttachments attachments={message.attachments} />
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
        {message.status === "failed" && message.nonce ? (
          <div className="mt-3 flex flex-col gap-2 text-xs text-rose-700 dark:text-rose-300">
            {/* Show the server's reason (e.g. a too-large-file message) so the
                user knows what to fix, falling back to a generic line. */}
            <span>{message.error ?? "Message failed to send."}</span>
            <div className="flex flex-wrap items-center gap-2">
              {onRetry ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="bg-background/85"
                  onClick={() => onRetry(message.nonce!)}
                >
                  <RotateCcwIcon />
                  Retry
                </Button>
              ) : null}
              {onCancel ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onCancel(message.nonce!)}
                >
                  <XIcon />
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {fromUser && message.seen ? (
          <div className="mt-1.5 flex items-center justify-end gap-1 text-[0.65rem] font-medium text-muted-foreground">
            <CheckCheckIcon className="size-3" />
            Seen
          </div>
        ) : null}
      </div>
    </article>
  )
}

function AgentTerminalPanel({
  selectedSession,
  onFocusComposer,
  onClose,
  className,
}: {
  selectedSession?: AgentTerminalSessionView
  onFocusComposer: () => void
  onClose: () => void
  className?: string
}) {
  const closeButton = (
    <Button variant="ghost" size="icon" onClick={onClose} title="Close terminal" aria-label="Close terminal">
      <XIcon />
    </Button>
  )
  if (!selectedSession) {
    return (
      <div className={cn("flex min-h-0 min-w-0 flex-col bg-muted/20", className)}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <TerminalIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Terminal</h2>
          </div>
          {closeButton}
        </div>
        <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted-foreground">
          No terminal session yet. Connected agents and their terminal frames will appear here.
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col bg-muted/20", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TerminalIcon className="size-4 text-primary" />
            <h2 className="truncate text-sm font-semibold">{selectedSession.agent}</h2>
            <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1", terminalStatusClass(selectedSession.status))}>
              {selectedSession.connected ? (
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
              ) : null}
              {selectedSession.status}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{selectedSession.cwd}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onFocusComposer}>
            <MessageSquareIcon />
            Message
          </Button>
          {closeButton}
        </div>
      </div>

      <div className="min-h-0 flex-1 p-3 sm:p-4">
        <TerminalTranscript session={selectedSession} />
      </div>

      {/* Enable when the pane is actually mirroring (streaming frames) OR the
          session is live. `connected` alone (heartbeat recency) went stale while
          the mirror was plainly still streaming, greying out working keys. */}
      <TerminalKeypad
        agentId={selectedSession.agentId}
        disabled={!selectedSession.hasStream && !selectedSession.connected}
      />
    </div>
  )
}

/// Keys forwarded to an agent's terminal (#12), like v1 had. Digits, arrows, and
/// the common control keys — each maps to a tmux key NAME the server allowlists
/// and the agent's mirror types into the pane. Own component (not inline in the
/// panel) so its state sits above the panel's early return.
const TERMINAL_KEYS: { label: string; key: string; wide?: boolean }[] = [
  { label: "1", key: "1" }, { label: "2", key: "2" }, { label: "3", key: "3" },
  { label: "4", key: "4" }, { label: "5", key: "5" }, { label: "6", key: "6" },
  { label: "7", key: "7" }, { label: "8", key: "8" }, { label: "9", key: "9" },
  { label: "0", key: "0" },
  { label: "←", key: "Left" }, { label: "↑", key: "Up" }, { label: "↓", key: "Down" }, { label: "→", key: "Right" },
  { label: "Tab", key: "Tab", wide: true }, { label: "Enter", key: "Enter", wide: true },
  { label: "Esc", key: "Escape", wide: true }, { label: "Space", key: "Space", wide: true },
  { label: "⌫", key: "BSpace" },
]

function TerminalKeypad({ agentId, disabled }: { agentId: number; disabled?: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const press = (key: string) => {
    setError(null)
    void sendTerminalKey(agentId, key).catch((err) =>
      setError(err instanceof Error ? err.message : "Could not send the key.")
    )
  }
  return (
    <div className="shrink-0 border-t bg-background/70 px-3 py-2">
      <div className="flex flex-wrap gap-1">
        {TERMINAL_KEYS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            disabled={disabled}
            onClick={() => press(entry.key)}
            title={disabled ? "No live terminal mirror for this agent" : `Send ${entry.label}`}
            className={cn(
              "inline-flex h-8 items-center justify-center rounded-md border font-mono text-xs transition disabled:cursor-not-allowed disabled:opacity-40",
              entry.wide ? "px-2.5" : "w-8",
              "hover:bg-muted"
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="mt-1 text-xs text-rose-600 dark:text-rose-300">{error}</p>
      ) : disabled ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Keys send once this agent has a live terminal mirror.
        </p>
      ) : null}
    </div>
  )
}

/// Live terminal transcript: a dark, monospace stream that colours frames by
/// their source and follows the tail (auto-scrolls to the bottom as new frames
/// arrive, unless the reader has scrolled up to look back).
function TerminalTranscript({ session }: { session: AgentTerminalSessionView }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const frameCount = session.frames.length

  // A `snapshot` frame is a whole screen that REPLACES the view — a full-screen
  // TUI on tmux's alternate screen has no scrollback to append, so its mirror
  // arrives as repeated complete captures. Rendering those as a log would stack
  // near-identical screens; only the newest one is meaningful.
  const latestSnapshot = useMemo(() => {
    for (let index = session.frames.length - 1; index >= 0; index -= 1) {
      const frame = session.frames[index]
      if (frame && frame.stream === "snapshot") return frame
    }
    return null
  }, [session.frames])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [frameCount])

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="scrollbar-y h-full overflow-y-auto rounded-lg bg-[oklch(0.16_0.014_238)] p-4 font-mono text-xs leading-6 text-[oklch(0.88_0.018_238)] shadow-inner"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2 text-[oklch(0.72_0.02_238)]">
        <span>{session.task}</span>
        <span>{session.updated}</span>
      </div>
      {latestSnapshot ? (
        // A live mirror, not a transcript: no per-line stream colouring, and the
        // screen is kept intact rather than wrapped, so box-drawing TUIs line up.
        <div className="overflow-x-auto">
          <pre className="whitespace-pre font-mono text-xs leading-6">{latestSnapshot.content}</pre>
        </div>
      ) : (
        session.frames.map((frame, index) => (
          <div key={index} className={cn("whitespace-pre-wrap break-words", terminalStreamClass(frame.stream))}>
            {frame.stream === "stdin" ? <span className="text-emerald-400">$ </span> : null}
            {frame.content || " "}
          </div>
        ))
      )}
    </div>
  )
}

/// Per-stream colour for a terminal frame — stdout stays neutral, stderr reads
/// red, system output is dimmed/italic, stdin is the input prompt colour.
function terminalStreamClass(stream: string): string {
  if (stream === "stderr") return "text-rose-400"
  if (stream === "system") return "italic text-[oklch(0.7_0.03_238)]"
  if (stream === "stdin") return "text-emerald-300"
  return ""
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

function reviewDecisionClass(decision: TaskflowTaskReviewDecision) {
  return decision === "approved"
    ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
    : "bg-amber-100 text-amber-800 ring-amber-200"
}

function reviewDecisionLabel(decision: TaskflowTaskReviewDecision) {
  return decision === "approved" ? "Approved" : "Changes requested"
}

function ReviewsPage({
  tasks,
  reviews,
  onReview,
}: {
  tasks: Task[]
  reviews: ReviewFeedItem[]
  onReview: (taskId: string) => void
}) {
  // reviews arrives newest-first, so the first match per task id is the latest
  // real review for that task.
  const latestReviewByTask = new Map<string, ReviewFeedItem>()
  for (const review of reviews) {
    if (!latestReviewByTask.has(review.taskId)) latestReviewByTask.set(review.taskId, review)
  }

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
              <p className="mt-1 text-xs text-muted-foreground">{tasks.length} tasks are waiting for a human decision.</p>
            </div>
          </div>
          {tasks.length ? (
            <div className="scrollbar-y overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead className="bg-muted/55 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">Task</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Owner</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Latest review</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Due</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => {
                    const latest = latestReviewByTask.get(task.id)
                    return (
                    <tr key={task.id} className="border-t">
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize ring-1", priorityClass(task.priority))}>
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
                        {latest ? (
                          <div className="space-y-1.5">
                            <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1", reviewDecisionClass(latest.decision))}>
                              {reviewDecisionLabel(latest.decision)}
                            </span>
                            {latest.body ? (
                              <MarkdownRenderer content={latest.body} compact className="[&_p]:line-clamp-2 [&_p]:text-sm" />
                            ) : null}
                            <p className="text-xs text-muted-foreground">{latest.reviewerLabel} · {latest.time}</p>
                          </div>
                        ) : task.description?.trim() ? (
                          <MarkdownRenderer content={task.description} compact className="[&_p]:line-clamp-2 [&_p]:text-sm" />
                        ) : (
                          <span className="text-xs">No review recorded yet.</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top text-muted-foreground">{task.due}</td>
                      <td className="px-4 py-3 text-right align-top">
                        <Button size="sm" onClick={() => onReview(task.id)}>
                          <ClipboardCheckIcon />
                          Decide
                        </Button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">No pending human reviews.</div>
          )}
        </section>
        <aside className="space-y-3">
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ClipboardCheckIcon className="size-4 text-primary" />
              Recent reviews
            </div>
            {reviews.length ? (
              <ul className="mt-4 space-y-3">
                {reviews.slice(0, 8).map((review) => (
                  <li key={review.id} className="rounded-lg bg-muted/55 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1", reviewDecisionClass(review.decision))}>
                        {reviewDecisionLabel(review.decision)}
                      </span>
                      <span className="text-xs text-muted-foreground">{review.time}</span>
                    </div>
                    <p className="mt-2 truncate text-sm font-medium">{review.taskTitle}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{review.reviewerLabel}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">No review decisions recorded yet.</p>
            )}
          </section>
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheckIcon className="size-4 text-primary" />
              How reviews work
            </div>
            <div className="mt-4 space-y-3">
              <ReviewRule title="Approve" detail="Records an approval and marks the task done." />
              <ReviewRule title="Request changes" detail="Sends the task back to active work with the reviewer note attached." />
            </div>
          </section>
        </aside>
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

/// How many entries to show before "Load more". The feed reaches four figures on
/// an active project — a row per tool call — and rendering all of it was both
/// slow and unreadable.
const ACTIVITY_PAGE_SIZE = 40

/// One line in the feed. Deliberately dense: the old card gave three lines and a
/// row of chips to something like "tool:Read — completed", so a screen held five
/// entries. Everything beyond the headline moves into the detail sheet.
function ActivityRow({
  event,
  onOpen,
}: {
  event: ActivityEvent
  onOpen: (event: ActivityEvent) => void
}) {
  return (
    <div className="relative flex gap-3">
      <span className="relative z-10 mt-1.5 flex size-2 shrink-0 items-center justify-center rounded-full bg-border ring-4 ring-background" />
      <button
        type="button"
        onClick={() => onOpen(event)}
        className="group -my-0.5 flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-muted/60"
      >
        {/* min-w-0 lets the action shrink+ellipsize instead of forcing the row
            wide (a long tool name has no spaces to break on). The detail wraps
            rather than truncating, so nothing pushes a horizontal scroll. */}
        <span className="min-w-0 shrink-0 max-w-[45%] truncate font-mono text-xs text-muted-foreground group-hover:text-foreground">
          {event.action.replace(/_/g, " ")}
        </span>
        <span className="min-w-0 flex-1 break-words text-sm">{event.detail}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{event.actor}</span>
        <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
          {event.time}
        </span>
      </button>
    </div>
  )
}

/// One leaf of a tool payload, flattened to a dotted path.
type MetadataField = { path: string; value: string }

/// Flatten a tool payload into readable fields.
///
/// The payload is nested JSON, and printing it as JSON made the reader do the
/// parsing: the useful part of `{"input":{"command":"…"}}` is the command, and it
/// arrives wrapped in braces, quotes and escaped newlines. Flattening to
/// `input.command` + the raw value lets each value render as markdown — so a
/// multi-line shell command reads as a block, not as one escaped string.
///
/// Arrays keep their index in the path (`edits.0.old_string`) because position
/// is meaningful in a tool call.
function flattenMetadata(value: unknown, prefix = ""): MetadataField[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenMetadata(item, prefix ? `${prefix}.${index}` : String(index)))
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
      flattenMetadata(inner, prefix ? `${prefix}.${key}` : key)
    )
  }
  const text = String(value)
  return text.trim() ? [{ path: prefix, value: text }] : []
}

/// Render a value the way its shape asks for: anything multi-line or shell-ish
/// as a fenced block (so it keeps its line breaks and monospacing), everything
/// else as prose.
function metadataValueMarkdown(value: string): string {
  const multiline = value.includes("\n")
  return multiline ? ["```", value, "```"].join("\n") : value
}

/// The detail panel. Shaped like the board's task sheet — an inset card with its
/// own scroll region — rather than a flush-edge drawer, so the two detail views
/// in the app read as the same thing.
function ActivityDetailSheet({
  event,
  onClose,
}: {
  event: ActivityEvent | null
  onClose: () => void
}) {
  const fields = useMemo<MetadataField[]>(() => {
    if (!event?.metadata) return []
    try {
      return flattenMetadata(JSON.parse(event.metadata))
    } catch {
      // Not JSON (or truncated by the producer) — show it whole rather than
      // dropping it.
      return [{ path: "metadata", value: event.metadata }]
    }
  }, [event])

  if (!event) return null

  return (
    <>
      <button
        type="button"
        aria-label="Close activity details"
        className="fixed inset-0 z-40 bg-foreground/10"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${event.action} details`}
        // Same width as the board task sheet: a tool payload has long command
        // lines, and a narrower panel wraps them into noise.
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
              <p className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                {event.taskLabel ?? "Project"}
              </p>
              <h2 className="mt-1 truncate font-mono text-lg font-semibold">{event.action}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {event.actor} · {event.timestamp ? formatFullDate(event.timestamp) : event.time}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close activity details">
              <XIcon />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          <div className="space-y-4">
            {event.detail ? (
              <section className="rounded-lg border bg-background p-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Summary
                </p>
                <MarkdownRenderer content={event.detail} />
              </section>
            ) : null}

            {fields.length ? (
              <section className="rounded-lg border bg-background p-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Metadata
                </p>
                <div className="space-y-4">
                  {fields.map((field) => (
                    <div key={field.path} className="min-w-0">
                      <p className="mb-1 font-mono text-xs text-muted-foreground">{field.path}</p>
                      <MarkdownRenderer
                        content={metadataValueMarkdown(field.value)}
                        className="min-w-0 text-sm [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </section>
    </>
  )
}

function ActivityLogPage({ title, events }: { title: string; events: ActivityEvent[] }) {
  const [visible, setVisible] = useState(ACTIVITY_PAGE_SIZE)
  const [selected, setSelected] = useState<ActivityEvent | null>(null)
  const [search, setSearch] = useState("")
  const [tool, setTool] = useState<string>(ALL_TOOLS)

  const tools = useMemo(() => activityTools(events), [events])
  const filtered = useMemo(() => filterActivityEvents(events, { search, tool }), [events, search, tool])

  // Reset the paged window whenever the filter changes, so "Load more" always
  // starts from the top of the NEW result set rather than a stale offset.
  useEffect(() => {
    setVisible(ACTIVITY_PAGE_SIZE)
  }, [search, tool])

  // New events arrive at the TOP (the feed is ordered newest-first and realtime
  // now carries the whole row inline, so a live event prepends without a fetch).
  // Growing the window with them keeps everything already on screen in place.
  const shown = filtered.slice(0, visible)
  const remaining = filtered.length - shown.length

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
          <span className="text-xs text-muted-foreground">
            {shown.length} of {filtered.length}
            {filtered.length !== events.length ? ` · ${events.length} total` : ""}
          </span>
        </div>

        {/* Filter + search: by tool (the action name) and free text over the
            visible fields — critical for analysing what each tool does. */}
        <div className="mt-3 space-y-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tools, actors, messages…"
              className="pl-8"
            />
          </div>
          {tools.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {[ALL_TOOLS, ...tools].map((option) => {
                const active = tool === option
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setTool(option)}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition",
                      active
                        ? "bg-primary/10 text-primary ring-primary/30"
                        : "bg-muted/60 text-muted-foreground ring-border hover:bg-muted"
                    )}
                  >
                    {option === ALL_TOOLS ? "All tools" : option}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>

        {events.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed bg-muted/40 p-8 text-center text-sm text-muted-foreground">
            No activity yet. Task moves, agent work, and review decisions will show up here.
          </div>
        ) : filtered.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed bg-muted/40 p-8 text-center text-sm text-muted-foreground">
            No activity matches these filters.{" "}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => {
                setSearch("")
                setTool(ALL_TOOLS)
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <>
            <div className="relative mt-4">
              <div className="absolute bottom-0 left-[3px] top-0 w-px bg-border" />
              <div className="space-y-0.5">
                {shown.map((event) => (
                  <ActivityRow key={event.id} event={event} onOpen={setSelected} />
                ))}
              </div>
            </div>

            {remaining > 0 ? (
              <div className="mt-4 flex justify-center border-t pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setVisible((current) => current + ACTIVITY_PAGE_SIZE)}
                >
                  Load {Math.min(remaining, ACTIVITY_PAGE_SIZE)} more
                  <span className="text-muted-foreground">({remaining} left)</span>
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>

      <ActivityDetailSheet event={selected} onClose={() => setSelected(null)} />
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
            <Button size="sm" onClick={onInvite}>
              <UserRoundPlusIcon />
              Invite
            </Button>
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
              How invites work
            </div>
            <div className="mt-4 space-y-3">
              <InviteFlowStep index="1" title="Invite is created" detail="A pending invite stores the recipient email, role, token, and expiry." />
              <InviteFlowStep index="2" title="Recipient accepts" detail="The invited person signs in and accepts from their Invitations page, which activates their membership." />
            </div>
            <div className="mt-4 space-y-2 border-t pt-4">
              <InviteRole title="Owner" detail="Manage API base, access, and project settings." />
              <InviteRole title="Developer" detail="Claim tasks, work with agents, and update task state." />
              <InviteRole title="Viewer" detail="Read board, logs, reviews, and activity without editing." />
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
  // Same liveness rule as the roster and the terminal: a session row that says
  // connected but stopped heartbeating is a dead process, not a live session.
  const apiLivenessNow = useLivenessNow()
  const connectedSessions = sessions.filter((session) => isSessionLive(session, apiLivenessNow)).length
  const expiredSessions = sessions.filter((session) => session.status === "expired").length
  // "Not live" MINUS the expired ones, which get their own card — otherwise an
  // expired session is counted twice and the three numbers stop summing.
  const disconnectedSessions = sessions.filter(
    (session) => !isSessionLive(session, apiLivenessNow) && session.status !== "expired"
  ).length
  const activeKeys = credentials.filter((credential) => credential.status === "active").length
  const restBase = "/api"
  const realtimeBase = "/realtime"
  const numericProjectId = liveId(project.id)

  return (
    <PageShell
      eyebrow={project.name}
      title="API Base"
      description="Configure the live API target, link coding agents, and inspect agent session identity."
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

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <form className="rounded-lg border bg-card p-4 shadow-sm" onSubmit={onUpdateProject}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileJsonIcon className="size-4 text-primary" />
            Runtime API
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The base URL agents and the dashboard use to reach this project's REST and realtime endpoints.
          </p>
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Base URL</span>
              <Input name="default_api_base_url" defaultValue={project.apiBase || restBase} />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" type="submit">
              <CheckIcon />
              Save API Base
            </Button>
            <Button variant="outline" size="sm" type="button" onClick={onContract}>
              <FileJsonIcon />
              View Contract
            </Button>
          </div>
        </form>

        <LinkAgentCard projectId={numericProjectId} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <AgentSessionsTable sessions={sessions} agents={agents} credentials={credentials} />
        <AgentIdentityPanel project={project} agents={agents} />
      </div>

      <DeveloperEndpoints projectId={project.id} restBase={restBase} realtimeBase={realtimeBase} />
    </PageShell>
  )
}

/// Copies `value` to the clipboard and briefly flips to a "Copied" state so the
/// user gets feedback. Falls back silently if the Clipboard API is unavailable.
function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }, [value])

  return (
    <Button type="button" variant="outline" size="sm" className={className} onClick={handleCopy}>
      {copied ? <ClipboardCheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : label}
    </Button>
  )
}

/// The real "link a coding agent" flow. Collects a display name + profile, calls
/// `linkAgent` with the NUMERIC project id, then shows the one-time key and a
/// ready-to-paste `.taskflow.json` snippet. `projectId` is null when the FE
/// project has no resolvable numeric id (not yet synced) — the form is disabled.
function LinkAgentCard({ projectId }: { projectId: number | null }) {
  const [displayName, setDisplayName] = useState("")
  const [profile, setProfile] = useState("main")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<LinkAgentResult | null>(null)

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (projectId == null) {
        setError("This project is still syncing — try again in a moment.")
        return
      }
      const name = displayName.trim()
      const role = profile.trim() || "main"
      if (!name) {
        setError("Enter a display name for the agent.")
        return
      }
      setPending(true)
      setError(null)
      try {
        const linked = await linkAgent({ project: projectId, display_name: name, profile: role })
        setResult(linked)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not link the agent.")
      } finally {
        setPending(false)
      }
    },
    [projectId, displayName, profile]
  )

  const handleReset = useCallback(() => {
    setResult(null)
    setError(null)
    setDisplayName("")
    setProfile("main")
  }, [])

  const snippet = result
    ? JSON.stringify(
        {
          // The BACKEND origin, not this page's. An agent runs headless and must
          // not depend on the frontend being up — and in dev those differ: the
          // app is served by Vite (:5173) which proxies /api to the backend
          // (:8000), so emitting `window.location.origin` would route every agent
          // call through the dev server. `API_BASE_URL` is the real backend when
          // configured; falling back to the page origin covers the same-origin
          // deployment where they are genuinely the same host.
          server: API_BASE_URL || window.location.origin,
          project: result.project,
          default_profile: "main",
          profiles: {
            [result.profile]: {
              agent_id: result.taskflow_profile.agent_id,
              key: result.taskflow_profile.key,
              display_name: result.taskflow_profile.display_name,
            },
          },
        },
        null,
        2
      )
    : ""

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <BotIcon className="size-4 text-primary" />
        Link a coding agent
      </div>

      {result ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-6 text-muted-foreground">
            Linked <span className="font-semibold text-foreground">{result.display_name}</span> as{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{result.identifier}</code> (profile{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{result.profile}</code>).
          </p>

          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-800">
              <LockIcon className="size-3.5" />
              Copy this key now — it is shown only once and cannot be recovered.
            </div>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1.5 font-mono text-xs">
                {result.key}
              </code>
              <CopyButton value={result.key} label="Copy key" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">.taskflow.json</span>
              <CopyButton value={snippet} label="Copy snippet" />
            </div>
            <pre className="mt-1.5 overflow-x-auto rounded-lg border bg-background p-3 font-mono text-xs leading-5">
              {snippet}
            </pre>
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            Save this as <code className="rounded bg-muted px-1 py-0.5">.taskflow.json</code> in your repo root and add
            it to <code className="rounded bg-muted px-1 py-0.5">.gitignore</code> (it holds a secret). The MCP/agent
            uses the <code className="rounded bg-muted px-1 py-0.5">main</code> profile by default; link a{" "}
            <code className="rounded bg-muted px-1 py-0.5">reviewer</code> profile the same way to add that role.
          </p>

          <Button type="button" variant="outline" size="sm" onClick={handleReset}>
            <RotateCcwIcon />
            Link another
          </Button>
        </div>
      ) : (
        <form className="mt-3 space-y-3" onSubmit={handleSubmit}>
          <p className="text-sm leading-6 text-muted-foreground">
            Mint a per-agent credential for this project. The role you pick is the profile key written into{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">.taskflow.json</code>.
          </p>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Display name</span>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Builder"
              disabled={pending}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Profile</span>
            <Input
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
              placeholder="main"
              list="taskflow-agent-profiles"
              disabled={pending}
            />
            <datalist id="taskflow-agent-profiles">
              <option value="main" />
              <option value="reviewer" />
            </datalist>
          </label>
          {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
          <Button type="submit" size="sm" disabled={pending || projectId == null}>
            <BotIcon />
            {pending ? "Linking…" : "Link agent"}
          </Button>
        </form>
      )}
    </section>
  )
}

/// The genuinely useful REST/realtime entrypoints, collapsed by default so the
/// page reads as a settings surface rather than an endpoint dump.
function DeveloperEndpoints({
  projectId,
  restBase,
  realtimeBase,
}: {
  projectId: string
  restBase: string
  realtimeBase: string
}) {
  return (
    <details className="group rounded-lg border bg-card p-4 shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold">
        <LinkIcon className="size-4 text-primary" />
        Developer endpoints
        <span className="ml-auto text-xs font-normal text-muted-foreground">Show</span>
      </summary>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <IntegrationLink label="OpenAPI schema" value="/openapi/openapi.json" />
        <IntegrationLink label="Projects REST" value={`${restBase}/taskflow_project/`} />
        <IntegrationLink label="Tasks REST" value={`${restBase}/taskflow_task/?project=${projectId}`} />
        <IntegrationLink label="Agents REST" value={`${restBase}/taskflow_agent/?project=${projectId}`} />
        <IntegrationLink label="Realtime runtime" value={`${realtimeBase}/client.js`} />
        <IntegrationLink label="Realtime SSE" value={`${realtimeBase}/sse`} />
      </div>
    </details>
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
  editTask,
  members,
  agents,
  taskOwner,
  onTaskOwnerChange,
  taskOperator,
  onTaskOperatorChange,
  taskDue,
  onTaskDueChange,
  onClose,
  onEditProject,
  onCreateProject,
  onUpdateProject,
  onCreateTask,
  onCreateInvite,
  onReviewDecision,
}: {
  mode: DialogMode
  activeProject: Project | undefined
  reviewTask?: Task
  editTask?: {
    title: string
    status: ColumnId
    priority: Priority
    estimate: string
    description: string
    notes: string
    review: string
  }
  members: TaskflowProjectMember[]
  agents: TaskflowAgent[]
  taskOwner: { id: number; label: string } | null
  onTaskOwnerChange: (owner: { id: number; label: string } | null) => void
  taskOperator: string
  onTaskOperatorChange: (operator: string) => void
  taskDue: string
  onTaskDueChange: (due: string) => void
  onClose: () => void
  onEditProject?: () => void
  onCreateProject: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onUpdateProject: (event: FormEvent<HTMLFormElement>) => void
  onCreateTask: (event: FormEvent<HTMLFormElement>, files: File[]) => void
  onCreateInvite: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onReviewDecision: (event: FormEvent<HTMLFormElement>) => void
}) {
  // Dialog-local submit state so create/invite errors show INLINE and the
  // dialog stays open on failure. The dialog is keyed by `mode` at its call
  // site, so a mode change remounts it and resets this state — no effect needed.
  const [submitting, setSubmitting] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [formError, setFormError] = useState<string | null>(null)
  // Files staged in the task description; uploaded to the task after it saves.
  // The dialog is keyed by mode at its call site, so this resets on remount.
  const [taskFiles, setTaskFiles] = useState<AttachableFile[]>([])
  const stageTaskFiles = (incoming: File[]) => {
    if (!incoming.length) return
    setTaskFiles((current) => [
      ...current,
      ...incoming.map((file) => ({
        id: `staged:${file.name}:${file.size}:${Math.random().toString(36).slice(2, 8)}`,
        file,
      })),
    ])
  }
  const removeTaskFile = (id: string) => setTaskFiles((current) => current.filter((f) => f.id !== id))

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
    "project-info": "Project Info",
    "new-task": "Create Task",
    "edit-task": "Edit Task",
    invite: "Invite User Or Agent",
    "api-contract": "API Contract",
    "review-decision": "Human Review",
  }

  // Radix Select forbids an empty-string item value, so an "unassigned" choice
  // uses this sentinel and maps back to null/"" in the change handlers.
  const NONE_OPTION = "__none__"
  const activeMembers = members.filter((member) => member.status === "active" && member.user != null)

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

        {mode === "new-task" || mode === "edit-task" ? (
          <form
            className="space-y-4 p-5"
            onSubmit={(event) => onCreateTask(event, taskFiles.map((staged) => staged.file))}
          >
            <FormField label="Task title">
              <Input
                name="title"
                required
                placeholder="Write the outcome, not just the activity"
                defaultValue={editTask?.title}
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Status">
                <SelectField name="status" defaultValue={editTask?.status ?? "not_started"} options={statusOptions} />
              </FormField>
              <FormField label="Priority">
                <SelectField name="priority" defaultValue={editTask?.priority ?? "high"} options={priorityOptions} />
              </FormField>
              <FormField label="Owner">
                <Select
                  value={taskOwner ? String(taskOwner.id) : NONE_OPTION}
                  items={[
                    { value: NONE_OPTION, label: "Unassigned" },
                    ...activeMembers.map((member) => ({
                      value: String(member.user),
                      label: member.display_name,
                    })),
                  ]}
                  onValueChange={(value) => {
                    if (value === NONE_OPTION) {
                      onTaskOwnerChange(null)
                      return
                    }
                    const member = activeMembers.find((m) => String(m.user) === value)
                    onTaskOwnerChange(
                      member?.user != null ? { id: member.user, label: member.display_name } : null
                    )
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_OPTION}>Unassigned</SelectItem>
                    {activeMembers.map((member) => (
                      <SelectItem key={member.user} value={String(member.user)}>
                        {member.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Operator">
                <Select
                  value={taskOperator || NONE_OPTION}
                  items={[
                    { value: NONE_OPTION, label: "Unassigned" },
                    ...activeMembers.map((member) => ({
                      value: `user:${member.user}`,
                      label: member.display_name,
                    })),
                    ...agents.map((agent) => ({
                      value: `agent:${agent.id}`,
                      label: agent.display_name,
                    })),
                  ]}
                  onValueChange={(value) => onTaskOperatorChange(!value || value === NONE_OPTION ? "" : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_OPTION}>Unassigned</SelectItem>
                    {activeMembers.map((member) => (
                      <SelectItem key={`user:${member.user}`} value={`user:${member.user}`}>
                        {member.display_name}
                      </SelectItem>
                    ))}
                    {agents.map((agent) => (
                      <SelectItem key={`agent:${agent.id}`} value={`agent:${agent.id}`}>
                        {agent.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Due">
                <Input
                  type="datetime-local"
                  value={taskDue}
                  onChange={(event) => onTaskDueChange(event.target.value)}
                />
              </FormField>
              <FormField label="Estimate">
                <Input name="estimate" placeholder="minutes, e.g. 90" defaultValue={editTask?.estimate} />
              </FormField>
            </div>
            <FormField label="Tags">
              <Input name="tags" placeholder="api, review, frontend" />
            </FormField>
            <FormField label="Description">
              <span className="text-xs text-muted-foreground">
                markdown — attach a file and click it to drop its name at the cursor
              </span>
              <AttachableTextarea
                name="description"
                className={textareaClass}
                placeholder={"### Goal\nDescribe the outcome, acceptance criteria, and constraints."}
                defaultValue={editTask?.description ?? ""}
                files={taskFiles}
                onStageFiles={stageTaskFiles}
                onRemoveFile={removeTaskFile}
              />
            </FormField>
            <FormField label="Notes">
              <span className="text-xs text-muted-foreground">you can write in markdown</span>
              <textarea
                name="notes"
                className={textareaClass}
                placeholder={"- Implementation detail\n- Link to related decision\n- Follow-up to verify"}
                defaultValue={editTask?.notes}
              />
            </FormField>
            <FormField label="Review gate">
              <textarea
                name="review"
                className={textareaClass}
                placeholder="What must a human approve before this can ship?"
                defaultValue={editTask?.review}
              />
            </FormField>
            <DialogActions
              onClose={onClose}
              submitLabel={mode === "edit-task" ? "Save changes" : "Create Task"}
              submitIcon={mode === "edit-task" ? <PencilIcon /> : <PlusIcon />}
            />
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

        {mode === "project-info" ? (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-primary/10 px-2 py-1 font-mono text-xs font-medium text-primary ring-1 ring-primary/20">
                {activeProject?.code}
              </span>
              <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-primary/20">
                {activeProject?.health}
              </span>
              <span className="text-xs text-muted-foreground">{activeProject?.apiBase}</span>
            </div>
            <div className="rounded-xl border bg-background p-4">
              <MarkdownRenderer
                content={activeProject?.objective?.trim() || "No description yet."}
                className="[&_p]:text-sm [&_p]:leading-6"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => onEditProject?.()}>
                <FileTextIcon />
                Edit Project
              </Button>
            </div>
          </div>
        ) : null}
        </div>
      </section>
    </>
  )
}

const textareaClass =
  "min-h-32 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50"

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
