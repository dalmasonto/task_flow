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
  browserNotificationsEnabled: true,
  statusColors: DEFAULT_STATUS_COLORS,
  glowIntensity: 84,
  backdropBlur: 24,
  shadowSpread: 12,
  operatorName: 'Operator-01',
  systemName: 'TASKFLOW_OS',
  terminalHistory: [] as string[],
  serverPort: 3456,
  fontFamily: 'inter' as const,
  recentProjectIds: [] as number[],
  depGraphSidebarWidth: 400,
}

export const FONT_OPTIONS = [
  { value: 'inter', label: 'Inter', css: "'Inter Variable', sans-serif" },
  { value: 'geist', label: 'Geist', css: "'Geist Variable', sans-serif" },
  { value: 'space-grotesk', label: 'Space Grotesk', css: "'Space Grotesk Variable', sans-serif" },
] as const
