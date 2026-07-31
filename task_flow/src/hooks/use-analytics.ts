import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import { computeTotalTime } from '@/lib/time'

interface AnalyticsData {
  totalFocusedTime: number
  tasksCompleted: number
  tasksInProgress: number
  totalTasks: number
  timePerProject: Array<{ projectId: number; projectName: string; color: string; totalTime: number }>
  statusDistribution: Record<string, number>
}

export function useAnalytics(dateRange?: { start: Date; end: Date }): AnalyticsData | undefined {
  return useLiveQuery(async () => {
    const allTasks = await db.tasks.toArray()
    let sessions = await db.sessions.toArray()

    if (dateRange) {
      sessions = sessions.filter(s =>
        s.start >= dateRange.start && s.start <= dateRange.end
      )
    }

    const projects = await db.projects.toArray()
    const projectMap = new Map(projects.map(p => [p.id!, p]))

    const statusDistribution: Record<string, number> = {}
    for (const task of allTasks) {
      statusDistribution[task.status] = (statusDistribution[task.status] ?? 0) + 1
    }

    const projectTimeMap = new Map<number, number>()
    for (const session of sessions) {
      const task = allTasks.find(t => t.id === session.taskId)
      if (task?.projectId) {
        const current = projectTimeMap.get(task.projectId) ?? 0
        projectTimeMap.set(task.projectId, current + computeTotalTime([session]))
      }
    }

    const timePerProject = Array.from(projectTimeMap.entries()).map(([projectId, totalTime]) => {
      const project = projectMap.get(projectId)
      return {
        projectId,
        projectName: project?.name ?? 'Unassigned',
        color: project?.color ?? '#484847',
        totalTime,
      }
    })

    return {
      totalFocusedTime: computeTotalTime(sessions),
      tasksCompleted: allTasks.filter(t => t.status === 'done').length,
      tasksInProgress: allTasks.filter(t => t.status === 'in_progress').length,
      totalTasks: allTasks.length,
      timePerProject,
      statusDistribution,
    }
  }, [dateRange?.start?.getTime(), dateRange?.end?.getTime()])
}
