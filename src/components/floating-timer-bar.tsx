import { useState, useMemo } from 'react'
import { useActiveSessions } from '@/hooks/use-sessions'
import { useTask } from '@/hooks/use-tasks'
import { useTimer } from '@/hooks/use-timer'
import { useSetting, updateSetting } from '@/hooks/use-settings'
import { formatDuration } from '@/lib/time'
import type { Session, Task } from '@/types'

function SessionRow({
  session,
  tick,
  pauseTask,
}: {
  session: Session
  tick: number
  pauseTask: (task: Task) => Promise<void>
}) {
  const task = useTask(session.taskId)

  // Recalculate on each tick: Date.now() is intentionally impure here (driven by tick)
  // eslint-disable-next-line react-hooks/purity
  const elapsed = useMemo(() => Date.now() - session.start.getTime(), [tick, session.start])

  return (
    <div className="flex items-center gap-3 px-4 py-2 min-w-0">
      <span className="material-symbols-outlined text-tertiary text-lg shrink-0">
        play_arrow
      </span>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="text-[10px] uppercase tracking-widest text-on-surface-variant truncate max-w-[200px]">
          {task?.title ?? 'Loading…'}
        </span>
        <span className="text-tertiary font-bold text-2xl tracking-tighter drop-shadow-[0_0_8px_rgba(105,253,93,0.5)] tabular-nums shrink-0">
          {formatDuration(elapsed)}
        </span>
      </div>
      <button
        onClick={() => task && pauseTask(task)}
        className="shrink-0 p-1.5 rounded hover:bg-surface-variant/50 transition-colors"
        aria-label={`Pause ${task?.title ?? 'task'}`}
      >
        <span className="material-symbols-outlined text-on-surface-variant text-lg">
          pause
        </span>
      </button>
    </div>
  )
}

export function FloatingTimerBar() {
  const activeSessions = useActiveSessions()
  const hasActive = !!activeSessions && activeSessions.length > 0
  const { tick, pauseTask } = useTimer(hasActive)
  const displayMode = useSetting('timerBarDisplayMode')
  const [currentIndex, setCurrentIndex] = useState(0)

  if (!activeSessions || activeSessions.length === 0) return null

  const total = activeSessions.length

  // Clamp currentIndex if sessions changed
  const safeIndex = currentIndex >= total ? 0 : currentIndex

  const cycleLeft = () => {
    setCurrentIndex((safeIndex - 1 + total) % total)
  }

  const cycleRight = () => {
    setCurrentIndex((safeIndex + 1) % total)
  }

  const toggleMode = () => {
    const newMode = displayMode === 'carousel' ? 'expanded' : 'carousel'
    void updateSetting('timerBarDisplayMode', newMode)
  }

  return (
    <div
      className="fixed bottom-0 left-0 w-full z-50 bg-background/80 backdrop-blur-xl border-t border-tertiary/30 shadow-[0_-4px_20px_rgba(105,253,93,0.08)]"
    >
      {displayMode === 'carousel' ? (
        <div className="flex items-center justify-center gap-2 py-1">
          {total > 1 && (
            <button
              onClick={cycleLeft}
              className="p-1.5 rounded hover:bg-surface-variant/50 transition-colors"
              aria-label="Previous session"
            >
              <span className="material-symbols-outlined text-on-surface-variant text-lg">
                chevron_left
              </span>
            </button>
          )}

          <SessionRow
            session={activeSessions[safeIndex]}
            tick={tick}
            pauseTask={pauseTask}
          />

          {total > 1 && (
            <button
              onClick={cycleRight}
              className="p-1.5 rounded hover:bg-surface-variant/50 transition-colors"
              aria-label="Next session"
            >
              <span className="material-symbols-outlined text-on-surface-variant text-lg">
                chevron_right
              </span>
            </button>
          )}

          {total > 1 && (
            <span className="text-[10px] text-on-surface-variant tracking-widest tabular-nums">
              ({safeIndex + 1}/{total})
            </span>
          )}

          <button
            onClick={toggleMode}
            className="p-1.5 rounded hover:bg-surface-variant/50 transition-colors ml-2"
            aria-label="Switch to expanded mode"
          >
            <span className="material-symbols-outlined text-on-surface-variant text-lg">
              unfold_more
            </span>
          </button>
        </div>
      ) : (
        <div className="py-1">
          <div className="flex items-center justify-between px-4 pb-1">
            <span className="text-[10px] uppercase tracking-widest text-on-surface-variant">
              Active Sessions ({total})
            </span>
            <button
              onClick={toggleMode}
              className="p-1.5 rounded hover:bg-surface-variant/50 transition-colors"
              aria-label="Switch to carousel mode"
            >
              <span className="material-symbols-outlined text-on-surface-variant text-lg">
                unfold_less
              </span>
            </button>
          </div>
          {activeSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              tick={tick}
              pauseTask={pauseTask}
            />
          ))}
        </div>
      )}
    </div>
  )
}
