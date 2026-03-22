import type { TaskStatus } from '@/types'
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

export function getStatusColor(status: TaskStatus, customColors?: Record<TaskStatus, string>): string {
  return (customColors ?? DEFAULT_STATUS_COLORS)[status]
}
