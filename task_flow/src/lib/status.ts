import type { Task, TaskStatus } from '@/types'
import { VALID_TRANSITIONS } from '@/types'
import { DEFAULT_STATUS_COLORS } from './constants'

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

export function getStatusLabel(status: TaskStatus): string {
  return status
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Get the display label for a task's status, considering whether
 * a "blocked" task's blockers are all done (→ "Unblocked").
 */
export function getDisplayStatus(task: Task, allTasks: Task[]): { label: string; status: TaskStatus } {
  if (task.status === 'blocked' && task.dependencies.length > 0) {
    const taskMap = new Map(allTasks.map(t => [t.id!, t]))
    const hasActiveBlockers = task.dependencies.some(depId => {
      const dep = taskMap.get(depId)
      return dep && dep.status !== 'done'
    })
    if (!hasActiveBlockers) {
      return { label: 'Unblocked', status: 'blocked' }
    }
  }
  return { label: getStatusLabel(task.status), status: task.status }
}

export function getStatusColor(status: TaskStatus, customColors?: Record<TaskStatus, string>): string {
  return (customColors ?? DEFAULT_STATUS_COLORS)[status]
}
