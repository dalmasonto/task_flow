import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import type { NotificationType } from '@/types'

export function useAppNotifications(limit: number = 50) {
  return useLiveQuery(
    () => db.notifications.orderBy('createdAt').reverse().limit(limit).toArray()
  )
}

export function useUnreadCount() {
  return useLiveQuery(
    () => db.notifications.where('read').equals(0).count()
  )
}

export async function addNotification(
  title: string,
  message: string,
  type: NotificationType = 'info'
) {
  await db.notifications.add({
    title,
    message,
    type,
    read: false,
    createdAt: new Date(),
  })
}

export async function markAsRead(id: number) {
  await db.notifications.update(id, { read: true })
}

export async function markAllAsRead() {
  await db.notifications.where('read').equals(0).modify({ read: true })
}

export async function clearAllNotifications() {
  await db.notifications.clear()
}
