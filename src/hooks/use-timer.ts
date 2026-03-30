import { useState, useEffect, useCallback } from 'react'
import { db } from '@/db/database'
import { canTransition } from '@/lib/status'
import { syncTaskUpdate } from '@/lib/sync-api'
import { handleSessionsForStatusChange } from '@/lib/session-lifecycle'
import type { Task } from '@/types'

export function useTimer(hasActiveSessions: boolean = true) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!hasActiveSessions) return
    const interval = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [hasActiveSessions])

  const startTask = useCallback(async (task: Task) => {
    if (task.status !== 'in_progress' && !canTransition(task.status, 'in_progress')) {
      throw new Error(`Cannot start task from status: ${task.status}`)
    }

    await handleSessionsForStatusChange(task.id!, 'in_progress')
    await db.tasks.update(task.id!, {
      status: 'in_progress',
      updatedAt: new Date(),
    })
    syncTaskUpdate(task.id!, { status: 'in_progress' })
  }, [])

  const pauseTask = useCallback(async (task: Task) => {
    await handleSessionsForStatusChange(task.id!, 'paused')
    await db.tasks.update(task.id!, {
      status: 'paused',
      updatedAt: new Date(),
    })
    syncTaskUpdate(task.id!, { status: 'paused' })
  }, [])

  const stopTask = useCallback(async (task: Task, finalStatus: 'done' | 'partial_done' = 'done') => {
    await handleSessionsForStatusChange(task.id!, finalStatus)
    await db.tasks.update(task.id!, {
      status: finalStatus,
      updatedAt: new Date(),
    })
    syncTaskUpdate(task.id!, { status: finalStatus })
  }, [])

  return { tick, startTask, pauseTask, stopTask }
}
