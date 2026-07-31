import type { Session } from '@/types'

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${hours >= 100 ? hours : pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function computeSessionDuration(session: Session): number {
  const end = session.end ?? new Date()
  return end.getTime() - session.start.getTime()
}

export function computeTotalTime(sessions: Session[]): number {
  return sessions.reduce((sum, s) => sum + computeSessionDuration(s), 0)
}

/**
 * Format milliseconds as human-readable duration: "6D 2Hrs 10Mins", "15Mins", "2Hrs", etc.
 */
export function formatHumanDuration(ms: number): string {
  if (ms <= 0) return '0Mins'

  const totalMinutes = Math.floor(ms / 60000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60

  const parts: string[] = []
  if (days > 0) parts.push(`${days}D`)
  if (hours > 0) parts.push(`${hours}Hrs`)
  if (minutes > 0) parts.push(`${minutes}Mins`)

  return parts.length > 0 ? parts.join(' ') : '<1Min'
}

/**
 * Smart duration format:
 * - Under 1 second: "—" (no meaningful time)
 * - Under 1 hour: "12m 30s"
 * - 1 hour+: "1h 25m"
 * - 24 hours+: "2d 3h"
 */
export function formatSmartDuration(ms: number): string {
  if (ms < 1000) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${seconds}s`
}

/**
 * Parse minutes input to milliseconds
 */
export function minutesToMs(minutes: number): number {
  return minutes * 60000
}

/**
 * Convert milliseconds to minutes
 */
export function msToMinutes(ms: number): number {
  return Math.round(ms / 60000)
}
