import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon: string
  title: string
  description: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 px-8 text-center', className)}>
      <span className="material-symbols-outlined text-5xl text-muted-foreground/30 mb-6">
        {icon}
      </span>
      <h3 className="text-lg font-bold uppercase tracking-tight mb-2">{title}</h3>
      <p className="text-xs text-muted-foreground uppercase tracking-widest max-w-sm mb-6">
        {description}
      </p>
      {action}
    </div>
  )
}
