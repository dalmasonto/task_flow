import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import type { ActivityAction } from '@/types'

/**
 * Log an activity event. Call this from any action in the app.
 */
export async function logActivity(
  action: ActivityAction,
  title: string,
  options?: {
    detail?: string
    entityType?: 'task' | 'project' | 'session' | 'system'
    entityId?: number
  }
) {
  await db.activityLogs.add({
    action,
    title,
    detail: options?.detail,
    entityType: options?.entityType,
    entityId: options?.entityId,
    createdAt: new Date(),
  })
}

/**
 * Read activity logs, most recent first.
 */
export function useActivityLog(limit: number = 100) {
  return useLiveQuery(
    () => db.activityLogs.orderBy('createdAt').reverse().limit(limit).toArray()
  )
}

/**
 * Clear all activity logs.
 */
export async function clearActivityLog() {
  await db.activityLogs.clear()
}
