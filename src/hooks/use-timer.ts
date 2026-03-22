import { useState, useEffect, useCallback } from 'react'
import { db } from '@/db/database'
import { canTransition } from '@/lib/status'
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

    await db.transaction('rw', [db.tasks, db.sessions], async () => {
      await db.tasks.update(task.id!, {
        status: 'in_progress',
        updatedAt: new Date(),
      })
      await db.sessions.add({
        taskId: task.id!,
        start: new Date(),
      })
    })
  }, [])

  const pauseTask = useCallback(async (task: Task) => {
    await db.transaction('rw', [db.tasks, db.sessions], async () => {
      const activeSession = await db.sessions
        .where('taskId')
        .equals(task.id!)
        .filter(s => s.end === undefined)
        .first()

      if (activeSession) {
        await db.sessions.update(activeSession.id!, { end: new Date() })
      }

      await db.tasks.update(task.id!, {
        status: 'paused',
        updatedAt: new Date(),
      })
    })
  }, [])

  const stopTask = useCallback(async (task: Task, finalStatus: 'done' | 'partial_done' = 'done') => {
    await db.transaction('rw', [db.tasks, db.sessions], async () => {
      const activeSession = await db.sessions
        .where('taskId')
        .equals(task.id!)
        .filter(s => s.end === undefined)
        .first()

      if (activeSession) {
        await db.sessions.update(activeSession.id!, { end: new Date() })
      }

      await db.tasks.update(task.id!, {
        status: finalStatus,
        updatedAt: new Date(),
      })
    })
  }, [])

  return { tick, startTask, pauseTask, stopTask }
}
