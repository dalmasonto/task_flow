import { useState, useMemo } from 'react'
import { useTasks } from '@/hooks/use-tasks'
import { useProjects } from '@/hooks/use-projects'
import { useTimer } from '@/hooks/use-timer'
import { db } from '@/db/database'
import { TaskCard } from '@/components/task-card'
import { EmptyState } from '@/components/empty-state'

export default function Archive() {
  const tasks = useTasks({ status: 'done' })
  const projects = useProjects()
  const { tick } = useTimer(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all')

  const filteredTasks = useMemo(() => {
    if (!tasks) return []
    const sorted = [...tasks].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    if (selectedProjectId === 'all') return sorted
    const pid = selectedProjectId === 'unassigned' ? null : Number(selectedProjectId)
    return sorted.filter(t =>
      pid === null ? t.projectId == null : t.projectId === pid
    )
  }, [tasks, selectedProjectId])

  async function handleReopen(id: number) {
    await db.tasks.update(id, { status: 'in_progress', updatedAt: new Date() })
  }

  if (!tasks) return null

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-5xl font-bold tracking-tighter uppercase">
          Archived_Success
        </h1>
        <p className="text-muted-foreground text-xs tracking-widest uppercase mt-2">
          {tasks.length} task{tasks.length !== 1 ? 's' : ''} completed
        </p>
      </div>

      {/* Filter by project */}
      <div className="flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
          Filter by project
        </span>
        <select
          value={selectedProjectId}
          onChange={e => setSelectedProjectId(e.target.value)}
          className="bg-card text-foreground text-xs uppercase tracking-widest font-bold px-4 py-2 border-none outline-none cursor-pointer hover:bg-accent transition-colors"
        >
          <option value="all">All Projects</option>
          {projects?.map(p => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
            </option>
          ))}
          <option value="unassigned">Unassigned</option>
        </select>
      </div>

      {/* Task list */}
      {filteredTasks.length === 0 ? (
        <EmptyState
          icon="archive"
          title="No Archived Tasks"
          description="Complete tasks to see them here"
        />
      ) : (
        <div className="space-y-3">
          {filteredTasks.map(task => (
            <div key={task.id} className="relative group/row flex items-stretch gap-0">
              <div className="flex-1 min-w-0">
                <TaskCard task={task} tick={tick} />
              </div>
              <button
                onClick={() => task.id !== undefined && handleReopen(task.id)}
                title="Reopen task"
                className="
                  flex items-center gap-2 px-4
                  bg-card text-muted-foreground
                  text-[10px] uppercase tracking-widest font-bold
                  opacity-0 group-hover/row:opacity-100
                  hover:bg-accent hover:text-foreground
                  transition-all duration-200
                  border-l border-border/30
                  shrink-0
                "
              >
                <span className="material-symbols-outlined text-sm">replay</span>
                Reopen
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
