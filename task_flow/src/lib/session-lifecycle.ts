import { db } from '@/db/database'
import { syncSessionCreate, syncSessionUpdate } from '@/lib/sync-api'
import type { TaskStatus } from '@/types'

/**
 * Handles session lifecycle when a task's status changes.
 *
 * Rules:
 * - Moving to `in_progress`: close any open sessions, start a new one
 * - Moving to anything else: close any open sessions
 *
 * Must be called BEFORE updating the task status in the DB.
 */
export async function handleSessionsForStatusChange(
  taskId: number,
  newStatus: TaskStatus,
): Promise<void> {
  const now = new Date()

  // Close all open sessions for this task
  const openSessions = await db.sessions
    .where('taskId')
    .equals(taskId)
    .filter(s => s.end === undefined)
    .toArray()

  for (const session of openSessions) {
    await db.sessions.update(session.id!, { end: now })
    syncSessionUpdate(session.id!, { end: now })
  }

  // Start a new session if moving to in_progress
  if (newStatus === 'in_progress') {
    await db.sessions.add({ taskId, start: now })
    syncSessionCreate({ taskId, start: now })
  }
}
