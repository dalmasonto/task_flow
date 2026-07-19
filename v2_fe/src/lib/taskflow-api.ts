import { Umbral } from "@/api/client"
import type {
  ModelEvents,
  Subscription,
  TaskflowAgent,
  TaskflowAgentChannel,
  TaskflowAgentChannelCreate,
  TaskflowAgentChannelMember,
  TaskflowAgentChannelMemberCreate,
  TaskflowAgentCredential,
  TaskflowAgentMessage,
  TaskflowAgentSession,
  TaskflowAgentTerminalFrame,
  TaskflowChannelReadCursor,
  TaskflowMessageAttachment,
  TaskflowProject,
  TaskflowProjectApiEndpoint,
  TaskflowProjectInvite,
  TaskflowProjectMember,
  TaskflowProjectUpdate,
  TaskflowTask,
  TaskflowTaskActivity,
  TaskflowTaskActivityCreate,
  TaskflowTaskCreate,
  TaskflowTaskRelation,
  TaskflowTaskReview,
  TaskflowTaskSession,
  TaskflowTaskSessionCreate,
  TaskflowTaskSessionUpdate,
  TaskflowTaskUpdate,
  TaskflowUserSettings,
  TaskflowUserSettingsTheme,
  UmbralResources,
} from "@/api/client"
import { API_BASE_URL, getStoredToken } from "@/lib/auth-api"
import type { ChatMessage } from "@/lib/message-store"

export const taskflowTables = {
  projects: "taskflow_project",
  members: "taskflow_project_member",
  invites: "taskflow_project_invite",
  apiEndpoints: "taskflow_project_api_endpoint",
  tasks: "taskflow_task",
  taskRelations: "taskflow_task_relation",
  taskActivity: "taskflow_task_activity",
  taskSessions: "taskflow_task_session",
  agents: "taskflow_agent",
  agentCredentials: "taskflow_agent_credential",
  agentSessions: "taskflow_agent_session",
  agentChannels: "taskflow_agent_channel",
  agentChannelMembers: "taskflow_agent_channel_member",
  agentMessages: "taskflow_agent_message",
  messageAttachments: "taskflow_message_attachment",
  terminalFrames: "taskflow_agent_terminal_frame",
  channelReadCursors: "taskflow_channel_read_cursor",
  taskReviews: "taskflow_task_review",
} as const

/// Group suffixes are a contract with backend/src/realtime.rs — short labels,
/// not table names. A mismatch fails silently: the subscription opens and
/// simply never fires.
const realtimeGroupSuffixes = {
  [taskflowTables.members]: "project_members",
  [taskflowTables.invites]: "project_invites",
  [taskflowTables.apiEndpoints]: "api_endpoints",
  [taskflowTables.tasks]: "tasks",
  [taskflowTables.taskRelations]: "task_relations",
  [taskflowTables.taskActivity]: "task_activity",
  [taskflowTables.taskSessions]: "task_sessions",
  [taskflowTables.agents]: "agents",
  [taskflowTables.agentCredentials]: "agent_credentials",
  [taskflowTables.agentSessions]: "agent_sessions",
  [taskflowTables.agentChannels]: "channels",
  [taskflowTables.agentChannelMembers]: "channel_members",
  [taskflowTables.agentMessages]: "messages",
  [taskflowTables.messageAttachments]: "message_attachments",
  [taskflowTables.terminalFrames]: "terminal_frames",
  [taskflowTables.channelReadCursors]: "read_cursors",
  [taskflowTables.taskReviews]: "task_reviews",
} as const satisfies Record<Exclude<RealtimeTableName, typeof taskflowTables.projects>, string>

export const taskflowGroups = {
  projects: "taskflow:projects",
  presence: (projectId: number | string) => `project:${projectId}:presence`,
  forTable: (table: keyof typeof realtimeGroupSuffixes, projectId: number | string) =>
    `project:${projectId}:${realtimeGroupSuffixes[table]}`,
} as const

export const taskflowApi = new Umbral(API_BASE_URL, {
  credentials: "include",
  realtimePath: "/realtime",
  getAuthHeaders: () => {
    const token = getStoredToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  },
})

export type TaskflowWorkspace = {
  project: TaskflowProject
  members: TaskflowProjectMember[]
  invites: TaskflowProjectInvite[]
  apiEndpoints: TaskflowProjectApiEndpoint[]
  tasks: TaskflowTask[]
  taskRelations: TaskflowTaskRelation[]
  taskActivity: TaskflowTaskActivity[]
  taskSessions: TaskflowTaskSession[]
  agents: TaskflowAgent[]
  agentCredentials: TaskflowAgentCredential[]
  agentSessions: TaskflowAgentSession[]
  agentChannels: TaskflowAgentChannel[]
  agentChannelMembers: TaskflowAgentChannelMember[]
  agentMessages: ChatMessage[]
  messageAttachments: TaskflowMessageAttachment[]
  terminalFrames: TaskflowAgentTerminalFrame[]
  channelReadCursors: TaskflowChannelReadCursor[]
  taskReviews: TaskflowTaskReview[]
}

export type TaskflowProjectSummary = {
  projects: TaskflowProject[]
  members: TaskflowProjectMember[]
  tasks: TaskflowTask[]
  agents: TaskflowAgent[]
  sessions: TaskflowAgentSession[]
}

type TableName = keyof UmbralResources

export type TaskflowRealtimeAction = "created" | "updated" | "deleted"

type RealtimeTableName =
  | typeof taskflowTables.projects
  | typeof taskflowTables.members
  | typeof taskflowTables.invites
  | typeof taskflowTables.apiEndpoints
  | typeof taskflowTables.tasks
  | typeof taskflowTables.taskRelations
  | typeof taskflowTables.taskActivity
  | typeof taskflowTables.taskSessions
  | typeof taskflowTables.agents
  | typeof taskflowTables.agentCredentials
  | typeof taskflowTables.agentSessions
  | typeof taskflowTables.agentChannels
  | typeof taskflowTables.agentChannelMembers
  | typeof taskflowTables.agentMessages
  | typeof taskflowTables.messageAttachments
  | typeof taskflowTables.terminalFrames
  | typeof taskflowTables.channelReadCursors
  | typeof taskflowTables.taskReviews

export type TaskflowRealtimeEvent = {
  table: RealtimeTableName
  action: TaskflowRealtimeAction
  row: Record<string, unknown>
}

const projectScopedRealtimeTables = [
  taskflowTables.members,
  taskflowTables.invites,
  taskflowTables.apiEndpoints,
  taskflowTables.tasks,
  taskflowTables.taskRelations,
  taskflowTables.taskActivity,
  taskflowTables.taskSessions,
  taskflowTables.agents,
  taskflowTables.agentCredentials,
  taskflowTables.agentSessions,
  taskflowTables.agentChannels,
  taskflowTables.agentChannelMembers,
  taskflowTables.agentMessages,
  taskflowTables.messageAttachments,
  taskflowTables.terminalFrames,
  taskflowTables.channelReadCursors,
  taskflowTables.taskReviews,
] satisfies RealtimeTableName[]

/// Chat tables project their fields (backend/src/realtime.rs), so their events
/// carry the whole row and need no refetch. Everything else is id-only.
export const realtimeTablesWithInlineRows = [
  taskflowTables.agentMessages,
  taskflowTables.messageAttachments,
  taskflowTables.agentChannels,
  taskflowTables.agentChannelMembers,
  taskflowTables.terminalFrames,
] as const satisfies readonly RealtimeTableName[]

export function realtimeEventHasInlineRow(table: RealtimeTableName): boolean {
  return (realtimeTablesWithInlineRows as readonly string[]).includes(table)
}

function onAnyModelChange(onChange: () => void): ModelEvents<Record<string, unknown>> {
  return {
    created: onChange,
    updated: onChange,
    deleted: onChange,
  }
}

function onRealtimeModelChange(
  table: RealtimeTableName,
  onEvent: (event: TaskflowRealtimeEvent) => void
): ModelEvents<Record<string, unknown>> {
  return {
    created: (row) => onEvent({ table, action: "created", row }),
    updated: (row) => onEvent({ table, action: "updated", row }),
    deleted: (row) => onEvent({ table, action: "deleted", row }),
  }
}

function closeAll(subscriptions: Subscription[]) {
  for (const subscription of subscriptions) {
    subscription.close()
  }
}

export async function fetchTaskflowProjectSummary(): Promise<TaskflowProjectSummary> {
  const [projects, members, tasks, agents, sessions] = await Promise.all([
    taskflowApi.from(taskflowTables.projects).orderBy("name", "id").list(),
    taskflowApi.from(taskflowTables.members).orderBy("project", "display_name").list(),
    taskflowApi.from(taskflowTables.tasks).orderBy("project", "sort_order", "id").list(),
    taskflowApi.from(taskflowTables.agents).orderBy("project", "display_name").list(),
    taskflowApi.from(taskflowTables.agentSessions).orderBy("project", "-last_seen_at", "-id").list(),
  ])

  return {
    projects: projects.results,
    members: members.results,
    tasks: tasks.results,
    agents: agents.results,
    sessions: sessions.results,
  }
}

export async function fetchTaskflowWorkspace(projectId: number): Promise<TaskflowWorkspace> {
  const [
    project,
    members,
    invites,
    apiEndpoints,
    tasks,
    taskRelations,
    taskActivity,
    taskSessions,
    agents,
    agentCredentials,
    agentSessions,
    agentChannels,
    agentChannelMembers,
    agentMessages,
    messageAttachments,
    terminalFrames,
    channelReadCursors,
    taskReviews,
  ] = await Promise.all([
    taskflowApi.get(taskflowTables.projects, projectId),
    taskflowApi.from(taskflowTables.members).filter({ project: projectId }).orderBy("display_name", "id").list(),
    taskflowApi.from(taskflowTables.invites).filter({ project: projectId }).orderBy("-created_at", "-id").list(),
    taskflowApi.from(taskflowTables.apiEndpoints).filter({ project: projectId }).orderBy("environment", "label").list(),
    taskflowApi.from(taskflowTables.tasks).filter({ project: projectId }).orderBy("sort_order", "id").list(),
    taskflowApi.from(taskflowTables.taskRelations).filter({ project: projectId }).orderBy("kind", "id").list(),
    taskflowApi.from(taskflowTables.taskActivity).filter({ project: projectId }).orderBy("-created_at", "-id").list(),
    taskflowApi.from(taskflowTables.taskSessions).filter({ project: projectId }).orderBy("-started_at", "-id").list(),
    taskflowApi.from(taskflowTables.agents).filter({ project: projectId }).orderBy("display_name", "id").list(),
    taskflowApi.from(taskflowTables.agentCredentials).filter({ project: projectId }).orderBy("-created_at", "-id").list(),
    taskflowApi.from(taskflowTables.agentSessions).filter({ project: projectId }).orderBy("-last_seen_at", "-id").list(),
    taskflowApi.from(taskflowTables.agentChannels).filter({ project: projectId }).orderBy("title", "id").list(),
    taskflowApi.from(taskflowTables.agentChannelMembers).orderBy("channel", "display_name").list(),
    taskflowApi.from(taskflowTables.agentMessages).filter({ project: projectId }).orderBy("created_at", "id").list(),
    taskflowApi.from(taskflowTables.messageAttachments).filter({ project: projectId }).orderBy("message", "id").list(),
    taskflowApi.from(taskflowTables.terminalFrames).filter({ project: projectId }).orderBy("agent", "sequence", "id").list(),
    taskflowApi.from(taskflowTables.channelReadCursors).filter({ project: projectId }).orderBy("channel", "id").list(),
    taskflowApi.from(taskflowTables.taskReviews).filter({ project: projectId }).orderBy("-created_at", "-id").list(),
  ])

  const channelIds = new Set(agentChannels.results.map((channel) => channel.id))

  return {
    project,
    members: members.results,
    invites: invites.results,
    apiEndpoints: apiEndpoints.results,
    tasks: tasks.results,
    taskRelations: taskRelations.results,
    taskActivity: taskActivity.results,
    taskSessions: taskSessions.results,
    agents: agents.results,
    agentCredentials: agentCredentials.results,
    agentSessions: agentSessions.results,
    agentChannels: agentChannels.results,
    agentChannelMembers: agentChannelMembers.results.filter((member) => channelIds.has(member.channel)),
    agentMessages: agentMessages.results,
    messageAttachments: messageAttachments.results,
    terminalFrames: terminalFrames.results,
    channelReadCursors: channelReadCursors.results,
    taskReviews: taskReviews.results,
  }
}

/// Advance the current user's read cursor for a channel to `lastReadMessage`.
/// Bearer-authed as the human caller; the backend derives the member identity
/// from the token. Best-effort — callers may swallow errors.
export async function markChannelRead(channelId: number, lastReadMessage: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/channels/${channelId}/read`, {
    method: "POST",
    credentials: "include",
    headers: bearerHeaders(),
    body: JSON.stringify({ last_read_message: lastReadMessage }),
  })
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `Could not mark the channel read (${response.status}).`))
  }
}

/// Record a human review decision on a task. The backend writes the review row,
/// transitions the task, and posts the report-back message to the agent. Bearer-
/// authed as the human caller. `bodyMarkdown` is the optional review note.
export async function reviewTask(
  taskId: number,
  decision: "approved" | "changes_requested",
  bodyMarkdown?: string
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/tasks/${taskId}/review`, {
    method: "POST",
    credentials: "include",
    headers: bearerHeaders(),
    body: JSON.stringify({ decision, ...(bodyMarkdown ? { body_markdown: bodyMarkdown } : {}) }),
  })
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "You are not allowed to review this task."
        : await readErrorDetail(response, `Could not submit the review (${response.status}).`)
    )
  }
}

export function createTaskflowTask(input: TaskflowTaskCreate) {
  return taskflowApi.create(taskflowTables.tasks, input)
}

export function updateTaskflowTask(taskId: number, input: TaskflowTaskUpdate) {
  return taskflowApi.update(taskflowTables.tasks, taskId, input)
}

export function createTaskflowTaskActivity(input: TaskflowTaskActivityCreate) {
  return taskflowApi.create(taskflowTables.taskActivity, input)
}

export function createTaskflowTaskSession(input: TaskflowTaskSessionCreate) {
  return taskflowApi.create(taskflowTables.taskSessions, input)
}

export function updateTaskflowTaskSession(sessionId: number, input: TaskflowTaskSessionUpdate) {
  return taskflowApi.update(taskflowTables.taskSessions, sessionId, input)
}

/// What the client is allowed to say. sender_kind/sender_user/sender_label and
/// project are derived server-side from the authenticated identity and the
/// channel — the client cannot assert them.
export type SendMessageInput = {
  channel: number
  body_markdown: string
  priority?: TaskflowAgentMessage["priority"]
  client_nonce?: string
}

/// The send-message response: the saved message row plus the attachments the
/// backend stored for it. A text-only send returns `attachments: []`.
export type SendMessageResult = TaskflowAgentMessage & {
  attachments: TaskflowMessageAttachment[]
}

/// Send a chat message. With no files this posts JSON exactly as before; with
/// files it posts `multipart/form-data` (same field names plus each file as a
/// `files` part). We deliberately DON'T set Content-Type for the multipart path
/// — the browser must set it so it can include the boundary. Both paths return
/// `{ ...message, attachments }`.
export async function sendTaskflowAgentMessage(
  input: SendMessageInput,
  files?: File[]
): Promise<SendMessageResult> {
  const token = getStoredToken()
  const authHeader: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  const hasFiles = !!files && files.length > 0

  let body: BodyInit
  const headers: Record<string, string> = { ...authHeader }
  if (hasFiles) {
    const form = new FormData()
    form.append("channel", String(input.channel))
    form.append("body_markdown", input.body_markdown)
    if (input.priority) form.append("priority", input.priority)
    if (input.client_nonce) form.append("client_nonce", input.client_nonce)
    for (const file of files!) form.append("files", file, file.name)
    body = form
    // No content-type header: the browser sets multipart/form-data + boundary.
  } else {
    headers["content-type"] = "application/json"
    body = JSON.stringify(input)
  }

  const response = await fetch(`${API_BASE_URL}/api/taskflow/agents/messages`, {
    method: "POST",
    credentials: "include",
    headers,
    body,
  })
  if (!response.ok) {
    if (response.status === 400 || response.status === 413) {
      throw new Error(await readErrorDetail(response, `Could not send the message (${response.status}).`))
    }
    throw new Error(
      response.status === 403
        ? "You are not a member of this channel."
        : `Could not send the message (${response.status}).`
    )
  }
  return response.json()
}

/// What a human caller sends to link a coding agent to a project. `project` MUST
/// be the numeric project id; membership is checked server-side against the
/// authenticated caller. `profile` is the role key written into `.taskflow.json`
/// (e.g. "main" or "reviewer").
export type LinkAgentInput = {
  project: number
  display_name: string
  profile: string
  project_root?: string
  runtime?: string
  version?: string
}

/// The link response. `key` (a `tfk_…` string) is returned ONCE and is never
/// recoverable — surface it to the user immediately and don't persist it. The
/// nested `taskflow_profile` is the ready-to-paste profile entry.
export type LinkAgentResult = {
  agent_id: number
  identifier: string
  display_name: string
  project: number
  profile: string
  key: string
  taskflow_profile: {
    agent_id: number
    key: string
    display_name: string
  }
}

/// Link a coding agent to a project (agent identity Stage 1). Bearer-authed as
/// the human caller. Returns the freshly-minted credential whose raw `key` is
/// shown once. 403 means the caller isn't an active member of the project.
export async function linkAgent(input: LinkAgentInput): Promise<LinkAgentResult> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/agents/link`, {
    method: "POST",
    credentials: "include",
    headers: bearerHeaders(),
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "You must be a member of this project to link an agent."
        : await readErrorDetail(response, `Could not link the agent (${response.status}).`)
    )
  }
  return response.json()
}

export function createTaskflowAgentChannel(input: TaskflowAgentChannelCreate) {
  return taskflowApi.create(taskflowTables.agentChannels, input)
}

export function createTaskflowAgentChannelMember(input: TaskflowAgentChannelMemberCreate) {
  return taskflowApi.create(taskflowTables.agentChannelMembers, input)
}

/// Pull the first human-readable message out of a DRF-style field-error body
/// like `{"code":"not_a_project_member","user":["That user is not ..."]}`,
/// preferring the `user` field, then `detail`/`error`, then the fallback.
async function readFieldErrorMessage(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) return fallback
  try {
    const payload = (await response.json()) as Record<string, unknown>
    const userErrors = payload.user
    if (Array.isArray(userErrors) && typeof userErrors[0] === "string") return userErrors[0]
    if (typeof payload.detail === "string") return payload.detail
    if (typeof payload.error === "string") return payload.error
    return fallback
  } catch {
    return fallback
  }
}

/// Add an existing project member to an agent channel by user id. The backend
/// derives project + membership from the authenticated caller and the channel,
/// so the client only names the channel and the target user. Idempotent: a user
/// who is already on the channel returns 200 with the same row (201 for a new
/// membership). Distinct failures are surfaced with useful messages — 400
/// `not_a_project_member` (that user isn't an active project member), 403 (the
/// caller can't manage this channel / a DM they're not on), 404 (unknown
/// channel).
export async function addChannelMember(
  channelId: number,
  userId: number
): Promise<TaskflowAgentChannelMember> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/channels/${channelId}/members`, {
    method: "POST",
    credentials: "include",
    headers: bearerHeaders(),
    body: JSON.stringify({ user: userId }),
  })
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(await readFieldErrorMessage(response, "That user is not an active member of this project."))
    }
    throw new Error(
      response.status === 403
        ? "You can only add members to channels you belong to."
        : response.status === 404
          ? "That channel no longer exists."
          : `Could not add the member (${response.status}).`
    )
  }
  return response.json()
}

/// What a client may say when creating an invite. `project` comes from the URL,
/// and `status` / `invite_token` / `invited_by` / `expires_at` are all set
/// server-side — the client cannot assert them. (The `taskflow_project_invite`
/// auto-REST endpoint is read-only; this is the only mint path.)
export type CreateInviteInput = {
  email: string
  role: TaskflowProjectInvite["role"]
  display_name?: string | null
}

export async function createTaskflowProjectInvite(
  projectId: number,
  input: CreateInviteInput
): Promise<TaskflowProjectInvite> {
  const token = getStoredToken()
  const response = await fetch(`${API_BASE_URL}/api/taskflow/projects/${projectId}/invites`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "You must be an owner or admin of this project to invite members."
        : `Could not create the invite (${response.status}).`
    )
  }
  return response.json()
}

/// The caller's invite inbox row: the invite plus the resolved project name the
/// backend flattens onto it (see `my_invites`/`InviteInboxEntry` in views.rs).
export type InviteInboxEntry = TaskflowProjectInvite & {
  project_name: string | null
}

function bearerHeaders(): Record<string, string> {
  const token = getStoredToken()
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

async function readErrorDetail(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) return fallback
  try {
    const payload = (await response.json()) as { detail?: string; error?: string }
    return payload.detail ?? payload.error ?? fallback
  } catch {
    return fallback
  }
}

/// The caller's pending invites (addressed to their account email), each with
/// the project name resolved server-side.
export async function fetchMyInvites(): Promise<InviteInboxEntry[]> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/projects/invites/mine`, {
    method: "GET",
    credentials: "include",
    headers: bearerHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `Could not load your invitations (${response.status}).`))
  }
  return response.json()
}

/// A named error so the UI can react to the terminal invite states distinctly.
export class InviteActionError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "InviteActionError"
    this.status = status
  }
}

function inviteActionMessage(action: "accept" | "decline", status: number): string {
  switch (status) {
    case 403:
      return "This invitation is addressed to a different account."
    case 404:
      return "This invitation no longer exists."
    case 409:
      return action === "accept"
        ? "This invitation can no longer be accepted (it was already declined, revoked, or expired)."
        : "This invitation can no longer be declined (it was already accepted, revoked, or expired)."
    case 410:
      return "This invitation has expired."
    default:
      return action === "accept"
        ? `Could not accept the invitation (${status}).`
        : `Could not decline the invitation (${status}).`
  }
}

/// Accept an invite by token. On success the backend creates/activates the
/// caller's membership and returns it. Distinct statuses (403/404/409/410) are
/// surfaced via InviteActionError so the inbox can explain what happened.
export async function acceptInvite(token: string): Promise<TaskflowProjectMember> {
  const response = await fetch(
    `${API_BASE_URL}/api/taskflow/projects/invites/${encodeURIComponent(token)}/accept`,
    { method: "POST", credentials: "include", headers: bearerHeaders() }
  )
  if (!response.ok) {
    throw new InviteActionError(inviteActionMessage("accept", response.status), response.status)
  }
  return response.json()
}

/// Decline an invite by token. Returns the updated invite row.
export async function declineInvite(token: string): Promise<TaskflowProjectInvite> {
  const response = await fetch(
    `${API_BASE_URL}/api/taskflow/projects/invites/${encodeURIComponent(token)}/decline`,
    { method: "POST", credentials: "include", headers: bearerHeaders() }
  )
  if (!response.ok) {
    throw new InviteActionError(inviteActionMessage("decline", response.status), response.status)
  }
  return response.json()
}

/// The caller's own settings row, created with defaults on first read. Keyed on
/// the authenticated identity server-side — no user id is sent.
export async function fetchUserSettings(): Promise<TaskflowUserSettings> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/user/settings`, {
    method: "GET",
    credentials: "include",
    headers: bearerHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `Could not load your settings (${response.status}).`))
  }
  return response.json()
}

/// What the client may change on its own settings. `default_project: null`
/// clears it; omit a field to leave it untouched.
export type UpdateUserSettingsInput = {
  theme?: TaskflowUserSettingsTheme
  email_notifications?: boolean
  default_project?: number | null
}

export async function updateUserSettings(input: UpdateUserSettingsInput): Promise<TaskflowUserSettings> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/user/settings`, {
    method: "POST",
    credentials: "include",
    headers: bearerHeaders(),
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `Could not save your settings (${response.status}).`))
  }
  return response.json()
}

/// A named error carrying parsed DRF-style field errors so the create-project
/// dialog can show them inline. `fieldErrors` maps a field name (e.g. "slug")
/// to its messages; `message` is the human-facing form-level summary.
export class ProjectFormError extends Error {
  readonly status: number
  readonly fieldErrors: Record<string, string[]>

  constructor(message: string, status: number, fieldErrors: Record<string, string[]> = {}) {
    super(message)
    this.name = "ProjectFormError"
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

/// Parse a non-2xx project response into a form-level message + per-field
/// errors. Field errors are `{field: ["msg", ...]}` entries (the shape the
/// backend returns for e.g. a duplicate slug: `{"code":"unique_constraint",
/// "slug":["A project with this slug already exists."]}`). `code`/`detail`/
/// `error`/`message` are treated as metadata, and `non_field_errors` becomes
/// the form-level message rather than a field error.
async function parseProjectFormError(
  response: Response
): Promise<{ message: string; fieldErrors: Record<string, string[]> }> {
  const fallback =
    response.status === 409
      ? "A project with that slug already exists."
      : `Could not create the project (${response.status}).`

  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) return { message: fallback, fieldErrors: {} }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { message: fallback, fieldErrors: {} }
  }
  if (!payload || typeof payload !== "object") return { message: fallback, fieldErrors: {} }

  const body = payload as Record<string, unknown>
  const metadataKeys = new Set(["code", "detail", "error", "message"])
  const fieldErrors: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(body)) {
    if (metadataKeys.has(key) || key === "non_field_errors") continue
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      fieldErrors[key] = value as string[]
    }
  }

  const nonField = Array.isArray(body.non_field_errors)
    ? (body.non_field_errors.find((item) => typeof item === "string") as string | undefined)
    : undefined
  const detail =
    typeof body.detail === "string"
      ? body.detail
      : typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : undefined
  const firstFieldMessage = Object.values(fieldErrors)[0]?.[0]

  return { message: detail ?? nonField ?? firstFieldMessage ?? fallback, fieldErrors }
}

/// What a client may say when creating a project — a strict mirror of the
/// backend's `CreateProjectInput`, NOT the generated row-create type.
///
/// `TaskflowProjectCreate` is generated from the table and also offers `status`,
/// `owner` and `updated_at`, none of which this hand-written route reads:
/// `owner` is the authenticated caller and `status` starts at the model default.
/// Serde drops unknown fields silently, so passing them looked like it worked and
/// simply did nothing. Typing the input to what the server actually honours turns
/// that into a compile error instead of a shrug.
export type CreateProjectInput = {
  name: string
  slug?: string
  description_markdown?: string
  repository_url?: string | null
  default_api_base_url?: string | null
}

/// Create a project via the bearer-authed REST route. The backend also makes
/// the caller an active OWNER member, so the new project is immediately visible
/// in the scoped list. On failure a ProjectFormError carries parsed field
/// errors (e.g. a duplicate slug → 409) for inline display in the dialog.
export async function createTaskflowProject(input: CreateProjectInput): Promise<TaskflowProject> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/projects`, {
    method: "POST",
    credentials: "include",
    headers: bearerHeaders(),
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const { message, fieldErrors } = await parseProjectFormError(response)
    throw new ProjectFormError(message, response.status, fieldErrors)
  }
  return response.json()
}

export function updateTaskflowProject(projectId: number, input: TaskflowProjectUpdate) {
  return taskflowApi.update(taskflowTables.projects, projectId, input)
}

export function archiveTaskflowProject(projectId: number) {
  return updateTaskflowProject(projectId, { status: "archived" })
}

export function subscribeToTaskflowProjects(onChange: () => void) {
  return taskflowApi.on(taskflowTables.projects, onAnyModelChange(onChange), {
    group: taskflowGroups.projects,
  })
}

export function subscribeToTaskflowProjectEvents(onEvent: (event: TaskflowRealtimeEvent) => void) {
  return taskflowApi.on(taskflowTables.projects, onRealtimeModelChange(taskflowTables.projects, onEvent), {
    group: taskflowGroups.projects,
  })
}

export function subscribeToTaskflowWorkspace(projectId: number, onChange: () => void) {
  const subscriptions = projectScopedRealtimeTables.map((table) =>
    taskflowApi.on(table as TableName, onAnyModelChange(onChange), {
      group: taskflowGroups.forTable(table, projectId),
    })
  )

  return () => closeAll(subscriptions)
}

export function subscribeToTaskflowWorkspaceEvents(projectId: number, onEvent: (event: TaskflowRealtimeEvent) => void) {
  const subscriptions = projectScopedRealtimeTables.map((table) =>
    taskflowApi.on(table as TableName, onRealtimeModelChange(table, onEvent), {
      group: taskflowGroups.forTable(table, projectId),
    })
  )

  return () => closeAll(subscriptions)
}

/// Cheap liveness probe against the unauthenticated agents health route. Used by
/// the realtime reconnect watchdog to notice when the backend has come back
/// after being unreachable (e.g. a dev restart), since the realtime EventSource
/// itself doesn't surface that. Resolves true iff the server answered 2xx.
export async function pingTaskflowBackend(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/taskflow/agents/health`, {
      cache: "no-store",
      signal,
    })
    return response.ok
  } catch {
    return false
  }
}
