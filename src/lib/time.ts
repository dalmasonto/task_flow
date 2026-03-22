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
