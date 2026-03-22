import { useMemo } from 'react'
import { useSessions } from '@/hooks/use-sessions'
import { useTasks } from '@/hooks/use-tasks'
import { formatDuration } from '@/lib/time'
import { getStatusColor, getStatusLabel } from '@/lib/status'
import type { TaskStatus } from '@/types'

type ActivityItem =
  | { kind: 'session'; id: number; taskId: number; start: Date; end?: Date; timestamp: Date }
  | { kind: 'status'; taskId: number; taskTitle: string; status: TaskStatus; timestamp: Date }

export default function ActivityPulse() {
  const sessions = useSessions()
  const allTasks = useTasks()

  const activityFeed = useMemo(() => {
    const items: ActivityItem[] = []

    if (sessions) {
      for (const s of sessions) {
        items.push({
          kind: 'session',
          id: s.id!,
          taskId: s.taskId,
          start: s.start,
          end: s.end,
          timestamp: s.start,
        })
      }
    }

    if (allTasks) {
      for (const t of allTasks) {
        if (t.status === 'done' || t.status === 'partial_done') {
          items.push({
            kind: 'status',
            taskId: t.id!,
            taskTitle: t.title,
            status: t.status,
            timestamp: new Date(t.updatedAt),
          })
        }
      }
    }

    return items
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }, [sessions, allTasks])

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-10">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 bg-secondary pulse-active" />
          <span className="text-xs tracking-widest uppercase text-secondary font-bold">Live Stream</span>
        </div>
        <h1 className="text-5xl font-bold tracking-tighter uppercase leading-none">
          Activity <span className="text-secondary">Pulse</span>
        </h1>
        <p className="text-xs text-muted-foreground uppercase tracking-widest mt-2">
          {activityFeed.length} events recorded
        </p>
      </div>

      {/* Feed */}
      {activityFeed.length > 0 ? (
        <div className="relative">
          <div className="absolute left-4 top-0 bottom-0 w-[1px] bg-muted-foreground/20" />
          <div className="space-y-8 relative">
            {activityFeed.map((item, i) => {
              const timeStr = item.timestamp.toLocaleTimeString('en-US', {
                hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
              })
              const dateStr = item.timestamp.toLocaleDateString('en-US', {
                month: 'short', day: 'numeric',
              })

              if (item.kind === 'status') {
                const color = getStatusColor(item.status)
                const icon = item.status === 'done' ? 'task_alt' : 'pending'
                const label = item.status === 'done' ? 'Task Completed' : 'Partial Completion'
                return (
                  <div key={`status-${item.taskId}-${i}`} className="flex gap-8 items-start">
                    <div className="relative z-10">
                      <div
                        className="w-8 h-8 bg-background flex items-center justify-center"
                        style={{ border: `1px solid ${color}`, boxShadow: `0 0 10px ${color}1A` }}
                      >
                        <span className="material-symbols-outlined text-sm" style={{ color }}>{icon}</span>
                      </div>
                    </div>
                    <div className={`flex-1 ${i < activityFeed.length - 1 ? 'pb-4 border-b border-muted-foreground/10' : ''}`}>
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-bold tracking-tight uppercase text-sm">{label}</span>
                        <span className="text-[10px] text-muted-foreground font-mono uppercase">{dateStr} {timeStr}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mb-3">{item.taskTitle}</p>
                      <div
                        className="inline-block px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest"
                        style={{ backgroundColor: `${color}1A`, color }}
                      >
                        {getStatusLabel(item.status)}
                      </div>
                    </div>
                  </div>
                )
              }

              const isActive = !item.end
              const borderColor = isActive ? '#00fbfb' : '#de8eff'
              const iconName = isActive ? 'play_circle' : 'timer'
              const duration = item.end
                ? formatDuration(item.end.getTime() - item.start.getTime())
                : 'Active'

              return (
                <div key={`session-${item.id}`} className="flex gap-8 items-start">
                  <div className="relative z-10">
                    <div
                      className="w-8 h-8 bg-background flex items-center justify-center"
                      style={{ border: `1px solid ${borderColor}`, boxShadow: `0 0 10px ${borderColor}1A` }}
                    >
                      <span className="material-symbols-outlined text-sm" style={{ color: borderColor }}>{iconName}</span>
                    </div>
                  </div>
                  <div className={`flex-1 ${i < activityFeed.length - 1 ? 'pb-4 border-b border-muted-foreground/10' : ''}`}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-bold tracking-tight uppercase text-sm">
                        Task #{item.taskId} {isActive ? 'In Progress' : 'Session Ended'}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono uppercase">{dateStr} {timeStr}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">Session duration: {duration}</p>
                    <div
                      className="inline-block px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest"
                      style={{ backgroundColor: `${borderColor}1A`, color: borderColor }}
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
        <p className="text-muted-foreground text-xs uppercase tracking-widest text-center py-16">
          No activity recorded yet. Start a task to see events here.
        </p>
      )}
    </div>
  )
}
