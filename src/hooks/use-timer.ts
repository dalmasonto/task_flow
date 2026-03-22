import { useState, useEffect, useCallback } from 'react'
import { db } from '@/db/database'
import { canTransition } from '@/lib/status'
import { syncTaskUpdate, syncSessionCreate, syncSessionUpdate } from '@/lib/sync-api'
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

    const now = new Date()
    await db.transaction('rw', [db.tasks, db.sessions], async () => {
      await db.tasks.update(task.id!, {
        status: 'in_progress',
        updatedAt: now,
      })
      await db.sessions.add({
        taskId: task.id!,
        start: now,
      })
    })
    syncTaskUpdate(task.id!, { status: 'in_progress' })
    syncSessionCreate({ taskId: task.id!, start: now })
  }, [])

  const pauseTask = useCallback(async (task: Task) => {
    const now = new Date()
    let sessionId: number | undefined
    await db.transaction('rw', [db.tasks, db.sessions], async () => {
      const activeSession = await db.sessions
        .where('taskId')
        .equals(task.id!)
        .filter(s => s.end === undefined)
        .first()

      if (activeSession) {
        sessionId = activeSession.id
        await db.sessions.update(activeSession.id!, { end: now })
      }

      await db.tasks.update(task.id!, {
        status: 'paused',
        updatedAt: now,
      })
    })
    syncTaskUpdate(task.id!, { status: 'paused' })
    if (sessionId) syncSessionUpdate(sessionId, { end: now })
  }, [])

  const stopTask = useCallback(async (task: Task, finalStatus: 'done' | 'partial_done' = 'done') => {
    const now = new Date()
    let sessionId: number | undefined
    await db.transaction('rw', [db.tasks, db.sessions], async () => {
      const activeSession = await db.sessions
        .where('taskId')
        .equals(task.id!)
        .filter(s => s.end === undefined)
        .first()

      if (activeSession) {
        sessionId = activeSession.id
        await db.sessions.update(activeSession.id!, { end: now })
      }

      await db.tasks.update(task.id!, {
        status: finalStatus,
        updatedAt: now,
      })
    })
    syncTaskUpdate(task.id!, { status: finalStatus })
    if (sessionId) syncSessionUpdate(sessionId, { end: now })
  }, [])

  return { tick, startTask, pauseTask, stopTask }
}
