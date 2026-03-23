import { useState, useEffect, useRef, useCallback } from 'react'
import { useActivityLog, clearActivityLog } from '@/hooks/use-activity-log'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import type { ActivityAction } from '@/types'

const PAGE_SIZE = 50

const ACTION_CONFIG: Record<ActivityAction, { icon: string; color: string }> = {
  task_created: { icon: 'add_task', color: '#69fd5d' },
  task_deleted: { icon: 'delete', color: '#ff6e84' },
  task_status_changed: { icon: 'sync', color: '#00fbfb' },
  task_completed: { icon: 'task_alt', color: '#69fd5d' },
  task_partial_done: { icon: 'pending', color: '#b90afc' },
  timer_started: { icon: 'play_circle', color: '#00fbfb' },
  timer_paused: { icon: 'pause_circle', color: '#de8eff' },
  timer_stopped: { icon: 'stop_circle', color: '#ff6e84' },
  project_created: { icon: 'create_new_folder', color: '#69fd5d' },
  project_deleted: { icon: 'folder_delete', color: '#ff6e84' },
  project_updated: { icon: 'edit', color: '#00fbfb' },
  tasks_bulk_created: { icon: 'playlist_add', color: '#69fd5d' },
  settings_saved: { icon: 'settings', color: '#de8eff' },
  data_seeded: { icon: 'database', color: '#de8eff' },
  data_cleared: { icon: 'delete_sweep', color: '#ff6e84' },
  task_linked: { icon: 'link', color: '#00fbfb' },
  task_unlinked: { icon: 'link_off', color: '#484847' },
  dependency_added: { icon: 'account_tree', color: '#00fbfb' },
  dependency_removed: { icon: 'account_tree', color: '#484847' },
  link_added: { icon: 'add_link', color: '#00fbfb' },
  tag_added: { icon: 'label', color: '#69fd5d' },
  tag_removed: { icon: 'label_off', color: '#484847' },
  debug_log: { icon: 'bug_report', color: '#ffeb3b' },
}

function formatTimeAgo(date: Date): string {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function ActivityPulse() {
  const logs = useActivityLog()
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const totalCount = logs?.length ?? 0
  const visibleLogs = logs?.slice(0, visibleCount)
  const hasMore = visibleCount < totalCount

  // Reset visible count when logs are cleared
  useEffect(() => {
    if (totalCount === 0) setVisibleCount(PAGE_SIZE)
  }, [totalCount])

  // IntersectionObserver to load more on scroll
  const loadMore = useCallback(() => {
    setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, totalCount))
  }, [totalCount])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore()
      },
      { rootMargin: '200px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore])

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-10">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 bg-secondary pulse-active" />
            <span className="text-xs tracking-widest uppercase text-secondary font-bold">System Log</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold tracking-tighter uppercase leading-none">
            Activity <span className="text-secondary">Pulse</span>
          </h1>
          <p className="text-xs text-muted-foreground uppercase tracking-widest mt-2">
            {totalCount} events recorded{hasMore && ` · showing ${visibleCount}`}
          </p>
        </div>
        {(logs?.length ?? 0) > 0 && (
          <button
            onClick={() => clearActivityLog()}
            className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground hover:text-destructive transition-colors"
          >
            Clear Log
          </button>
        )}
      </div>

      {/* Feed */}
      {visibleLogs && visibleLogs.length > 0 ? (
        <div className="relative">
          <div className="absolute left-4 top-0 bottom-0 w-[1px] bg-muted-foreground/20" />
          <div className="space-y-6 relative">
            {visibleLogs.map((log, i) => {
              const config = ACTION_CONFIG[log.action] ?? { icon: 'info', color: '#484847' }
              const dateStr = new Date(log.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              const timeStr = new Date(log.createdAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

              return (
                <div key={log.id ?? i} className="flex gap-6 items-start">
                  <div className="relative z-10">
                    <div
                      className="w-8 h-8 bg-background flex items-center justify-center"
                      style={{ border: `1px solid ${config.color}`, boxShadow: `0 0 8px ${config.color}1A` }}
                    >
                      <span className="material-symbols-outlined text-sm" style={{ color: config.color }}>{config.icon}</span>
                    </div>
                  </div>
                  <div className={`flex-1 ${i < visibleLogs.length - 1 ? 'pb-4 border-b border-muted-foreground/10' : ''}`}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-bold tracking-tight uppercase text-sm">{log.title}</span>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-[9px] text-muted-foreground/60">{formatTimeAgo(log.createdAt)}</span>
                        <span className="text-[10px] text-muted-foreground font-mono uppercase">{dateStr} {timeStr}</span>
                      </div>
                    </div>
                    {log.detail && (
                      <div className="text-muted-foreground mb-2">
                        <MarkdownRenderer content={log.detail} compact />
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest"
                        style={{ backgroundColor: `${config.color}1A`, color: config.color }}
                      >
                        {log.action.replace(/_/g, ' ')}
                      </span>
                      {log.entityType && (
                        <span className="text-[9px] text-muted-foreground uppercase tracking-widest">
                          {log.entityType}{log.entityId ? ` #${log.entityId}` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Sentinel for infinite scroll */}
          <div ref={sentinelRef} className="h-1" />
          {hasMore && (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <span className="material-symbols-outlined text-sm animate-pulse">more_horiz</span>
              <span className="text-[10px] uppercase tracking-widest font-bold">
                Loading more · {totalCount - visibleCount} remaining
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-16">
          <span className="material-symbols-outlined text-5xl text-muted-foreground/30 mb-4 block">monitoring</span>
          <p className="text-xs text-muted-foreground uppercase tracking-widest">
            No activity recorded yet. Start working to see events here.
          </p>
        </div>
      )}
    </div>
  )
}
