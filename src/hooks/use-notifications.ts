import { useEffect } from 'react'
import { db } from '@/db/database'
import { useActiveSessions } from './use-sessions'
import { useSetting } from './use-settings'

export function useNotifications() {
  const activeSessions = useActiveSessions()
  const interval = useSetting('notificationInterval')

  useEffect(() => {
    if (!activeSessions?.length) return
    if (Notification.permission === 'default') {
      Notification.requestPermission()
    }

    const timer = setInterval(async () => {
      if (Notification.permission !== 'granted') return
      for (const session of activeSessions) {
        const task = await db.tasks.get(session.taskId)
        if (!task) continue
        const project = task.projectId
          ? await db.projects.get(task.projectId)
          : undefined
        new Notification('TaskFlow', {
          body: `You are working on: ${task.title}${project ? ` (${project.name})` : ''}`,
          icon: '/favicon.ico',
        })
      }
    }, interval * 60 * 1000)

    return () => clearInterval(timer)
  }, [activeSessions?.length, interval])
}
