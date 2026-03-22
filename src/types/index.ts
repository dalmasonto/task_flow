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

export interface SettingsMap {
  timerBarDisplayMode: 'carousel' | 'expanded'
  notificationInterval: number
  statusColors: Record<TaskStatus, string>
  glowIntensity: number
  backdropBlur: number
  shadowSpread: number
  operatorName: string
  systemName: string
}

export interface Setting {
  id?: number
  key: keyof SettingsMap
  value: SettingsMap[keyof SettingsMap]
}

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  not_started: ['in_progress', 'blocked'],
  in_progress: ['paused', 'blocked', 'partial_done', 'done'],
  paused: ['in_progress', 'blocked', 'partial_done', 'done'],
  blocked: ['not_started', 'in_progress'],
  partial_done: ['in_progress', 'done'],
  done: ['in_progress'],
}
