export type TaskStatus =
  | 'not_started'
  | 'in_progress'
  | 'paused'
  | 'blocked'
  | 'partial_done'
  | 'done'

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'

export interface Task {
  id?: number
  title: string
  description?: string
  status: TaskStatus
  priority: TaskPriority
  projectId?: number
  dependencies: number[]
  links?: Array<{ label: string; url: string }>
  tags?: string[]
  dueDate?: Date
  estimatedTime?: number
  createdAt: Date
  updatedAt: Date
}

export type ProjectType = 'active_project' | 'project_idea'

export interface Project {
  id?: number
  name: string
  color: string
  type: ProjectType
  description?: string
  createdAt: Date
}

export interface Session {
  id?: number
  taskId: number
  start: Date
  end?: Date
}

export type NotificationType = 'info' | 'success' | 'warning' | 'error'

export interface AppNotification {
  id?: number
  title: string
  message: string
  type: NotificationType
  read: boolean
  createdAt: Date
}

export type ActivityAction =
  | 'task_created'
  | 'task_deleted'
  | 'task_status_changed'
  | 'task_completed'
  | 'task_partial_done'
  | 'timer_started'
  | 'timer_paused'
  | 'timer_stopped'
  | 'project_created'
  | 'project_deleted'
  | 'project_updated'
  | 'tasks_bulk_created'
  | 'settings_saved'
  | 'data_seeded'
  | 'data_cleared'
  | 'task_linked'
  | 'task_unlinked'
  | 'dependency_added'
  | 'dependency_removed'
  | 'link_added'
  | 'tag_added'
  | 'tag_removed'
  | 'debug_log'

export interface ActivityLog {
  id?: number
  action: ActivityAction
  title: string
  detail?: string
  entityType?: 'task' | 'project' | 'session' | 'system'
  entityId?: number
  createdAt: Date
}

export type FontFamily = 'inter' | 'geist' | 'space-grotesk'

export interface SettingsMap {
  timerBarDisplayMode: 'carousel' | 'expanded'
  notificationInterval: number
  browserNotificationsEnabled: boolean
  statusColors: Record<TaskStatus, string>
  glowIntensity: number
  backdropBlur: number
  shadowSpread: number
  operatorName: string
  systemName: string
  terminalHistory: string[]
  serverPort: number
  fontFamily: FontFamily
  recentProjectIds: number[]
  depGraphSidebarWidth: number
  depGraphActiveFilters: string[]
  terminalWidth: number
  connectionMode: 'local' | 'remote'
  relayUrl: string
  relayAccessToken: string
}

export interface Setting {
  id?: number
  key: keyof SettingsMap
  value: SettingsMap[keyof SettingsMap]
}

export type AgentMessageStatus = 'pending' | 'answered' | 'dismissed'

export type AgentMessageSource = 'mcp' | 'terminal' | 'ui'

export interface AgentMessage {
  id?: number
  projectId?: number
  broadcastId?: string
  senderName: string
  recipientName: string
  question: string
  context?: string
  choices?: string[]
  response?: string
  status: AgentMessageStatus
  source?: AgentMessageSource
  createdAt: Date
  answeredAt?: Date
}

export type AgentConnectionStatus = 'connected' | 'disconnected'

export interface AgentRegistryEntry {
  id?: number
  name: string
  projectPath: string
  pid: number
  tmuxPane?: string
  status: AgentConnectionStatus
  awaitingInput?: boolean
  connectedAt: Date
  disconnectedAt?: Date
}

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  not_started: ['in_progress', 'blocked'],
  in_progress: ['paused', 'blocked', 'partial_done', 'done'],
  paused: ['in_progress', 'blocked', 'partial_done', 'done'],
  blocked: ['not_started', 'in_progress'],
  partial_done: ['in_progress', 'done'],
  done: ['in_progress'],
}
