import { useMemo, useState } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { useSessions } from '@/hooks/use-sessions'
import { useTasks } from '@/hooks/use-tasks'
import { useProjects } from '@/hooks/use-projects'
import { formatDuration, computeSessionDuration } from '@/lib/time'
import { getStatusColor, getStatusLabel } from '@/lib/status'
import type { Session, Task, Project, TaskStatus } from '@/types'

type TimeRange = 'day' | 'week' | 'month'

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const CHART_COLORS = {
  deep: '#00fbfb',
  regular: '#de8eff',
  idle: '#484847',
}

function getIntensity(session: Session): string {
  const dur = computeSessionDuration(session)
  const hours = dur / 3_600_000
  if (hours >= 2) return 'HIGH'
  if (hours >= 0.5) return 'MED'
  return 'LOW'
}

function getIntensityColor(intensity: string): string {
  switch (intensity) {
    case 'HIGH':
      return '#ff6e84'
    case 'MED':
      return '#de8eff'
    default:
      return '#484847'
  }
}

export default function ExecutionTimeline() {
  const sessions = useSessions()
  const tasks = useTasks()
  const projects = useProjects()
  const [timeRange, setTimeRange] = useState<TimeRange>('week')

  const taskMap = useMemo(() => {
    if (!tasks) return new Map<number, Task>()
    const m = new Map<number, Task>()
    for (const t of tasks) if (t.id !== undefined) m.set(t.id, t)
    return m
  }, [tasks])

  const projectMap = useMemo(() => {
    if (!projects) return new Map<number, Project>()
    const m = new Map<number, Project>()
    for (const p of projects) if (p.id !== undefined) m.set(p.id, p)
    return m
  }, [projects])

  // Stats
  const stats = useMemo(() => {
    if (!sessions || !tasks) {
      return { weeklyHours: 0, deepWorkRatio: 0, tasksCompleted: 0, blockedHours: 0 }
    }

    const now = new Date()
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000)
    const weekSessions = sessions.filter((s) => s.start >= weekAgo)

    const totalMs = weekSessions.reduce((sum, s) => sum + computeSessionDuration(s), 0)
    const weeklyHours = totalMs / 3_600_000

    // Deep work = sessions >= 30min
    const deepMs = weekSessions
      .filter((s) => computeSessionDuration(s) >= 30 * 60_000)
      .reduce((sum, s) => sum + computeSessionDuration(s), 0)
    const deepWorkRatio = totalMs > 0 ? Math.round((deepMs / totalMs) * 100) : 0

    const tasksCompleted = tasks.filter((t) => t.status === 'done').length

    const blockedMs = weekSessions
      .filter((s) => {
        const task = taskMap.get(s.taskId)
        return task?.status === 'blocked'
      })
      .reduce((sum, s) => sum + computeSessionDuration(s), 0)
    const blockedHours = blockedMs / 3_600_000

    return { weeklyHours, deepWorkRatio, tasksCompleted, blockedHours }
  }, [sessions, tasks, taskMap])

  // Chart data: stacked bars by day of week
  const chartData = useMemo(() => {
    if (!sessions) return []

    const now = new Date()
    let startDate: Date

    if (timeRange === 'day') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    } else if (timeRange === 'week') {
      startDate = new Date(now.getTime() - 7 * 24 * 3_600_000)
    } else {
      startDate = new Date(now.getTime() - 30 * 24 * 3_600_000)
    }

    const filtered = sessions.filter((s) => s.start >= startDate)

    // Bucket by JS day (0=Sun..6=Sat) -> remap to Mon=0..Sun=6
    const buckets = DAY_LABELS.map(() => ({ deep: 0, regular: 0, idle: 0 }))

    for (const s of filtered) {
      const jsDay = s.start.getDay() // 0=Sun
      const idx = jsDay === 0 ? 6 : jsDay - 1 // Mon=0..Sun=6
      const dur = computeSessionDuration(s) / 3_600_000
      const intensity = getIntensity(s)
      if (intensity === 'HIGH') {
        buckets[idx].deep += dur
      } else if (intensity === 'MED') {
        buckets[idx].regular += dur
      } else {
        buckets[idx].idle += dur
      }
    }

    return DAY_LABELS.map((label, i) => ({
      day: label,
      deep: +buckets[i].deep.toFixed(2),
      regular: +buckets[i].regular.toFixed(2),
      idle: +buckets[i].idle.toFixed(2),
    }))
  }, [sessions, timeRange])

  // Recent sessions for the table
  const recentSessions = useMemo(() => {
    if (!sessions) return []
    return [...sessions].sort((a, b) => b.start.getTime() - a.start.getTime()).slice(0, 20)
  }, [sessions])

  // Uptime
  const uptimeStr = useMemo(() => {
    if (!sessions || sessions.length === 0) return '00:00:00'
    const earliest = sessions.reduce(
      (min, s) => (s.start < min ? s.start : min),
      sessions[0].start
    )
    // eslint-disable-next-line react-hooks/purity
    return formatDuration(Date.now() - earliest.getTime())
  }, [sessions])

  if (!sessions || !tasks || !projects) return null

  return (
    <div className="p-8 space-y-12">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-5xl md:text-6xl font-bold tracking-tighter uppercase leading-none mb-2">
            Execution<br />
            <span className="text-primary">Timeline</span>
          </h1>
          <p className="text-muted-foreground text-sm tracking-[0.2em] uppercase">
            System Monitor
          </p>
        </div>
        <div className="bg-card p-4 border-l-2 border-[#00fbfb] shadow-[0_0_15px_rgba(0,251,251,0.1)]">
          <div className="text-[10px] text-[#00fbfb] tracking-widest uppercase mb-1">
            Uptime
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00fbfb] opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00fbfb]" />
            </span>
            <span className="font-bold text-xl font-mono">{uptimeStr}</span>
          </div>
        </div>
      </header>

      {/* Stats Row */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          label="Weekly Output"
          value={stats.weeklyHours.toFixed(1)}
          suffix="hrs"
          borderColor="#00fbfb"
          trend={stats.weeklyHours > 0 ? '+active' : 'idle'}
          trendUp={stats.weeklyHours > 0}
        />
        <StatCard
          label="Deep Work Ratio"
          value={String(stats.deepWorkRatio)}
          suffix="%"
          borderColor="#de8eff"
          trend={stats.deepWorkRatio >= 50 ? 'optimal' : 'below target'}
          trendUp={stats.deepWorkRatio >= 50}
        />
        <StatCard
          label="Tasks Completed"
          value={String(stats.tasksCompleted)}
          borderColor="#69fd5d"
          trend={`of ${tasks.length} total`}
          trendUp={stats.tasksCompleted > 0}
        />
        <StatCard
          label="Blocked Time"
          value={stats.blockedHours.toFixed(1)}
          suffix="hrs"
          borderColor="#ff6e84"
          trend={stats.blockedHours > 0 ? 'needs attention' : 'clear'}
          trendUp={stats.blockedHours === 0}
        />
      </section>

      {/* Resource Allocation Chart */}
      <section className="bg-card p-8">
        <div className="flex justify-between items-center mb-8">
          <h3 className="text-muted-foreground text-xs tracking-widest uppercase">
            Resource Allocation
          </h3>
          <div className="flex gap-1">
            {(['day', 'week', 'month'] as TimeRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-3 py-1 text-[10px] tracking-widest uppercase font-bold transition-colors ${
                  timeRange === range
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {range}
              </button>
            ))}
          </div>
        </div>

        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barCategoryGap="20%">
              <XAxis
                dataKey="day"
                tick={{ fill: '#888', fontSize: 10, letterSpacing: '0.1em' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#888', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                unit="h"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0a0a0a',
                  border: '1px solid #222',
                  borderRadius: 0,
                  fontSize: 11,
                }}
                labelStyle={{ color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em' }}
              />
              <Legend
                wrapperStyle={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em' }}
              />
              <Bar dataKey="deep" name="Deep Work" stackId="a" fill={CHART_COLORS.deep} />
              <Bar dataKey="regular" name="Regular" stackId="a" fill={CHART_COLORS.regular} />
              <Bar dataKey="idle" name="Idle" stackId="a" fill={CHART_COLORS.idle} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Live Session Stream Table */}
      <section className="bg-card p-8">
        <div className="flex justify-between items-center mb-8">
          <h3 className="text-muted-foreground text-xs tracking-widest uppercase">
            Live Session Stream
          </h3>
          <button className="px-3 py-1 bg-muted text-[10px] tracking-widest uppercase font-bold text-muted-foreground hover:text-foreground transition-colors">
            Export Raw Data
          </button>
        </div>

        {recentSessions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-muted-foreground/20">
                  <th className="text-left text-[10px] text-muted-foreground tracking-widest uppercase font-bold pb-3 pr-4">
                    Status
                  </th>
                  <th className="text-left text-[10px] text-muted-foreground tracking-widest uppercase font-bold pb-3 pr-4">
                    Task
                  </th>
                  <th className="text-left text-[10px] text-muted-foreground tracking-widest uppercase font-bold pb-3 pr-4">
                    Project
                  </th>
                  <th className="text-left text-[10px] text-muted-foreground tracking-widest uppercase font-bold pb-3 pr-4">
                    Start Time
                  </th>
                  <th className="text-left text-[10px] text-muted-foreground tracking-widest uppercase font-bold pb-3 pr-4">
                    Duration
                  </th>
                  <th className="text-left text-[10px] text-muted-foreground tracking-widest uppercase font-bold pb-3">
                    Intensity
                  </th>
                </tr>
              </thead>
              <tbody>
                {recentSessions.map((session, i) => {
                  const task = taskMap.get(session.taskId)
                  const project = task?.projectId ? projectMap.get(task.projectId) : undefined
                  const isActive = !session.end
                  const status: TaskStatus = isActive
                    ? 'in_progress'
                    : task?.status ?? 'done'
                  const statusColor = getStatusColor(status)
                  const dur = computeSessionDuration(session)
                  const intensity = getIntensity(session)
                  const intensityColor = getIntensityColor(intensity)
                  const startStr = session.start.toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })

                  return (
                    <tr
                      key={session.id ?? i}
                      className="border-b border-muted-foreground/10 hover:bg-muted/30 transition-colors"
                    >
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{
                              backgroundColor: statusColor,
                              boxShadow: `0 0 6px ${statusColor}`,
                            }}
                          />
                          <span className="text-xs uppercase tracking-wider">
                            {getStatusLabel(status)}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="font-mono text-xs text-muted-foreground">
                          #{session.taskId}
                        </span>{' '}
                        <span className="font-bold text-xs uppercase tracking-tight">
                          {task?.title ?? 'Unknown'}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        {project ? (
                          <div className="flex items-center gap-2">
                            <div
                              className="w-2 h-2 flex-shrink-0"
                              style={{ backgroundColor: project.color }}
                            />
                            <span className="text-xs uppercase tracking-wider">
                              {project.name}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs">{startStr}</td>
                      <td className="py-3 pr-4 font-mono text-xs">
                        {isActive ? (
                          <span className="text-[#00fbfb]">LIVE</span>
                        ) : (
                          formatDuration(dur)
                        )}
                      </td>
                      <td className="py-3">
                        <span
                          className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest"
                          style={{
                            backgroundColor: `${intensityColor}1A`,
                            color: intensityColor,
                          }}
                        >
                          {intensity}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-8">
            No session data available
          </p>
        )}
      </section>
    </div>
  )
}

function StatCard({
  label,
  value,
  suffix,
  borderColor,
  trend,
  trendUp,
}: {
  label: string
  value: string
  suffix?: string
  borderColor: string
  trend: string
  trendUp: boolean
}) {
  return (
    <div
      className="bg-card p-6 relative overflow-hidden group"
      style={{ borderTop: `2px solid ${borderColor}` }}
    >
      <div
        className="absolute top-0 right-0 w-20 h-20 -mr-10 -mt-10 blur-3xl opacity-10 group-hover:opacity-20 transition-opacity"
        style={{ backgroundColor: borderColor }}
      />
      <div className="text-muted-foreground text-[10px] tracking-widest uppercase mb-3">
        {label}
      </div>
      <div className="text-3xl font-bold mb-2">
        {value}
        {suffix && (
          <span className="text-lg ml-1" style={{ color: borderColor }}>
            {suffix}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <span
          className="material-symbols-outlined text-sm"
          style={{ color: trendUp ? '#69fd5d' : '#ff6e84' }}
        >
          {trendUp ? 'trending_up' : 'trending_down'}
        </span>
        <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
          {trend}
        </span>
      </div>
    </div>
  )
}
