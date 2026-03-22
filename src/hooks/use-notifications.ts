import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { db } from '@/db/database'
import { playNotification } from '@/lib/sounds'
import { useActiveSessions } from './use-sessions'
import { useSetting } from './use-settings'

export function useNotifications() {
  const activeSessions = useActiveSessions()
  const interval = useSetting('notificationInterval')
  const permissionAsked = useRef(false)

  // Request permission when there are active sessions
  useEffect(() => {
    if (!activeSessions?.length || permissionAsked.current) return
    if (typeof Notification === 'undefined') return

    if (Notification.permission === 'default') {
      permissionAsked.current = true
      // Directly trigger the browser permission dialog
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          toast.success('Notifications enabled — you\'ll get reminders while tasks are active')
        } else if (perm === 'denied') {
          toast.info('Notifications blocked — you can enable them in browser settings')
        }
      })
    } else if (Notification.permission === 'denied') {
      // Only show this once per session
      if (!permissionAsked.current) {
        permissionAsked.current = true
        toast.info('Browser notifications are blocked. Enable them in your browser settings to get task reminders.', {
          duration: 8000,
        })
      }
    }
  }, [activeSessions?.length])

  // Fire notifications on interval
  useEffect(() => {
    if (!activeSessions?.length) return
    if (typeof Notification === 'undefined') return

    const timer = setInterval(async () => {
      if (Notification.permission !== 'granted') return
      for (const session of activeSessions) {
        const task = await db.tasks.get(session.taskId)
        if (!task) continue
        const project = task.projectId
          ? await db.projects.get(task.projectId)
          : undefined
        playNotification()
        new Notification('TaskFlow', {
          body: `You are working on: ${task.title}${project ? ` (${project.name})` : ''}`,
          icon: '/favicon.ico',
        })
      }
    }, interval * 60 * 1000)

    return () => clearInterval(timer)
  }, [activeSessions?.length, interval])
}
