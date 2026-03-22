import { useState, useMemo, useRef, useEffect } from 'react'
import { useActiveSessions, useTaskTotalTime } from '@/hooks/use-sessions'
import { useTasks } from '@/hooks/use-tasks'
import { useTask } from '@/hooks/use-tasks'
import { useTimer } from '@/hooks/use-timer'
import { useSetting, updateSetting } from '@/hooks/use-settings'
import { formatDuration } from '@/lib/time'
import type { Session, Task } from '@/types'

// Row for an active (running) session — shows live elapsed time + pause button
function ActiveRow({
  session,
  tick,
  pauseTask,
}: {
  session: Session
  tick: number
  pauseTask: (task: Task) => Promise<void>
}) {
  const task = useTask(session.taskId)

  // eslint-disable-next-line react-hooks/purity
  const elapsed = useMemo(() => Date.now() - session.start.getTime(), [tick, session.start])

  return (
    <div className="flex items-center gap-3 px-4 py-2 min-w-0">
      <span className="material-symbols-outlined text-tertiary text-lg shrink-0 pulse-active">
        play_arrow
      </span>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="text-[10px] uppercase tracking-widest text-foreground truncate max-w-[200px]">
          {task?.title ?? 'Loading…'}
        </span>
        <span className="text-tertiary font-bold text-xl tracking-tighter drop-shadow-[0_0_8px_rgba(105,253,93,0.5)] tabular-nums shrink-0">
          {formatDuration(elapsed)}
        </span>
      </div>
      <button
        onClick={() => task && pauseTask(task)}
        className="shrink-0 p-1.5 hover:bg-muted transition-colors"
        aria-label={`Pause ${task?.title ?? 'task'}`}
      >
        <span className="material-symbols-outlined text-muted-foreground text-lg">
          pause
        </span>
      </button>
    </div>
  )
}

// Row for a paused task — shows accumulated time + play button
function PausedRow({
  task,
  tick,
  startTask,
}: {
  task: Task
  tick: number
  startTask: (task: Task) => Promise<void>
}) {
  const totalTime = useTaskTotalTime(task.id, tick)

  return (
    <div className="flex items-center gap-3 px-4 py-2 min-w-0 opacity-60 hover:opacity-100 transition-opacity">
      <span className="material-symbols-outlined text-primary text-lg shrink-0">
        pause
      </span>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground truncate max-w-[200px]">
          {task.title}
        </span>
        <span className="text-muted-foreground font-bold text-xl tracking-tighter tabular-nums shrink-0">
          {formatDuration(totalTime)}
        </span>
      </div>
      <button
        onClick={() => startTask(task)}
        className="shrink-0 p-1.5 hover:bg-muted transition-colors"
        aria-label={`Resume ${task.title}`}
      >
        <span className="material-symbols-outlined text-tertiary text-lg">
          play_arrow
        </span>
      </button>
    </div>
  )
}

// Union type for items displayed in the timer bar
type TimerItem =
  | { kind: 'active'; session: Session }
  | { kind: 'paused'; task: Task }

export function FloatingTimerBar() {
  const activeSessions = useActiveSessions()
  const allTasks = useTasks()
  const hasActive = !!activeSessions && activeSessions.length > 0
  const { tick, pauseTask, startTask } = useTimer(hasActive)
  const displayMode = useSetting('timerBarDisplayMode')
  const [currentIndex, setCurrentIndex] = useState(0)
  const barRef = useRef<HTMLDivElement>(null)

  // Build combined list: active sessions + paused tasks
  const items: TimerItem[] = useMemo(() => {
    const result: TimerItem[] = []

    // Active sessions first
    if (activeSessions) {
      for (const session of activeSessions) {
        result.push({ kind: 'active', session })
      }
    }

    // Paused tasks (exclude any that somehow have an active session)
    if (allTasks) {
      const activeTaskIds = new Set(activeSessions?.map(s => s.taskId) ?? [])
      for (const task of allTasks) {
        if (task.status === 'paused' && task.id !== undefined && !activeTaskIds.has(task.id)) {
          result.push({ kind: 'paused', task })
        }
      }
    }

    return result
  }, [activeSessions, allTasks])

  // Set CSS variable so layout can account for timer bar height
  useEffect(() => {
    const updateHeight = () => {
      const h = barRef.current?.offsetHeight ?? 0
      document.documentElement.style.setProperty('--timer-bar-height', `${h}px`)
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    if (barRef.current) observer.observe(barRef.current)
    return () => {
      observer.disconnect()
      document.documentElement.style.setProperty('--timer-bar-height', '0px')
    }
  }, [items.length, displayMode])

  if (items.length === 0) return null

  const total = items.length
  const safeIndex = currentIndex >= total ? 0 : currentIndex

  const cycleLeft = () => setCurrentIndex((safeIndex - 1 + total) % total)
  const cycleRight = () => setCurrentIndex((safeIndex + 1) % total)

  const toggleMode = () => {
    const newMode = displayMode === 'carousel' ? 'expanded' : 'carousel'
    void updateSetting('timerBarDisplayMode', newMode)
  }

  const activeCount = items.filter(i => i.kind === 'active').length
  const pausedCount = items.filter(i => i.kind === 'paused').length

  function renderItem(item: TimerItem) {
    if (item.kind === 'active') {
      return (
        <ActiveRow
          key={`active-${item.session.id}`}
          session={item.session}
          tick={tick}
          pauseTask={pauseTask}
        />
      )
    }
    return (
      <PausedRow
        key={`paused-${item.task.id}`}
        task={item.task}
        tick={tick}
        startTask={startTask}
      />
    )
  }

  return (
    <div
      ref={barRef}
      className="fixed bottom-0 left-0 w-full z-50 bg-background/80 backdrop-blur-xl border-t border-tertiary/30 shadow-[0_-4px_20px_rgba(105,253,93,0.08)]"
    >
      {displayMode === 'carousel' ? (
        <div className="flex items-center justify-center gap-2 py-1">
          {total > 1 && (
            <button
              onClick={cycleLeft}
              className="p-1.5 hover:bg-muted transition-colors"
              aria-label="Previous item"
            >
              <span className="material-symbols-outlined text-muted-foreground text-lg">
                chevron_left
              </span>
            </button>
          )}

          {renderItem(items[safeIndex])}

          {total > 1 && (
            <button
              onClick={cycleRight}
              className="p-1.5 hover:bg-muted transition-colors"
              aria-label="Next item"
            >
              <span className="material-symbols-outlined text-muted-foreground text-lg">
                chevron_right
              </span>
            </button>
          )}

          {total > 1 && (
            <span className="text-[10px] text-muted-foreground tracking-widest tabular-nums">
              ({safeIndex + 1}/{total})
            </span>
          )}

          <button
            onClick={toggleMode}
            className="p-1.5 hover:bg-muted transition-colors ml-2"
            aria-label="Switch to expanded mode"
          >
            <span className="material-symbols-outlined text-muted-foreground text-lg">
              unfold_more
            </span>
          </button>
        </div>
      ) : (
        <div className="py-1">
          <div className="flex items-center justify-between px-4 pb-1">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {activeCount > 0 && `${activeCount} active`}
              {activeCount > 0 && pausedCount > 0 && ' · '}
              {pausedCount > 0 && `${pausedCount} paused`}
            </span>
            <button
              onClick={toggleMode}
              className="p-1.5 hover:bg-muted transition-colors"
              aria-label="Switch to carousel mode"
            >
              <span className="material-symbols-outlined text-muted-foreground text-lg">
                unfold_less
              </span>
            </button>
          </div>
          {items.map(renderItem)}
        </div>
      )}
    </div>
  )
}
