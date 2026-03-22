import { useMemo } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { useTasks } from '@/hooks/use-tasks'
import { getStatusColor, getStatusLabel } from '@/lib/status'
import type { TaskStatus } from '@/types'

const STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'paused', 'blocked', 'partial_done', 'done']

export function StatusFlow() {
  const tasks = useTasks()

  const chartData = useMemo(() => {
    if (!tasks || tasks.length === 0) return []

    // Get all unique dates from task createdAt and updatedAt
    const allDates = new Set<string>()
    for (const t of tasks) {
      allDates.add(new Date(t.createdAt).toISOString().slice(0, 10))
      allDates.add(new Date(t.updatedAt).toISOString().slice(0, 10))
    }

    // Add today
    allDates.add(new Date().toISOString().slice(0, 10))

    const sortedDates = Array.from(allDates).sort()

    // For simplicity, show a snapshot approach:
    // We can't fully reconstruct historical state without an event log,
    // so we show the current distribution as a stacked view by creation date
    // Group tasks by their creation date and show cumulative status counts

    // Better approach: show current status distribution as of each date
    // tasks created before or on that date, with their current status
    return sortedDates.map(date => {
      const d = new Date(date)
      d.setHours(23, 59, 59, 999)

      const activeTasks = tasks.filter(t => new Date(t.createdAt) <= d)
      const counts: Record<string, number> = {}
      for (const s of STATUSES) counts[s] = 0
      for (const t of activeTasks) counts[t.status]++

      return {
        date,
        label: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        ...counts,
      }
    })
  }, [tasks])

  return (
    <section className="bg-card p-8">
      <div className="mb-8">
        <h3 className="text-xs tracking-widest uppercase font-bold flex items-center gap-2">
          <span className="w-2 h-2 bg-primary" /> Status Flow Over Time
        </h3>
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
          Task status distribution as your project grows — are tasks moving or getting stuck?
        </p>
      </div>

      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <XAxis
              dataKey="label"
              tick={{ fill: '#adaaaa', fontSize: 9 }}
              interval={Math.max(0, Math.floor(chartData.length / 8))}
            />
            <YAxis tick={{ fill: '#adaaaa', fontSize: 10 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(222,142,255,0.2)', fontSize: 11 }}
              labelStyle={{ color: '#fff', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: 10 }}
            />
            <Legend
              formatter={(value) => (
                <span className="text-[9px] uppercase tracking-widest text-muted-foreground">
                  {getStatusLabel(value as TaskStatus)}
                </span>
              )}
            />
            {STATUSES.map(status => (
              <Area
                key={status}
                type="monotone"
                dataKey={status}
                stackId="1"
                fill={getStatusColor(status)}
                stroke={getStatusColor(status)}
                fillOpacity={0.6}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-12">
          No task data to visualize
        </p>
      )}
    </section>
  )
}
