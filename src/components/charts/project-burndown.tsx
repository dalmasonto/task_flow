import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { useTasks } from '@/hooks/use-tasks'
import { useSessions } from '@/hooks/use-sessions'
import { useProjects } from '@/hooks/use-projects'
import { computeSessionDuration } from '@/lib/time'

export function ProjectBurndown() {
  const tasks = useTasks()
  const sessions = useSessions()
  const projects = useProjects()

  const chartData = useMemo(() => {
    if (!tasks || !sessions || !projects) return []

    const projectMap = new Map(projects.map(p => [p.id!, p]))

    // Aggregate per project: estimated vs actual
    const projectStats = new Map<number, { estimated: number; actual: number; name: string; color: string }>()

    for (const t of tasks) {
      if (!t.projectId) continue
      if (!projectStats.has(t.projectId)) {
        const p = projectMap.get(t.projectId)
        projectStats.set(t.projectId, {
          estimated: 0,
          actual: 0,
          name: p?.name ?? 'Unknown',
          color: p?.color ?? '#484847',
        })
      }
      const stat = projectStats.get(t.projectId)!
      stat.estimated += t.estimatedTime ?? 0
    }

    for (const s of sessions) {
      const task = tasks.find(t => t.id === s.taskId)
      if (!task?.projectId) continue
      const stat = projectStats.get(task.projectId)
      if (stat) {
        stat.actual += computeSessionDuration(s)
      }
    }

    return Array.from(projectStats.values())
      .filter(s => s.estimated > 0 || s.actual > 0)
      .map(s => ({
        name: s.name.length > 15 ? s.name.slice(0, 15) + '…' : s.name,
        estimated: Math.round((s.estimated / 3600000) * 100) / 100,
        actual: Math.round((s.actual / 3600000) * 100) / 100,
        color: s.color,
      }))
      .sort((a, b) => b.actual - a.actual)
  }, [tasks, sessions, projects])

  return (
    <section className="bg-card p-8">
      <div className="mb-8">
        <h3 className="text-xs tracking-widest uppercase font-bold flex items-center gap-2">
          <span className="w-2 h-2 bg-secondary" /> Project Burndown
        </h3>
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
          Estimated vs actual time per project — are you over or under-estimating?
        </p>
      </div>

      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData}>
            <XAxis dataKey="name" tick={{ fill: '#adaaaa', fontSize: 10 }} />
            <YAxis tick={{ fill: '#adaaaa', fontSize: 10 }} tickFormatter={(v) => `${v}h`} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(0,251,251,0.2)', fontSize: 12 }}
              formatter={(value, name) => [
                `${Number(value).toFixed(2)}h`,
                name === 'estimated' ? 'Estimated' : 'Actual',
              ]}
            />
            <Legend
              formatter={(value) => (
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  {value}
                </span>
              )}
            />
            <Bar dataKey="estimated" fill="#00fbfb40" stroke="#00fbfb" strokeWidth={1} radius={0} name="Estimated" />
            <Bar dataKey="actual" fill="#00fbfb" radius={0} name="Actual" />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-12">
          No project data with estimates or tracked time
        </p>
      )}
    </section>
  )
}
