import { Button } from "@/components/ui/button"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, PauseIcon, PlayIcon, TimerIcon } from "lucide-react"
import { formatDuration, getTaskSessionTotalSeconds, sessionDurationSeconds } from "@/lib/live-mappers"
import { type Task } from "@/lib/workspace-view"
import { type TaskflowTaskStatus } from "@/api/client"
import { type TaskflowWorkspace } from "@/lib/taskflow-api"
import { useEffect, useMemo, useState } from "react"


export function TaskSessionDock({
  tasks,
  liveWorkspace,
  onOpenTask,
  onStartSession,
  onPauseSession,
  onStopSession,
}: {
  tasks: Task[]
  liveWorkspace?: TaskflowWorkspace | null
  onOpenTask: (taskId: string) => void
  onStartSession: (task: Task) => void
  onPauseSession: (task: Task) => void
  onStopSession: (task: Task, finalStatus: Extract<TaskflowTaskStatus, "done" | "partial_done" | "blocked">) => void
}) {
  const [tick, setTick] = useState(0)
  // #35: minimized by default so the dock never covers the chat input / terminal
  // keypad at the bottom; expand to see and control sessions.
  const [expanded, setExpanded] = useState(false)
  const taskById = useMemo(() => new Map(tasks.map((task) => [Number(task.id), task])), [tasks])
  const runningSessions = liveWorkspace
    ? liveWorkspace.taskSessions
        .filter((session) => session.state === "running" && !session.ended_at)
        .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
    : []
  const runningTaskIds = new Set(runningSessions.map((session) => session.task))
  const pausedTasks = liveWorkspace
    ? liveWorkspace.tasks
        .filter((task) => task.status === "paused" && !runningTaskIds.has(task.id))
        .map((task) => taskById.get(task.id))
        .filter((task): task is Task => Boolean(task))
    : []

  useEffect(() => {
    if (!runningSessions.length) return
    const interval = window.setInterval(() => setTick((current) => current + 1), 1000)
    return () => window.clearInterval(interval)
  }, [runningSessions.length])

  const sessionCount = runningSessions.length + pausedTasks.length
  if (!liveWorkspace || sessionCount === 0) return null

  // Minimized: a compact pill in the corner so it never overlaps the chat input
  // or terminal keypad (which live at the bottom-center). Click to expand.
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title="Show active sessions"
        className="fixed bottom-3 right-3 z-[65] inline-flex items-center gap-2 rounded-full border bg-background/95 px-3 py-2 text-xs font-medium shadow-lg backdrop-blur transition hover:bg-muted"
      >
        <TimerIcon className="size-4 text-primary" />
        {runningSessions.length ? (
          <span className="inline-block size-2 animate-pulse rounded-full bg-emerald-500" />
        ) : null}
        {sessionCount} session{sessionCount === 1 ? "" : "s"}
        <ChevronUpIcon className="size-3.5 text-muted-foreground" />
      </button>
    )
  }

  return (
    <section className="fixed bottom-3 right-3 z-[65] flex max-h-[60vh] w-[min(30rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-background/95 shadow-2xl backdrop-blur">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <TimerIcon className="size-4 text-primary" />
          Sessions ({sessionCount})
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setExpanded(false)}
          title="Minimize"
          aria-label="Minimize sessions"
        >
          <ChevronDownIcon />
        </Button>
      </div>
      <div className="scrollbar-y flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {runningSessions.map((session) => {
          const task = taskById.get(session.task)
          if (!task) return null
          void tick
          return (
            <div key={session.id} className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenTask(task.id)}>
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_oklch(0.72_0.14_155_/_0.16)]" />
                  <p className="truncate text-sm font-medium">{task.title}</p>
                </div>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {formatDuration(sessionDurationSeconds(session))} running
                </p>
              </button>
              <Button variant="ghost" size="icon-sm" onClick={() => onPauseSession(task)}>
                <PauseIcon />
              </Button>
              <Button size="icon-sm" onClick={() => onStopSession(task, "done")}>
                <CheckIcon />
              </Button>
            </div>
          )
        })}
        {pausedTasks.map((task) => (
          <div key={task.id} className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2 opacity-85">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenTask(task.id)}>
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-amber-500" />
                <p className="truncate text-sm font-medium">{task.title}</p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDuration(getTaskSessionTotalSeconds(task, liveWorkspace))} paused
              </p>
            </button>
            <Button size="icon-sm" onClick={() => onStartSession(task)}>
              <PlayIcon />
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}
