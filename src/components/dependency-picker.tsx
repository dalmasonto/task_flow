import { useState } from 'react'
import { useTasks } from '@/hooks/use-tasks'
import { StatusBadge } from './status-badge'
import { cn } from '@/lib/utils'

interface DependencyPickerProps {
  selectedIds: number[]
  onChange: (ids: number[]) => void
  excludeTaskId?: number
}

export function DependencyPicker({ selectedIds, onChange, excludeTaskId }: DependencyPickerProps) {
  const [search, setSearch] = useState('')
  const tasks = useTasks()

  const available = (tasks ?? []).filter(t =>
    t.id !== excludeTaskId &&
    t.title.toLowerCase().includes(search.toLowerCase())
  )

  const toggleTask = (id: number) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter(i => i !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  return (
    <div className="bg-card p-6 border-t border-border">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-bold tracking-widest uppercase text-primary">
          Node_Dependencies
        </h3>
        <span className="material-symbols-outlined text-primary text-sm">link</span>
      </div>

      {/* Selected chips */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {selectedIds.map(id => {
            const task = (tasks ?? []).find(t => t.id === id)
            return task ? (
              <button
                key={id}
                type="button"
                onClick={() => toggleTask(id)}
                className="flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary text-[10px] uppercase tracking-widest hover:bg-primary/20 transition-colors"
              >
                {task.title}
                <span className="material-symbols-outlined text-xs">close</span>
              </button>
            ) : null
          })}
        </div>
      )}

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="FILTER_TASKS..."
        className="w-full bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-[10px] uppercase tracking-widest py-2 px-0 mb-4 placeholder:text-muted-foreground/30"
      />

      {/* Task list */}
      <div className="space-y-2 max-h-48 overflow-y-auto">
        {available.map(task => (
          <button
            key={task.id}
            type="button"
            onClick={() => toggleTask(task.id!)}
            className={cn(
              'flex items-center justify-between w-full p-3 border border-border transition-colors text-left',
              selectedIds.includes(task.id!)
                ? 'bg-primary/5 border-primary/40'
                : 'bg-input hover:border-secondary'
            )}
          >
            <div className="flex items-center gap-3">
              <StatusBadge status={task.status} />
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                {task.title}
              </span>
            </div>
            <span className="material-symbols-outlined text-sm opacity-30">
              {selectedIds.includes(task.id!) ? 'check' : 'add'}
            </span>
          </button>
        ))}
        {available.length === 0 && (
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest text-center py-4">
            No tasks available
          </p>
        )}
      </div>
    </div>
  )
}
