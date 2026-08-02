import { columns, type ActivityEvent, type AgentAttachment, type AgentChatContext, type AgentMessage, type AgentTerminalSessionView, type ColumnId, type ConversationMember, type DropTarget, type InviteRecord, type MessagePriority, type Priority, type Project, type Task, type TaskActivityItem, type TaskLink, type TaskRelation, type TaskSession, type TerminalLine } from "@/lib/workspace-view"
import { formatEstimateMinutes } from "@/lib/tasks"
import { isPending, type PendingAttachment } from "@/lib/message-store"
import { API_BASE_URL, type AuthUser } from "@/lib/auth-api"
import { type TaskflowAgent, type TaskflowAgentMessage, type TaskflowAgentMessagePriority, type TaskflowAgentSession, type TaskflowMessageAttachment, type TaskflowProjectInviteRole, type TaskflowProjectInviteStatus, type TaskflowProjectMember, type TaskflowTaskPriority, type TaskflowTaskRelationKind, type TaskflowTaskReviewDecision, type TaskflowTaskStatus } from "@/api/client"
import { type TaskflowProjectSummary, type TaskflowRealtimeEvent, type TaskflowWorkspace } from "@/lib/taskflow-api"


export function getTaskSessions(task: Task): TaskSession[] {
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


export function getTaskRelations(task: Task, projectTasks: Task[]): TaskRelation[] {
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


/// #39: the link kinds a human can create, with their picker labels. The label
/// is written from the CURRENT task's perspective (it is the relation's source).
export const RELATION_KIND_OPTIONS: { value: TaskflowTaskRelationKind; label: string }[] = [
  { value: "blocks", label: "Blocks" },
  { value: "related_to", label: "Related to" },
  { value: "duplicates", label: "Duplicates" },
  { value: "parent_child", label: "Parent of" },
]


export function relationKindLabel(kind: TaskflowWorkspace["taskRelations"][number]["kind"], isSource: boolean): TaskRelation["type"] {
  if (kind === "blocks") return isSource ? "Blocks" : "Blocked by"
  if (kind === "duplicates") return "Duplicates"
  // parent_child is directional: the SOURCE is the parent of the target.
  if (kind === "parent_child") return isSource ? "Parent of" : "Child of"
  return "Related"
}


export function getLiveTaskRelations(task: Task, projectTasks: Task[], workspace: TaskflowWorkspace): TaskRelation[] {
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
        relationId: relation.id,
      }
    })
}


export function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return "Running"
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}


export function sessionDurationSeconds(session: TaskflowWorkspace["taskSessions"][number], end = new Date()) {
  if (session.duration_seconds != null) return session.duration_seconds
  const startedAt = new Date(session.started_at)
  if (Number.isNaN(startedAt.getTime())) return 0
  const endedAt = session.ended_at ? new Date(session.ended_at) : end
  if (Number.isNaN(endedAt.getTime())) return 0
  return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))
}


export function getRunningLiveTaskSession(task: Task, workspace: TaskflowWorkspace) {
  const taskId = liveId(task.id)
  if (!taskId) return undefined

  return workspace.taskSessions
    .filter((session) => session.task === taskId && session.state === "running" && !session.ended_at)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .at(0)
}


export function getTaskSessionTotalSeconds(task: Task, workspace: TaskflowWorkspace) {
  const taskId = liveId(task.id)
  if (!taskId) return 0
  return workspace.taskSessions
    .filter((session) => session.task === taskId)
    .reduce((total, session) => total + sessionDurationSeconds(session), 0)
}


export function mapLiveSessionState(state: TaskflowWorkspace["taskSessions"][number]["state"]): TaskSession["state"] {
  if (state === "running") return "active"
  if (state === "paused") return "paused"
  if (state === "failed") return "failed"
  return "complete"
}


export function getLiveTaskSessions(task: Task, workspace: TaskflowWorkspace): TaskSession[] {
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


export function getLiveTaskActivity(task: Task, workspace: TaskflowWorkspace): TaskActivityItem[] {
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
export function mapLiveActivityEvents(workspace: TaskflowWorkspace, projectTasks: Task[]): ActivityEvent[] {
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


export type ReviewFeedItem = {
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
export function mapLiveReviews(workspace: TaskflowWorkspace, projectTasks: Task[]): ReviewFeedItem[] {
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


export type TaskReviewEntry = {
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
export function getLiveTaskReviews(task: Task, workspace: TaskflowWorkspace): TaskReviewEntry[] {
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
export function getTaskAttachments(task: Task, workspace: TaskflowWorkspace): AgentAttachment[] {
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


export function getFallbackTaskActivity(task: Task): TaskActivityItem[] {
  return task.history.map((event, index) => ({
    id: `${task.id}-history-${index}`,
    actor: task.operatorName,
    action: index === 0 ? "latest_update" : "activity_logged",
    time: index === 0 ? task.updated : `${index + 1} events ago`,
    detail: event,
  }))
}


export function getTaskLinks(task: Task, project: Project): TaskLink[] {
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


export function getTaskDescription(task: Task) {
  if (task.description?.trim()) return task.description

  const blockers =
    task.blockers.length > 0
      ? `\n\n### Blockers\n${task.blockers.map((blocker) => `- ${blocker}`).join("\n")}`
      : ""

  return `### Outcome\n${task.review}\n\n### Scope\n- Owner: **${task.owner}**\n- Operator: \`${task.operatorName}\`\n- Tags: ${task.tags.map((tag) => `\`${tag}\``).join(", ")}${blockers}`
}


export function getTaskNotes(task: Task) {
  if (task.notes?.trim()) return task.notes

  return `- Latest update: ${task.history[0] ?? "No activity yet."}\n- Estimate: **${task.estimate}**\n- Due: **${task.due}**`
}


export function toInitials(value: string) {
  return value
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "TF"
}


export function slugifyProjectName(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")

  return slug || `project-${Date.now()}`
}


export function liveId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}


export function liveProjectTint(index: number) {
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
export function formatFullDate(value: string | null | undefined, fallback = "") {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date)
}


export function formatLiveDate(value: string | null | undefined, fallback = "Live") {
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
export function formatMessageTime(value: string | null | undefined, fallback = "Live") {
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
export function chatIdToSlug(id: string): string {
  return id.replace(/^live:/, "").replace(/:/g, "-")
}


export function slugToChatId(slug: string): string {
  const typed = /^(channel|direct|member|agent)-(\d+)$/.exec(slug)
  if (typed) return `live:${typed[1]}:${typed[2]}`
  return `live:${slug}`
}


/// How many messages a conversation renders at once. The thread windows to the
/// last N messages and reveals another page of N as the user scrolls to the top
/// (reverse-infinite-scroll). One constant serves both DMs and rooms — it's a
/// per-conversation window, not a global cap.
export const MESSAGE_PAGE_SIZE = 20


/// Start-of-day timestamp (local time) for calendar-day comparisons.
export function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}


/// Resolve a message's ISO `createdAt` to a real Date, falling back to "now" for
/// pending/undated bubbles — they are the newest thing in the room, so grouping
/// them under today's date is correct.
export function messageDay(value: string | null | undefined): Date {
  if (value) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}


/// A stable local calendar-day key for grouping consecutive messages.
export function messageDayKey(value: string | null | undefined): string {
  const day = messageDay(value)
  return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
}


/// A friendly separator label: "Today" / "Yesterday" for the two most recent
/// days, otherwise a locale date like "Jul 18, 2026".
export function formatDateSeparatorLabel(value: string | null | undefined): string {
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
export type ThreadItem =
  | { type: "date"; key: string; label: string }
  | { type: "message"; message: AgentMessage }


/// Interleave centered date separators into a (windowed) message list so the
/// separators render in the right places without touching AgentChatBubble.
export function buildThreadItems(messages: AgentMessage[]): ThreadItem[] {
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


export function mapLiveStatus(status: TaskflowTaskStatus): ColumnId {
  if (status === "partial_done") return "review"
  if (status === "paused") return "blocked"
  if (status === "archived") return "done"
  return status
}


export function toLiveStatus(status: ColumnId): TaskflowTaskStatus {
  if (status === "review") return "partial_done"
  return status
}


// The board Priority now mirrors the backend priority 1:1 (critical/high/
// normal/low), so these are faithful identities — no lossy 3-level P-code
// squashing that used to make `low` indistinguishable from `normal` (and turn
// a `low` task into `normal` on edit).
export function mapLivePriority(priority: TaskflowTaskPriority): Priority {
  return priority
}


export function toLivePriority(priority: Priority): TaskflowTaskPriority {
  return priority
}


/// An agent heartbeats while it holds a live session; a stale heartbeat means it
/// went away without a clean disconnect. 90s is the backend's liveness window
/// (`AGENT_HEARTBEAT_WINDOW_SECS` in taskflow-agents/src/views.rs — keep equal).
export const AGENT_HEARTBEAT_WINDOW_MS = 90_000


export function isRecentHeartbeat(timestamp: string | null | undefined, now: number): boolean {
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
export function isSessionLive(
  session: Pick<TaskflowAgentSession, "status" | "last_seen_at">,
  now: number
): boolean {
  return session.status === "connected" && isRecentHeartbeat(session.last_seen_at, now)
}


/// Live online state for an agent: it must have a CONNECTED session heartbeated
/// within the window, or (fallback) the agent row itself must be in a live status
/// and heartbeated within the window. A disconnected/expired session, or a status
/// row that stopped heartbeating, reads as offline.
export function isAgentOnline(
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
export function countOnlineAgents(workspace: TaskflowWorkspace, now: number): number {
  return workspace.agents.filter((agent) =>
    isAgentOnline(agent.id, workspace.agents, workspace.agentSessions, now)
  ).length
}


export function mapLiveProjects(summary: TaskflowProjectSummary): Project[] {
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


export function mapLiveTasks(
  tasks: TaskflowWorkspace["tasks"],
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


/// #56: the 1000-row NoPagination ceiling is gone — every list pages at 25 now
/// (PageNumberPagination in backend/src/main.rs), and `count` in the envelope
/// reports the true total. ACTIVITY_SERVER_CAP and the id-cursor windows it
/// forced (#38) went with it: "did we get exactly 1000?" is not a question a
/// paged API can answer.


export function upsertById<T extends { id: number }>(items: T[], row: T) {
  const index = items.findIndex((item) => item.id === row.id)
  if (index < 0) return [...items, row]
  return [...items.slice(0, index), row, ...items.slice(index + 1)]
}


/// #44: upsert then keep only the newest `max` rows, so a high-volume live feed
/// (terminal frames especially) can't grow the workspace without bound. New rows
/// append at the end, so the tail is the newest — slice the oldest off the front.
export function upsertCapped<T extends { id: number }>(items: T[], row: T, max: number): T[] {
  const next = upsertById(items, row)
  return next.length > max ? next.slice(next.length - max) : next
}


/// #44: caps on the two live feeds that grow with agent activity, not user
/// actions. Terminal frames arrive ~one per output line (fastest grower);
/// activity ~one per tool call. Both keep far more than the UI shows.
export const MAX_LIVE_TERMINAL_FRAMES = 4000

export const MAX_LIVE_ACTIVITY = 8000


/// #44: revoke any object-URL previews on a pending message row. A failed
/// optimistic bubble keeps its blob thumbnails so the user still sees what they
/// tried to send; when that row is later dismissed or reconciled to real /media
/// links, those blobs must be freed or they pin the image File in memory.
export function revokeBlobUrls(attachments?: Array<{ url?: string }>) {
  for (const attachment of attachments ?? []) {
    if (attachment.url?.startsWith("blob:")) URL.revokeObjectURL(attachment.url)
  }
}


export function removeById<T extends { id: number }>(items: T[], id: number) {
  return items.filter((item) => item.id !== id)
}


export function mapLiveProjectRow(project: TaskflowWorkspace["project"], current?: Project, index = 0): Project {
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


export function mapLiveMessagePriority(priority: TaskflowAgentMessagePriority): MessagePriority {
  if (priority === "urgent") return "blocking"
  if (priority === "important") return "needs-response"
  return "normal"
}


export function toLiveMessagePriority(priority: MessagePriority): TaskflowAgentMessagePriority {
  if (priority === "blocking") return "urgent"
  if (priority === "needs-response") return "important"
  return "normal"
}


export function mapLiveInviteRole(role: TaskflowProjectInviteRole): InviteRecord["role"] {
  if (role === "owner" || role === "admin") return "Owner"
  if (role === "viewer") return "Viewer"
  return "Developer"
}


export function toLiveInviteRole(role: string): TaskflowProjectInviteRole {
  if (role === "owner") return "owner"
  if (role === "viewer") return "viewer"
  return "developer"
}


export function mapLiveInviteStatus(status: TaskflowProjectInviteStatus): InviteRecord["status"] {
  if (status === "accepted") return "Accepted"
  if (status === "expired") return "Expired"
  if (status === "revoked") return "Revoked"
  return "Pending"
}


export function formatInviteWindow(invite: TaskflowWorkspace["invites"][number]) {
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


export function isAgentInviteEmail(email: string) {
  return email.toLowerCase().endsWith("@agents.taskflow.local")
}


export function normalizeAgentInviteEmail(recipient: string) {
  if (recipient.includes("@")) return recipient.toLowerCase()
  return `${slugifyProjectName(recipient)}@agents.taskflow.local`
}


export function mapLiveInvites(workspace: TaskflowWorkspace, currentUser: AuthUser | null): InviteRecord[] {
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


export function uniqueMembers(members: ConversationMember[]) {
  const seen = new Set<string>()
  return members.filter((member) => {
    // Dedup by stable IDENTITY, not display name: two different people can share
    // a name (and the same person can carry different labels across sources), so
    // keying on the name would both merge distinct users and split one. Fall back
    // to the name only when there is no id to key on.
    const key =
      member.type === "agent" && member.agentId != null
        ? `agent:${member.agentId}`
        : member.type === "human" && member.userId != null
          ? `user:${member.userId}`
          : `${member.type}:${member.name.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}


export function workspaceDefaultMembers(workspace: TaskflowWorkspace, currentUser: AuthUser | null): ConversationMember[] {
  return uniqueMembers([
    ...workspace.members
      .filter((member) => member.status === "active")
      .map((member) => ({ name: member.display_name, type: "human" as const, userId: member.user ?? undefined })),
    ...(currentUser ? [{ name: currentUser.username, type: "human" as const, userId: currentUser.id }] : []),
    ...workspace.agents.map((agent) => ({ name: agent.display_name, type: "agent" as const, agentId: agent.id })),
  ])
}


export function mapLiveChannelMembers(
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
      userId: member.member_kind === "agent" ? undefined : (member.user ?? undefined),
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


export function primaryAgentName(workspace: TaskflowWorkspace, members: ConversationMember[]) {
  return members.find((member) => member.type === "agent")?.name ?? workspace.agents[0]?.display_name ?? "project"
}


export function mapLiveChannelMessages(
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
      const own =
        message.sender_kind === "user" && currentUser != null && message.sender_user === currentUser.id
      return {
        id: String(message.id),
        from: own ? "user" : message.sender_label,
        to: channelTitle,
        time: formatMessageTime(message.created_at, "Live"),
        createdAt: message.created_at,
        body: message.body_markdown,
        status: "posted",
        priority: mapLiveMessagePriority(message.priority),
        seen: seenOwnMessageId != null && message.id === seenOwnMessageId,
        editedAt: message.edited_at,
        canEdit: own,
        attachments: workspace.messageAttachments
          .filter((attachment) => attachment.message === message.id)
          .map(mapStoredAttachment),
      }
    })
}


export function liveChannelStatus(channel: TaskflowWorkspace["agentChannels"][number]) {
  if (channel.archived) return "Archived"
  if (channel.kind === "task") return "Task room"
  if (channel.kind === "incident") return "Incident room"
  if (channel.kind === "direct") return "Direct"
  return "Project room"
}


/// Unread count for the current user in a channel: saved messages newer than
/// the user's own read cursor that the user did NOT author. With no cursor, it's
/// every message not authored by the user. Pending (unsent) bubbles never count.
export function channelUnreadCount(
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


export function mapLiveChannelChats(workspace: TaskflowWorkspace, currentUser: AuthUser | null): AgentChatContext[] {
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
export const DIRECT_CHANNEL_PARTICIPANTS = 2


export function mapLiveDirectChats(workspace: TaskflowWorkspace, currentUser: AuthUser | null, now: number): AgentChatContext[] {
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
  // #42: DMs are membership-driven. We list ONLY the direct rooms the user is
  // actually on the roster of — no auto-invented placeholder per member/agent.
  // (That old placeholder list also self-excluded on `currentUser?.id`, which
  // failed OPEN when currentUser was momentarily null and showed you your own
  // name.) New DMs are created explicitly and the server dedups them.
  return chats
}


/// Label for a session, given the stored status and whether it is actually live.
/// `expired` is kept distinct from a plain disconnect — it says the backend aged
/// the session out, which is a different story from a clean close.
export function mapLiveTerminalStatus(
  status: TaskflowWorkspace["agentSessions"][number]["status"],
  live: boolean
) {
  if (status === "expired") return "Expired"
  return live ? "Connected" : "Disconnected"
}


export function mapLiveTerminalSessions(workspace: TaskflowWorkspace, now: number): AgentTerminalSessionView[] {
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
export function resolveAttachmentUrl(raw: string | null | undefined): string {
  if (!raw) return ""
  if (/^(https?:|blob:)/.test(raw)) return raw
  // A relative `/media/<key>` (REST read) or a bare key both resolve to the API
  // origin — media is served by the backend, a different origin than the SPA in
  // prod. API_BASE_URL is "" in dev, so this stays same-origin there.
  if (raw.startsWith("/media/")) return `${API_BASE_URL}${raw}`
  if (raw.startsWith("/")) return raw
  return `${API_BASE_URL}/media/${raw}`
}


/// Resolve a stored attachment row to the display view model.
export function mapStoredAttachment(attachment: TaskflowMessageAttachment): AgentAttachment {
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
export function mapPendingAttachment(attachment: PendingAttachment): AgentAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    contentType: attachment.content_type,
    sizeBytes: attachment.size_bytes,
    url: attachment.url,
    pending: true,
  }
}


export function realtimeEventRowId(event: TaskflowRealtimeEvent) {
  const id = Number(event.row.id)
  return Number.isInteger(id) && id > 0 ? id : null
}


export function mergeProjectTasks(currentTasks: Task[], projectId: string, nextProjectTasks: Task[]) {
  return [
    ...currentTasks.filter((task) => task.projectId !== projectId),
    ...nextProjectTasks,
  ]
}


export function reorderTasks(tasks: Task[], taskId: string, target: DropTarget) {
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
