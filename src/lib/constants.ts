import type { TaskStatus } from '@/types'

export const DEFAULT_STATUS_COLORS: Record<TaskStatus, string> = {
  not_started: '#484847',
  in_progress: '#00fbfb',
  paused: '#de8eff',
  blocked: '#ff6e84',
  partial_done: '#b90afc',
  done: '#69fd5d',
}

export const DEFAULT_NOTIFICATION_INTERVAL = 30

export const DEFAULT_SETTINGS = {
  timerBarDisplayMode: 'carousel' as const,
  notificationInterval: DEFAULT_NOTIFICATION_INTERVAL,
  statusColors: DEFAULT_STATUS_COLORS,
  glowIntensity: 84,
  backdropBlur: 24,
  shadowSpread: 12,
}
