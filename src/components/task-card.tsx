import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'
import { getStatusColor } from '@/lib/status'
import { formatDuration } from '@/lib/time'
import { useTaskTotalTime } from '@/hooks/use-sessions'
import { useProject } from '@/hooks/use-projects'
import { StatusBadge } from './status-badge'

interface TaskCardProps {
  task: Task
  tick?: number
  className?: string
}

export function TaskCard({ task, tick, className }: TaskCardProps) {
  const totalTime = useTaskTotalTime(task.id, tick)
  const project = useProject(task.projectId)
  const color = getStatusColor(task.status)

  return (
    <Link
      to={`/tasks/${task.id}`}
      className={cn(
        'block bg-card p-6 group cursor-pointer transition-all duration-300',
        'hover:bg-accent hover:translate-x-1',
        className
      )}
      style={{ borderLeft: `4px solid ${color}` }}
    >
      <div className="flex justify-between items-start mb-4">
        <StatusBadge status={task.status} />
        <span className="material-symbols-outlined text-muted-foreground/40 group-hover:text-muted-foreground transition-colors text-sm">
          more_vert
        </span>
      </div>
      <h3 className="font-bold text-lg mb-3 text-foreground group-hover:text-foreground transition-colors leading-tight tracking-tight">
        {task.title}
      </h3>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {project && (
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2"
                style={{ backgroundColor: project.color }}
              />
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                {project.name}
              </span>
            </div>
          )}
        </div>
        {totalTime > 0 && (
          <span className="text-[10px] font-bold text-muted-foreground tracking-widest font-mono">
            {formatDuration(totalTime)}
          </span>
        )}
      </div>
    </Link>
  )
}
