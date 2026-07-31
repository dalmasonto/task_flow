import { useState, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useTasks } from '@/hooks/use-tasks'
import { useSessions } from '@/hooks/use-sessions'
import { useProjects } from '@/hooks/use-projects'
import { computeSessionDuration } from '@/lib/time'
import { DateRangePicker } from './date-range-picker'
import { ProjectFilter } from './project-filter'
import type { DateRange } from 'react-day-picker'

export function TaskTimeBreakdown() {
  const tasks = useTasks()
  const sessions = useSessions()
  const projects = useProjects()
  const [dateRange, setDateRange] = useState<DateRange | undefined>()
  const [projectFilter, setProjectFilter] = useState('all')

  const { chartData } = useMemo(() => {
    if (!tasks || !sessions || !projects) return { chartData: [] }

    const filteredSessions = sessions.filter(s => {
      if (dateRange?.from && s.start < dateRange.from) return false
      if (dateRange?.to) {
        const endOfDay = new Date(dateRange.to)
        endOfDay.setHours(23, 59, 59, 999)
        if (s.start > endOfDay) return false
      }
      return true
    })

    const projectMap = new Map(projects.map(p => [p.id!, p]))
    const colors: Record<string, string> = {}
    projects.forEach(p => { colors[p.name] = p.color })

    // Group time by task, filtered by project
    const taskTimeMap = new Map<number, number>()
    for (const s of filteredSessions) {
      const current = taskTimeMap.get(s.taskId) ?? 0
      taskTimeMap.set(s.taskId, current + computeSessionDuration(s))
    }

    const data = tasks
      .filter(t => {
        if (projectFilter !== 'all' && t.projectId !== Number(projectFilter)) return false
        return taskTimeMap.has(t.id!)
      })
      .map(t => {
        const project = t.projectId ? projectMap.get(t.projectId) : null
        const hours = (taskTimeMap.get(t.id!) ?? 0) / 3600000
        return {
          name: t.title.length > 20 ? t.title.slice(0, 20) + '…' : t.title,
          hours: Math.round(hours * 100) / 100,
          project: project?.name ?? 'Unassigned',
          fill: project?.color ?? '#484847',
        }
      })
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 15)

    return { chartData: data }
  }, [tasks, sessions, projects, dateRange, projectFilter])

  return (
    <section className="bg-card p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h3 className="text-xs tracking-widest uppercase font-bold flex items-center gap-2">
            <span className="w-2 h-2 bg-primary" /> Task Time Breakdown
          </h3>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            Hours spent per task
          </p>
        </div>
        <div className="flex gap-2">
          <ProjectFilter value={projectFilter} onChange={setProjectFilter} />
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20 }}>
            <XAxis type="number" tick={{ fill: '#adaaaa', fontSize: 10 }} tickFormatter={(v) => `${v}h`} />
            <YAxis type="category" dataKey="name" width={150} tick={{ fill: '#adaaaa', fontSize: 10 }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(222,142,255,0.2)', fontSize: 12 }}
              labelStyle={{ color: '#fff', textTransform: 'uppercase', letterSpacing: '0.1em' }}
              formatter={(value) => [`${Number(value).toFixed(2)}h`, 'Time']}
            />
            <Bar dataKey="hours" radius={0}>
              {chartData.map((entry, i) => (
                <rect key={i} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-12">
          No task data for selected filters
        </p>
      )}
    </section>
  )
}
