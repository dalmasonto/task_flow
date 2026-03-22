import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import { computeTotalTime } from '@/lib/time'

export function useSessions(taskId?: number) {
  return useLiveQuery(() => {
    if (taskId !== undefined) {
      return db.sessions.where('taskId').equals(taskId).toArray()
    }
    return db.sessions.toArray()
  }, [taskId])
}

export function useActiveSessions() {
  return useLiveQuery(() =>
    db.sessions.filter(s => s.end === undefined).toArray()
  )
}

/**
 * Computes total time for a task. Pass `tick` from `useTimer()` to
 * force recalculation every second for active sessions.
 */
export function useTaskTotalTime(taskId: number | undefined, tick?: number) {
  const sessions = useSessions(taskId)
  if (!sessions) return 0
  // tick is used as a dependency signal — computeTotalTime reads Date.now() for active sessions
  void tick
  return computeTotalTime(sessions)
}
