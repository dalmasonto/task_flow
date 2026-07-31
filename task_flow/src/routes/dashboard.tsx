import { useState, useMemo } from 'react'
import { Link } from 'react-router'
import { useTasks } from '@/hooks/use-tasks'
import { useAnalytics } from '@/hooks/use-analytics'
import { useActiveSessions } from '@/hooks/use-sessions'
import { useTimer } from '@/hooks/use-timer'
import { useProjects } from '@/hooks/use-projects'
import { TaskCard } from '@/components/task-card'
import { EmptyState } from '@/components/empty-state'
import type { TaskStatus } from '@/types'
import { getStatusColor, getStatusLabel } from '@/lib/status'

const ALL_STATUSES: TaskStatus[] = [
  'not_started',
  'in_progress',
  'paused',
  'blocked',
  'partial_done',
  'done',
]

type GroupMode = 'status' | 'project'

export default function Dashboard() {
  const tasks = useTasks()
  const analytics = useAnalytics()
  const activeSessions = useActiveSessions()
  const projects = useProjects()
  const { tick } = useTimer((activeSessions ?? []).length > 0)
  const [groupMode, setGroupMode] = useState<GroupMode>('status')

  const throughput = analytics
    ? analytics.totalTasks > 0
      ? Math.round((analytics.tasksCompleted / analytics.totalTasks) * 100)
      : 0
    : 0

  const activeNodes = analytics?.tasksInProgress ?? 0

  const totalHours = analytics
    ? (analytics.totalFocusedTime / 3_600_000).toFixed(1)
    : '0.0'

  const statusGroups = useMemo(() => {
    if (!tasks) return []
    return ALL_STATUSES
      .map(status => ({
        key: status,
        label: getStatusLabel(status),
        color: getStatusColor(status),
        tasks: tasks.filter(t => t.status === status),
      }))
      .filter(g => g.tasks.length > 0)
  }, [tasks])

  const projectGroups = useMemo(() => {
    if (!tasks || !projects) return []
    const projectMap = new Map(projects.map(p => [p.id!, p]))
    const groups = new Map<string, { key: string; label: string; color: string; tasks: typeof tasks }>()

    for (const task of tasks) {
      const project = task.projectId ? projectMap.get(task.projectId) : undefined
      const key = project ? String(project.id) : 'unassigned'
      const label = project?.name ?? 'Unassigned'
      const color = project?.color ?? '#484847'

      if (!groups.has(key)) {
        groups.set(key, { key, label, color, tasks: [] })
      }
      groups.get(key)!.tasks.push(task)
    }

    return Array.from(groups.values())
  }, [tasks, projects])

  if (!tasks) return null

  if (tasks.length === 0) {
    return (
      <div className="p-8">
        <h1 className="text-3xl md:text-5xl font-bold tracking-tighter uppercase">
          Command_Center
        </h1>
        <EmptyState
          icon="terminal"
          title="No Tasks Yet"
          description="Initialize your first task sequence"
          action={
            <Link
              to="/tasks/new"
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-xs uppercase tracking-widest font-bold hover:bg-primary/90 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">add</span>
              New Task
            </Link>
          }
        />
      </div>
    )
  }

  const groups = groupMode === 'status' ? statusGroups : projectGroups

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
        <div>
          <h1 className="text-3xl md:text-5xl font-bold tracking-tighter uppercase">
            Command_Center
          </h1>
          <div className="flex items-center gap-2 mt-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <span className="text-muted-foreground text-xs tracking-widest uppercase">
              System nominal
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <StatCard label="Throughput" value={`${throughput}%`} />
          <StatCard label="Active_Nodes" value={String(activeNodes)} />
          <StatCard label="Uptime" value={`${totalHours}h`} />
        </div>
      </div>

      {/* Filter controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setGroupMode('status')}
          className={`px-4 py-2 text-xs uppercase tracking-widest font-bold transition-colors ${
            groupMode === 'status'
              ? 'bg-primary text-primary-foreground'
              : 'bg-card text-muted-foreground hover:text-foreground'
          }`}
        >
          By Status
        </button>
        <button
          onClick={() => setGroupMode('project')}
          className={`px-4 py-2 text-xs uppercase tracking-widest font-bold transition-colors ${
            groupMode === 'project'
              ? 'bg-primary text-primary-foreground'
              : 'bg-card text-muted-foreground hover:text-foreground'
          }`}
        >
          By Project
        </button>
      </div>

      {/* Task board */}
      <div className="space-y-6">
        {groups.map(group => (
          <div key={group.key}>
            <div
              className="flex items-center gap-3 pb-3 mb-4"
              style={{
                borderBottom: `1px solid ${group.color}33`,
              }}
            >
              <div
                className="w-1.5 h-6"
                style={{ backgroundColor: group.color }}
              />
              <span
                className="text-xs font-bold uppercase tracking-widest"
                style={{ color: group.color }}
              >
                {group.label}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground bg-muted px-2 py-0.5">
                {group.tasks.length}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {group.tasks.map(task => (
                <TaskCard key={task.id} task={task} tick={tick} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-5 py-3 min-w-[120px]">
      <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">
        {label}
      </div>
      <div className="text-xl font-bold tracking-tight font-mono">
        {value}
      </div>
    </div>
  )
}
