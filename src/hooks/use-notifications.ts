import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { db } from '@/db/database'
import { playNotification } from '@/lib/sounds'
import { addNotification } from './use-app-notifications'
import { useActiveSessions } from './use-sessions'
import { useSetting } from './use-settings'

export function useNotifications() {
  const activeSessions = useActiveSessions()
  const interval = useSetting('notificationInterval')
  const browserEnabled = useSetting('browserNotificationsEnabled')
  const permissionAsked = useRef(false)

  // Request browser permission when enabled and there are active sessions
  useEffect(() => {
    if (!browserEnabled || !activeSessions?.length || permissionAsked.current) return
    if (typeof Notification === 'undefined') return

    if (Notification.permission === 'default') {
      permissionAsked.current = true
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          toast.success('Browser notifications enabled')
        } else if (perm === 'denied') {
          toast.info('Browser notifications blocked — you can enable them in browser settings')
        }
      })
    }
  }, [activeSessions?.length, browserEnabled])

  // Fire reminders on interval — always internal, optionally browser
  useEffect(() => {
    if (!activeSessions?.length) return

    const fire = async () => {
      for (const session of activeSessions) {
        const task = await db.tasks.get(session.taskId)
        if (!task) continue
        const project = task.projectId
          ? await db.projects.get(task.projectId)
          : undefined
        const message = `You are working on: ${task.title}${project ? ` (${project.name})` : ''}`

        // Always add to internal bell
        addNotification('Task Reminder', message, 'info')
        playNotification()

        // Browser notification only if enabled and granted
        if (browserEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('TaskFlow', {
            body: message,
            icon: '/favicon.ico',
          })
        }
      }
    }

    const timer = setInterval(fire, interval * 60 * 1000)
    return () => clearInterval(timer)
  }, [activeSessions?.length, interval, browserEnabled])
}
