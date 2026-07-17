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
  TaskflowProject,
  TaskflowProjectApiEndpoint,
  TaskflowProjectCreate,
  TaskflowProjectInvite,
  TaskflowProjectInviteCreate,
  TaskflowProjectMember,
  TaskflowProjectUpdate,
  TaskflowTask,
  TaskflowTaskActivity,
  TaskflowTaskActivityCreate,
  TaskflowTaskCreate,
  TaskflowTaskRelation,
  TaskflowTaskSession,
  TaskflowTaskSessionCreate,
  TaskflowTaskSessionUpdate,
  TaskflowTaskUpdate,
  UmbralResources,
} from "@/api/client"
import { API_BASE_URL, getStoredToken } from "@/lib/auth-api"

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
  terminalFrames: "taskflow_agent_terminal_frame",
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
  [taskflowTables.terminalFrames]: "terminal_frames",
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
  agentMessages: TaskflowAgentMessage[]
  terminalFrames: TaskflowAgentTerminalFrame[]
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
  | typeof taskflowTables.terminalFrames

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
  taskflowTables.terminalFrames,
] satisfies RealtimeTableName[]

/// Chat tables project their fields (backend/src/realtime.rs), so their events
/// carry the whole row and need no refetch. Everything else is id-only.
export const realtimeTablesWithInlineRows = [
  taskflowTables.agentMessages,
  taskflowTables.agentChannels,
  taskflowTables.agentChannelMembers,
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
    terminalFrames,
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
    taskflowApi.from(taskflowTables.agentMessages).filter({ project: projectId }).orderBy("-created_at", "-id").list(),
    taskflowApi.from(taskflowTables.terminalFrames).filter({ project: projectId }).orderBy("agent", "sequence", "id").list(),
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
    terminalFrames: terminalFrames.results,
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

export async function sendTaskflowAgentMessage(input: SendMessageInput): Promise<TaskflowAgentMessage> {
  const token = getStoredToken()
  const response = await fetch(`${API_BASE_URL}/api/taskflow/agents/messages`, {
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
        ? "You are not a member of this channel."
        : `Could not send the message (${response.status}).`
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

export function createTaskflowProjectInvite(input: TaskflowProjectInviteCreate) {
  return taskflowApi.create(taskflowTables.invites, input)
}

export function createTaskflowProject(input: TaskflowProjectCreate) {
  return taskflowApi.create(taskflowTables.projects, input)
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
