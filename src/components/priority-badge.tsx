import { cn } from '@/lib/utils'
import type { TaskPriority } from '@/types'

const PRIORITY_CONFIG: Record<TaskPriority, { color: string; label: string }> = {
  critical: { color: '#ff6e84', label: 'Critical' },
  high: { color: '#de8eff', label: 'High' },
  medium: { color: '#00fbfb', label: 'Medium' },
  low: { color: '#484847', label: 'Low' },
}

interface PriorityBadgeProps {
  priority: TaskPriority
  className?: string
}

export function PriorityBadge({ priority, className }: PriorityBadgeProps) {
  const config = PRIORITY_CONFIG[priority]

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest',
        className
      )}
      style={{
        backgroundColor: `${config.color}15`,
        color: config.color,
        borderLeft: `2px solid ${config.color}`,
      }}
    >
      {config.label}
    </div>
  )
}
