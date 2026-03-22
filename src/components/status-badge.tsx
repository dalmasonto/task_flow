import { cn } from '@/lib/utils'
import type { TaskStatus } from '@/types'
import { getStatusColor, getStatusLabel } from '@/lib/status'

interface StatusBadgeProps {
  status: TaskStatus
  className?: string
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const color = getStatusColor(status)

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
      {getStatusLabel(status)}
    </div>
  )
}
