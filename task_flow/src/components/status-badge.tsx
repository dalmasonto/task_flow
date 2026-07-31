import { cn } from '@/lib/utils'
import type { Task, TaskStatus } from '@/types'
import { getStatusColor, getStatusLabel, getDisplayStatus } from '@/lib/status'

interface StatusBadgeProps {
  status: TaskStatus
  /** Pass task + allTasks to show "Unblocked" when blocked task's dependencies are done */
  task?: Task
  allTasks?: Task[]
  className?: string
}

export function StatusBadge({ status, task, allTasks, className }: StatusBadgeProps) {
  const display = task && allTasks
    ? getDisplayStatus(task, allTasks)
    : { label: getStatusLabel(status), status }

  const isUnblocked = display.label === 'Unblocked'
  const color = isUnblocked ? '#69fd5d' : getStatusColor(status)

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest',
        className
      )}
      style={{
        backgroundColor: `${color}15`,
        color: color,
        borderLeft: `2px solid ${color}`,
      }}
    >
      {status === 'in_progress' && (
        <span
          className="w-1.5 h-1.5 animate-pulse"
          style={{ backgroundColor: color }}
        />
      )}
      {display.label}
    </div>
  )
}
