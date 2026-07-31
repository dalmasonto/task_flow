import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import { computeSessionDuration } from '@/lib/time'
import type { DateRange } from 'react-day-picker'

export interface DailyDataPoint {
  date: string
  label: string
  value: number
}

export function useDailyProductivity(
  mode: 'time' | 'tasks',
  projectFilter: string,
  dateRange: DateRange | undefined
): DailyDataPoint[] | undefined {
  return useLiveQuery(async () => {
    const from = dateRange?.from
    const to = dateRange?.to

    const dayMap = new Map<string, number>()

    if (mode === 'time') {
      let sessions = await db.sessions.toArray()
      const allTasks = await db.tasks.toArray()
      const taskMap = new Map(allTasks.map(t => [t.id!, t]))

      // Filter by project
      if (projectFilter !== 'all') {
        const pid = Number(projectFilter)
        sessions = sessions.filter(s => {
          const task = taskMap.get(s.taskId)
          return task?.projectId === pid
        })
      }

      // Filter by date range
      if (from) {
        sessions = sessions.filter(s => s.start >= from)
      }
      if (to) {
        const endOfDay = new Date(to)
        endOfDay.setHours(23, 59, 59, 999)
        sessions = sessions.filter(s => s.start <= endOfDay)
      }

      // Group by day, sum duration in hours
      for (const s of sessions) {
        const day = s.start.toISOString().slice(0, 10)
        const current = dayMap.get(day) ?? 0
        dayMap.set(day, current + computeSessionDuration(s))
      }
    } else {
      // Tasks done mode
      let tasks = await db.tasks.toArray()
      tasks = tasks.filter(t => t.status === 'done')

      // Filter by project
      if (projectFilter !== 'all') {
        const pid = Number(projectFilter)
        tasks = tasks.filter(t => t.projectId === pid)
      }

      // Filter by date range using updatedAt (when task was marked done)
      if (from) {
        tasks = tasks.filter(t => t.updatedAt >= from)
      }
      if (to) {
        const endOfDay = new Date(to)
        endOfDay.setHours(23, 59, 59, 999)
        tasks = tasks.filter(t => t.updatedAt <= endOfDay)
      }

      // Group by day, count per day
      for (const t of tasks) {
        const day = t.updatedAt.toISOString().slice(0, 10)
        const current = dayMap.get(day) ?? 0
        dayMap.set(day, current + 1)
      }
    }

    // Build data points, filling missing days
    const days: DailyDataPoint[] = []

    if (from && to) {
      const cursor = new Date(from)
      const end = new Date(to)
      while (cursor <= end) {
        const key = cursor.toISOString().slice(0, 10)
        const raw = dayMap.get(key) ?? 0
        days.push({
          date: key,
          label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          value: mode === 'time'
            ? Math.round((raw / 3_600_000) * 100) / 100
            : raw,
        })
        cursor.setDate(cursor.getDate() + 1)
      }
    } else {
      // No range — show all data sorted
      Array.from(dayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([date, raw]) => {
          days.push({
            date,
            label: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            value: mode === 'time'
              ? Math.round((raw / 3_600_000) * 100) / 100
              : raw,
          })
        })
    }

    return days
  }, [mode, projectFilter, dateRange?.from?.getTime(), dateRange?.to?.getTime()])
}
