import { useMemo } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'
import { useAnalytics } from '@/hooks/use-analytics'
import { useSessions } from '@/hooks/use-sessions'
import { formatDuration } from '@/lib/time'
import { getStatusColor, getStatusLabel } from '@/lib/status'
import { EmptyState } from '@/components/empty-state'
import type { TaskStatus } from '@/types'

const NEON_COLORS = ['#de8eff', '#00fbfb', '#69fd5d', '#ff6e84', '#b90afc', '#484847']

export default function Analytics() {
  const analytics = useAnalytics()
  const sessions = useSessions()

  const totalHours = analytics
    ? (analytics.totalFocusedTime / 3_600_000).toFixed(1)
    : '0.0'

  const focusVelocity = analytics
    ? analytics.totalTasks > 0
      ? (analytics.tasksCompleted / analytics.totalTasks).toFixed(2)
      : '0.00'
    : '0.00'

  const statusData = useMemo(() => {
    if (!analytics) return []
    return Object.entries(analytics.statusDistribution).map(([status, value]) => ({
      name: getStatusLabel(status as TaskStatus),
      value,
      color: getStatusColor(status as TaskStatus),
    }))
  }, [analytics])

  const dominantStatus = useMemo(() => {
    if (!statusData.length) return { name: '', pct: 0 }
    const total = statusData.reduce((s, d) => s + d.value, 0)
    const max = statusData.reduce((a, b) => (b.value > a.value ? b : a), statusData[0])
    return { name: max.name, pct: total > 0 ? Math.round((max.value / total) * 100) : 0 }
  }, [statusData])

  const maxProjectTime = useMemo(() => {
    if (!analytics?.timePerProject.length) return 0
    return Math.max(...analytics.timePerProject.map(p => p.totalTime))
  }, [analytics])

  const recentSessions = useMemo(() => {
    if (!sessions) return []
    return [...sessions]
      .sort((a, b) => b.start.getTime() - a.start.getTime())
      .slice(0, 15)
  }, [sessions])

  if (!analytics || !sessions) return null

  if (analytics.totalTasks === 0 && sessions.length === 0) {
    return (
      <div className="p-8">
        <h1 className="text-5xl font-bold tracking-tighter uppercase">
          System Performance
        </h1>
        <EmptyState
          icon="insights"
          title="No Analytics Data"
          description="Start tracking tasks and sessions to see performance metrics"
        />
      </div>
    )
  }

  return (
    <div className="p-8 space-y-12">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-5xl md:text-6xl font-bold tracking-tighter uppercase leading-none mb-2">
            System<br />
            <span className="text-primary">Performance</span>
          </h1>
          <p className="text-muted-foreground text-sm tracking-[0.2em] uppercase">
            Real-time Node Analytics
          </p>
        </div>
        <div className="bg-card p-4 border-l-2 border-[#00fbfb] shadow-[0_0_15px_rgba(0,251,251,0.1)]">
          <div className="text-[10px] text-[#00fbfb] tracking-widest uppercase mb-1">Status</div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00fbfb] opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00fbfb]" />
            </span>
            <span className="font-bold text-xl">UPLINK ACTIVE</span>
          </div>
        </div>
      </header>

      {/* Top Metrics Row */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <MetricCard
          label="Total Focused Time"
          value={totalHours}
          suffix="hrs"
          suffixColor="text-primary"
          glowColor="bg-primary/5"
          glowHoverColor="group-hover:bg-primary/10"
          trendIcon="trending_up"
          trendText={`${formatDuration(analytics.totalFocusedTime)} tracked`}
          trendColor="text-[#69fd5d]"
        />
        <MetricCard
          label="Tasks Completed"
          value={String(analytics.tasksCompleted)}
          glowColor="bg-[#00fbfb]/5"
          glowHoverColor="group-hover:bg-[#00fbfb]/10"
          trendIcon="check_circle"
          trendText={`${analytics.totalTasks} total tasks`}
          trendColor="text-[#00fbfb]"
        />
        <MetricCard
          label="Focus Velocity"
          value={focusVelocity}
          suffix="v"
          suffixColor="text-[#69fd5d]"
          glowColor="bg-[#69fd5d]/5"
          glowHoverColor="group-hover:bg-[#69fd5d]/10"
          trendIcon="bolt"
          trendText={analytics.tasksCompleted > 0 ? 'Active Performance' : 'No completions yet'}
          trendColor="text-[#69fd5d]"
        />
      </section>

      {/* Middle Section */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Status Distribution Donut */}
        <div className="lg:col-span-4 bg-card p-8 flex flex-col items-center justify-center">
          <div className="text-muted-foreground text-xs tracking-widest uppercase mb-8 self-start w-full">
            Status Distribution
          </div>
          {statusData.length > 0 ? (
            <>
              <div className="relative w-48 h-48 mb-8">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={statusData}
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={75}
                      paddingAngle={2}
                      dataKey="value"
                      stroke="none"
                    >
                      {statusData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-bold">{dominantStatus.pct}%</span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                    {dominantStatus.name}
                  </span>
                </div>
              </div>
              <div className="w-full space-y-3">
                {statusData.map((item) => (
                  <div key={item.name} className="flex justify-between items-center text-xs">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2" style={{ backgroundColor: item.color }} />
                      <span className="uppercase tracking-widest text-muted-foreground">
                        {item.name}
                      </span>
                    </div>
                    <span className="font-bold">{item.value}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-xs uppercase tracking-widest">No tasks yet</p>
          )}
        </div>

        {/* Project Time Allocation */}
        <div className="lg:col-span-8 bg-card p-8">
          <div className="text-muted-foreground text-xs tracking-widest uppercase mb-8">
            Project Time Allocation
          </div>
          {analytics.timePerProject.length > 0 ? (
            <div className="space-y-8">
              {analytics.timePerProject
                .sort((a, b) => b.totalTime - a.totalTime)
                .map((project, i) => {
                  const hours = (project.totalTime / 3_600_000).toFixed(1)
                  const pct = maxProjectTime > 0 ? (project.totalTime / maxProjectTime) * 100 : 0
                  const barColor = project.color || NEON_COLORS[i % NEON_COLORS.length]
                  return (
                    <div key={project.projectId}>
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-bold text-sm tracking-tight uppercase">
                          {project.projectName}
                        </span>
                        <span className="font-mono" style={{ color: barColor }}>
                          {hours}h
                        </span>
                      </div>
                      <div className="h-2 bg-muted w-full">
                        <div
                          className="h-full transition-all duration-500"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: barColor,
                            boxShadow: `0 0 10px ${barColor}4D`,
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs uppercase tracking-widest">
              No project time tracked yet
            </p>
          )}
        </div>
      </section>

      {/* System Activity Pulse */}
      <section className="bg-card p-8">
        <div className="flex justify-between items-center mb-8">
          <h3 className="text-muted-foreground text-xs tracking-widest uppercase">
            System Activity Pulse
          </h3>
          <div className="px-3 py-1 bg-muted text-[10px] tracking-widest uppercase font-bold">
            Live Stream
          </div>
        </div>
        {recentSessions.length > 0 ? (
          <div className="relative">
            <div className="absolute left-4 top-0 bottom-0 w-[1px] bg-muted-foreground/20" />
            <div className="space-y-8 relative">
              {recentSessions.map((session, i) => {
                const isActive = !session.end
                const borderColor = isActive ? '#00fbfb' : i % 3 === 0 ? '#de8eff' : i % 3 === 1 ? '#00fbfb' : '#69fd5d'
                const iconName = isActive ? 'play_circle' : 'check_circle'
                const timeStr = session.start.toLocaleTimeString('en-US', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })
                const dateStr = session.start.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })
                const duration = session.end
                  ? formatDuration(session.end.getTime() - session.start.getTime())
                  : 'Active'

                return (
                  <div key={session.id ?? i} className="flex gap-8 items-start">
                    <div className="relative z-10">
                      <div
                        className="w-8 h-8 bg-background flex items-center justify-center"
                        style={{
                          border: `1px solid ${borderColor}`,
                          boxShadow: `0 0 10px ${borderColor}1A`,
                        }}
                      >
                        <span
                          className="material-symbols-outlined text-sm"
                          style={{ color: borderColor }}
                        >
                          {iconName}
                        </span>
                      </div>
                    </div>
                    <div className={`flex-1 ${i < recentSessions.length - 1 ? 'pb-4 border-b border-muted-foreground/10' : ''}`}>
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-bold tracking-tight uppercase text-sm">
                          Task #{session.taskId} {isActive ? 'In Progress' : 'Completed'}
                        </span>
                        <span className="text-[10px] text-muted-foreground font-mono uppercase">
                          {dateStr} {timeStr}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mb-3">
                        Session duration: {duration}
                      </p>
                      <div
                        className="inline-block px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest"
                        style={{
                          backgroundColor: `${borderColor}1A`,
                          color: borderColor,
                        }}
                      >
                        {isActive ? 'Active Session' : 'Completed Session'}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-8">
            No session activity recorded
          </p>
        )}
      </section>
    </div>
  )
}

function MetricCard({
  label,
  value,
  suffix,
  suffixColor,
  glowColor,
  glowHoverColor,
  trendIcon,
  trendText,
  trendColor,
}: {
  label: string
  value: string
  suffix?: string
  suffixColor?: string
  glowColor: string
  glowHoverColor: string
  trendIcon: string
  trendText: string
  trendColor: string
}) {
  return (
    <div className="bg-card p-8 relative overflow-hidden group">
      <div className={`absolute top-0 right-0 w-24 h-24 ${glowColor} -mr-12 -mt-12 blur-3xl ${glowHoverColor} transition-colors`} />
      <div className="text-muted-foreground text-xs tracking-widest uppercase mb-4">
        {label}
      </div>
      <div className="text-4xl font-bold mb-2">
        {value}
        {suffix && <span className={suffixColor}>{suffix}</span>}
      </div>
      <div className={`flex items-center gap-2 ${trendColor} text-xs font-bold`}>
        <span className="material-symbols-outlined text-sm">{trendIcon}</span>
        {trendText}
      </div>
    </div>
  )
}
