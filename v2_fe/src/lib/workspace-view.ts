import { type TaskflowTaskReviewDecision } from "@/api/client"
import { AlertCircleIcon, CheckCircle2Icon, CircleDotIcon, PlayIcon, ShieldCheckIcon } from "lucide-react"

export const PROJECT_ROOM_TITLE = "Project room"


export type ColumnId = "not_started" | "in_progress" | "review" | "blocked" | "done"


export type Priority = "critical" | "high" | "normal" | "low"


export type DialogMode = "new-project" | "edit-project" | "project-info" | "new-task" | "edit-task" | "invite" | "api-contract" | "review-decision" | null


export type AuthMode = "login" | "signup" | "reset" | "confirm"


export type AuthGateStatus = "checking" | "authenticated" | "anonymous"


export type DropTarget = {
  columnId: ColumnId
  taskId: string | null
  position: "before" | "after"
}


export type ActivityEvent = {
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


export type TaskActivityItem = {
  id: string
  detail: string
  actor: string
  action: string
  time: string
}


export type TaskSession = {
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


export type TaskRelation = {
  id: string
  title: string
  type: "Blocked by" | "Blocks" | "Related" | "Duplicates" | "Parent of" | "Child of"
  status?: ColumnId
  detail: string
  taskId?: string
  /// #39: the taskflow_task_relation row id, present only for real (live)
  /// relations — the handle used to delete the link. Synthetic/fallback
  /// relations have no row and so cannot be removed.
  relationId?: number
}


export type MessagePriority = "normal" | "needs-response" | "blocking"


/// The view model for a rendered attachment — populated from real
/// `TaskflowMessageAttachment` rows (stored) or from staged files still being
/// uploaded (`pending`). `url` is `/media/<key>` for stored attachments and an
/// in-browser object URL for a pending image.
export type AgentAttachment = {
  id: string
  name: string
  contentType: string
  sizeBytes: number
  url: string
  pending?: boolean
}


/// A file the user has staged in the composer but not yet sent. Keeps the real
/// File for upload plus an optional object URL used to preview images.
export type StagedFile = {
  id: string
  file: File
  previewUrl?: string
}


export type AgentMessage = {
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
  /// #107: when the body was last edited (ISO) — drives the "(edited)" marker.
  editedAt?: string | null
  /// #107: true on the user's OWN saved messages — the only ones Edit is
  /// offered on. The server enforces authorship regardless.
  canEdit?: boolean
}


export type ConversationMember = {
  name: string
  type: "human" | "agent"
  /// The agent's numeric id, for directing a channel message to it (#29). Set
  /// only on agent members.
  agentId?: number
  /// The human's auth user id, for mentioning/addressing them (#29). Set only on
  /// human members.
  userId?: number
}


/// #29: one directed target of a chat message — an agent (routed to its pane) or
/// a user (a mention). A message can carry several. Mirrors the backend
/// `targets` JSON array.
export type TargetMember = { kind: "agent" | "user"; id: number; name: string }


export type AgentChatContext = {
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
export type TerminalLine = { stream: string; content: string }


export type AgentTerminalSessionView = {
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


export type InviteRecord = {
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


export type TaskLink = {
  label: string
  value: string
  detail: string
}


export type Project = {
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


export type Task = {
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


export const columns: {
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


export const flow: ColumnId[] = ["not_started", "in_progress", "review", "done"]


export const statusOptions = columns.map((column) => ({
  value: column.id,
  label: column.title,
}))


export const priorityOptions = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
]


export const projectStatusOptions = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "archived", label: "Archived" },
]


export const inviteTypeOptions = [
  { value: "user", label: "User" },
  { value: "agent", label: "Agent" },
]


export const syncModeOptions = [
  { value: "realtime", label: "Realtime" },
  { value: "polling", label: "Polling" },
  { value: "manual", label: "Manual" },
]



export const messagePriorityOptions = [
  { value: "normal", label: "Normal" },
  { value: "needs-response", label: "Needs response" },
  { value: "blocking", label: "Blocking" },
] satisfies Array<{ value: MessagePriority; label: string }>


// Hand-rolled emoji picker data for the chat composer — a tiny inline set (no
// dependency) grouped into generic buckets. Insertion splices at the caret.
export const composerEmojiGroups = [
  { label: "Recent", emojis: ["👍", "✅", "🎯", "🚀", "⏱️", "🙏", "💪", "🔥"] },
  { label: "Smileys", emojis: ["😀", "😄", "😂", "🙂", "😎", "🤝", "🙌", "👏"] },
  { label: "Objects", emojis: ["📦", "🧾", "📌", "⚠️", "🐛", "💡", "📸", "💵"] },
]


export const reviewDecisionOptions = [
  { value: "approve", label: "Approve and mark done" },
  { value: "changes", label: "Request changes" },
  { value: "blocked", label: "Block until clarified" },
]


export function nextStatus(status: ColumnId): ColumnId {
  if (status === "blocked") return "in_progress"
  const index = flow.indexOf(status)
  return flow[Math.min(index + 1, flow.length - 1)]
}


export function previousStatus(status: ColumnId): ColumnId {
  if (status === "blocked") return "not_started"
  const index = flow.indexOf(status)
  return flow[Math.max(index - 1, 0)]
}


export function priorityClass(priority: Priority) {
  if (priority === "critical") return "bg-rose-100 text-rose-800 ring-rose-200"
  if (priority === "high") return "bg-amber-100 text-amber-800 ring-amber-200"
  if (priority === "normal") return "bg-slate-100 text-slate-700 ring-slate-200"
  return "bg-muted text-muted-foreground ring-border"
}


export function statusLabel(status?: ColumnId) {
  if (!status) return "External"
  return columns.find((column) => column.id === status)?.title ?? status
}


export function relationTone(type: TaskRelation["type"]) {
  if (type === "Blocked by") return "bg-rose-100 text-rose-800 ring-rose-200"
  if (type === "Blocks") return "bg-amber-100 text-amber-800 ring-amber-200"
  if (type === "Duplicates") return "bg-violet-100 text-violet-800 ring-violet-200"
  if (type === "Parent of" || type === "Child of") return "bg-sky-100 text-sky-800 ring-sky-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}

export function countMemberType(members: ConversationMember[], type: ConversationMember["type"]) {
  return members.filter((member) => member.type === type).length
}

export function agentStatusClass(status: string) {
  if (status === "Active" || status === "connected" || status === "idle" || status === "busy") {
    return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  }
  if (status === "Review" || status === "blocked") return "bg-amber-100 text-amber-800 ring-amber-200"
  if (status === "revoked" || status === "offline") return "bg-rose-100 text-rose-800 ring-rose-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}

export function reviewDecisionClass(decision: TaskflowTaskReviewDecision) {
  return decision === "approved"
    ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
    : "bg-amber-100 text-amber-800 ring-amber-200"
}

export function reviewDecisionLabel(decision: TaskflowTaskReviewDecision) {
  return decision === "approved" ? "Approved" : "Changes requested"
}
