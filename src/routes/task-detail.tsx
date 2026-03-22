import { useState } from 'react'
import { useParams, Link } from 'react-router'
import { useTask, useTasks } from '@/hooks/use-tasks'
import { useProject } from '@/hooks/use-projects'
import { useSessions, useTaskTotalTime, useActiveSessions } from '@/hooks/use-sessions'
import { useTimer } from '@/hooks/use-timer'
import { getBlockers, getDependents } from '@/lib/dag'
import { canTransition } from '@/lib/status'
import { formatDuration, computeSessionDuration, formatHumanDuration, msToMinutes, minutesToMs } from '@/lib/time'
import { StatusBadge } from '@/components/status-badge'
import { PriorityBadge } from '@/components/priority-badge'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { MarkdownEditor } from '@/components/markdown-editor'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { db } from '@/db/database'
import type { Task, TaskStatus } from '@/types'

const ALL_STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'paused', 'blocked', 'partial_done', 'done']

export default function TaskDetail() {
  const { id } = useParams()
  const taskId = id ? Number(id) : undefined
  const task = useTask(taskId)
  const project = useProject(task?.projectId)
  const sessions = useSessions(taskId)
  const allTasks = useTasks()
  const activeSessions = useActiveSessions()

  const hasActive = activeSessions?.some(s => s.taskId === taskId) ?? false
  const { tick, startTask, pauseTask, stopTask } = useTimer(hasActive)
  const totalTime = useTaskTotalTime(taskId, tick)

  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState('')
  const [showStopOptions, setShowStopOptions] = useState(false)
  const [linkInput, setLinkInput] = useState('')

  const blockers = allTasks && taskId ? getBlockers(allTasks, taskId) : []
  const dependents = allTasks && taskId ? getDependents(allTasks, taskId) : []
  const hasUnresolvedBlockers = blockers.length > 0

  if (task === undefined && taskId !== undefined) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-card w-48" />
          <div className="h-16 bg-card w-96" />
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-20 bg-card" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!task) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold tracking-tighter uppercase">Task Not Found</h1>
        <p className="text-muted-foreground text-sm mt-2">
          The task you are looking for does not exist.
        </p>
        <Link to="/dashboard" className="text-secondary hover:text-secondary/80 text-sm mt-4 inline-block">
          Return to Dashboard
        </Link>
      </div>
    )
  }

  const handleEditToggle = () => {
    if (!editing) {
      setDescription(task.description ?? '')
    }
    setEditing(!editing)
  }

  const handleSaveDescription = async () => {
    await db.tasks.update(task.id!, { description, updatedAt: new Date() })
    setEditing(false)
  }

  const handleStart = async () => {
    if (hasUnresolvedBlockers) return
    await startTask(task)
  }

  const handlePause = async () => {
    await pauseTask(task)
  }

  const handleStop = async (finalStatus: 'done' | 'partial_done') => {
    await stopTask(task, finalStatus)
    setShowStopOptions(false)
  }

  const handleStatusChange = async (newStatus: TaskStatus) => {
    if (!canTransition(task.status, newStatus)) return

    // Close any active session when moving to done or partial_done
    if (newStatus === 'done' || newStatus === 'partial_done') {
      const activeSession = await db.sessions
        .where('taskId')
        .equals(task.id!)
        .filter(s => s.end === undefined)
        .first()
      if (activeSession) {
        await db.sessions.update(activeSession.id!, { end: new Date() })
      }
    }

    await db.tasks.update(task.id!, { status: newStatus, updatedAt: new Date() })
  }

  const handleAddLink = async () => {
    if (!linkInput.trim()) return
    const currentLinks = task.links ?? []
    await db.tasks.update(task.id!, {
      links: [...currentLinks, linkInput.trim()],
      updatedAt: new Date(),
    })
    setLinkInput('')
  }

  const formatDate = (date?: Date) => {
    if (!date) return 'Not set'
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).toUpperCase()
  }

  const formatSessionTime = (date: Date) => {
    return new Date(date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="pb-32">
      <main className="pt-8 px-6 max-w-7xl mx-auto grid grid-cols-12 gap-8">
        {/* Hero Section */}
        <section className="col-span-12 lg:col-span-8 flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            <span className="text-muted-foreground text-[10px] tracking-widest uppercase ml-auto">
              TASK-{task.id}
            </span>
          </div>

          <h1 className="text-5xl md:text-6xl font-bold tracking-tighter leading-none max-w-3xl">
            {task.title}
          </h1>

          {/* Status Selector */}
          <div className="flex items-center gap-4">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
              Update_Status
            </span>
            <Select value={task.status} onValueChange={(v) => handleStatusChange(v as TaskStatus)}>
              <SelectTrigger className="w-48 bg-card border border-border text-xs tracking-widest uppercase">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_STATUSES.map(s => {
                  const allowed = s === task.status || canTransition(task.status, s)
                  return (
                    <SelectItem
                      key={s}
                      value={s}
                      disabled={!allowed}
                      className="text-xs uppercase tracking-widest"
                    >
                      {s.replace(/_/g, ' ')}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Metadata Grid */}
          <div className="space-y-4 mt-4">
            {/* Row 1: Project & Priority */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-card p-4 border-t-2 border-primary/20">
                <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                  Project
                </span>
                <div className="flex items-center gap-2">
                  {project && (
                    <span
                      className="w-2 h-2 inline-block"
                      style={{ backgroundColor: project.color }}
                    />
                  )}
                  <span className="text-sm font-medium">
                    {project?.name ?? 'Unassigned'}
                  </span>
                </div>
              </div>

              <div className="bg-card p-4 border-t-2 border-outline-variant">
                <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                  Priority
                </span>
                <span className="text-sm font-medium capitalize">{task.priority}</span>
              </div>
            </div>

            {/* Row 2: Due Date & Estimation */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-card p-4 border-t-2 border-secondary/20">
                <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                  Due Date
                </span>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-start text-left font-medium text-sm p-0 h-auto hover:bg-transparent hover:text-secondary"
                    >
                      <span className="material-symbols-outlined text-sm mr-2 text-muted-foreground">calendar_today</span>
                      {task.dueDate ? formatDate(task.dueDate) : 'Set due date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={task.dueDate ? new Date(task.dueDate) : undefined}
                      onSelect={async (date) => {
                        await db.tasks.update(task.id!, { dueDate: date ?? undefined, updatedAt: new Date() })
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="bg-card p-4 border-t-2 border-tertiary/20">
                <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                  Estimation
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    value={task.estimatedTime ? msToMinutes(task.estimatedTime) : ''}
                    onChange={async (e) => {
                      const mins = e.target.value ? Number(e.target.value) : 0
                      await db.tasks.update(task.id!, {
                        estimatedTime: mins > 0 ? minutesToMs(mins) : undefined,
                        updatedAt: new Date(),
                      })
                    }}
                    placeholder="0"
                    className="w-20 bg-transparent border-0 border-b border-border focus:border-secondary focus:ring-0 text-sm py-1 px-2 tabular-nums"
                  />
                  <span className="text-[10px] text-muted-foreground uppercase tracking-widest">mins</span>
                  {task.estimatedTime && task.estimatedTime > 0 && (
                    <span className="text-xs text-secondary font-bold ml-auto">
                      {formatHumanDuration(task.estimatedTime)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Description Section */}
          <div className="mt-8">
            <div className="flex items-center gap-4 mb-4">
              <h2 className="text-lg font-bold tracking-tight uppercase">Technical Specifications</h2>
              <div className="h-px flex-1 bg-outline-variant" />
              <button
                onClick={editing ? handleSaveDescription : handleEditToggle}
                className="text-[10px] uppercase tracking-widest font-bold px-3 py-1 bg-surface-variant text-muted-foreground hover:text-foreground transition-colors"
              >
                {editing ? 'Save' : 'Edit'}
              </button>
              {editing && (
                <button
                  onClick={() => setEditing(false)}
                  className="text-[10px] uppercase tracking-widest font-bold px-3 py-1 text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
            <div className="bg-surface-container-high p-8 border-l border-secondary/20">
              {editing ? (
                <MarkdownEditor
                  value={description}
                  onChange={setDescription}
                  placeholder="Describe the task requirements..."
                  rows={8}
                />
              ) : (
                task.description ? (
                  <MarkdownRenderer content={task.description} />
                ) : (
                  <p className="text-muted-foreground/50 italic text-sm">No description provided.</p>
                )
              )}
            </div>
          </div>

          {/* Dependencies Section */}
          {(blockers.length > 0 || dependents.length > 0) && (
            <div className="mt-8">
              <div className="flex items-center gap-4 mb-4">
                <h2 className="text-lg font-bold tracking-tight uppercase">Graph Dependencies</h2>
                <div className="h-px flex-1 bg-outline-variant" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {dependents.map((dep: Task) => (
                  <Link
                    key={dep.id}
                    to={`/tasks/${dep.id}`}
                    className="bg-card p-4 flex items-center justify-between border-l-2 border-destructive hover:bg-surface-variant transition-colors"
                  >
                    <div>
                      <span className="block text-[9px] uppercase tracking-widest text-destructive font-bold">
                        Blocking
                      </span>
                      <span className="text-sm">{dep.title}</span>
                    </div>
                    <span className="text-muted-foreground">&#8594;</span>
                  </Link>
                ))}
                {blockers.map((blocker: Task) => (
                  <Link
                    key={blocker.id}
                    to={`/tasks/${blocker.id}`}
                    className="bg-card p-4 flex items-center justify-between border-l-2 border-secondary hover:bg-surface-variant transition-colors"
                  >
                    <div>
                      <span className="block text-[9px] uppercase tracking-widest text-secondary font-bold">
                        Blocked By
                      </span>
                      <span className="text-sm">{blocker.title}</span>
                    </div>
                    <span className="text-muted-foreground">&#128274;</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* External Links */}
          <div className="mt-8">
            <div className="flex items-center gap-4 mb-4">
              <h2 className="text-lg font-bold tracking-tight uppercase">External Links</h2>
              <div className="h-px flex-1 bg-outline-variant" />
            </div>
            <div className="space-y-2">
              {task.links?.map((link, i) => (
                <a
                  key={i}
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-sm text-secondary hover:text-secondary/80 underline truncate"
                >
                  {link}
                </a>
              ))}
              <div className="flex gap-2 mt-3">
                <input
                  type="url"
                  value={linkInput}
                  onChange={(e) => setLinkInput(e.target.value)}
                  placeholder="https://..."
                  className="flex-1 bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-sm py-2 px-2 placeholder:text-muted-foreground/30 placeholder:text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddLink()}
                />
                <button
                  onClick={handleAddLink}
                  className="text-[10px] uppercase tracking-widest font-bold px-3 py-1 bg-surface-variant text-muted-foreground hover:text-foreground transition-colors"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Right Sidebar */}
        <aside className="col-span-12 lg:col-span-4 flex flex-col gap-8">
          {/* Session Timeline */}
          <div className="bg-surface-container-high p-6 border-t border-primary/20 h-fit">
            <h3 className="text-xs font-bold tracking-widest uppercase mb-6 text-primary">
              Session Timeline
            </h3>
            {sessions && sessions.length > 0 ? (
              <div className="space-y-8 relative before:absolute before:left-2 before:top-2 before:bottom-2 before:w-px before:bg-outline-variant">
                {[...sessions].reverse().map((session) => {
                  const isActive = !session.end
                  const duration = computeSessionDuration(session)
                  return (
                    <div key={session.id} className="relative pl-8">
                      <div
                        className="absolute left-0 top-1 w-4 h-4 bg-background border-2"
                        style={{
                          borderColor: isActive ? 'var(--color-secondary)' : 'var(--color-tertiary)',
                        }}
                      />
                      <span
                        className="block text-[10px] uppercase tracking-widest mb-1"
                        style={{
                          color: isActive ? 'var(--color-secondary)' : 'var(--color-muted-foreground)',
                        }}
                      >
                        {formatSessionTime(session.start)}
                      </span>
                      <p className="text-sm font-medium">
                        {isActive ? 'Active session' : 'Completed session'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Duration: {formatDuration(duration)}
                      </p>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-muted-foreground/50 text-sm italic">No sessions recorded yet.</p>
            )}
          </div>

          {/* Tags */}
          {task.tags && task.tags.length > 0 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
                Metadata Tags
              </h3>
              <div className="flex flex-wrap gap-2">
                {task.tags.map((tag, i) => (
                  <span
                    key={i}
                    className="px-3 py-1 bg-surface-container-high border border-outline-variant text-[10px] uppercase tracking-tighter"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Total Time */}
          <div className="bg-surface-container-high p-6 border-t border-tertiary/20">
            <h3 className="text-xs font-bold tracking-widest uppercase mb-3 text-tertiary">
              Total Time
            </h3>
            <span className="text-3xl font-bold tracking-tighter font-mono">
              {formatDuration(totalTime)}
            </span>
          </div>
        </aside>
      </main>

      {/* Bottom Action Bar */}
      <div
        className="fixed left-1/2 -translate-x-1/2 z-40 w-[90%] max-w-2xl bg-card/80 backdrop-blur-xl border border-tertiary/30 shadow-[0_0_20px_rgba(105,253,93,0.1)] py-4 px-8 flex justify-around items-center"
        style={{ bottom: 'calc(0.5rem + var(--timer-bar-height, 0px))' }}
      >
        {hasUnresolvedBlockers && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-widest text-destructive font-bold bg-card/90 px-3 py-1 border border-destructive/30">
            Blocked by {blockers.length} task{blockers.length > 1 ? 's' : ''}
          </div>
        )}

        {/* Play */}
        <button
          onClick={handleStart}
          disabled={hasUnresolvedBlockers || task.status === 'in_progress' || task.status === 'done'}
          className="flex flex-col items-center gap-1 group disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <span className="text-2xl text-muted-foreground group-hover:text-tertiary transition-transform active:scale-90">
            &#9654;
          </span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground group-hover:text-tertiary">
            Play
          </span>
        </button>

        <div className="h-8 w-px bg-outline-variant/30" />

        {/* Pause */}
        <button
          onClick={handlePause}
          disabled={task.status !== 'in_progress'}
          className="flex flex-col items-center gap-1 group disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <span className="text-2xl text-muted-foreground group-hover:text-primary transition-transform active:scale-90">
            &#9208;
          </span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground group-hover:text-primary">
            Pause
          </span>
        </button>

        <div className="h-8 w-px bg-outline-variant/30" />

        {/* Stop */}
        <div className="relative">
          <button
            onClick={() => setShowStopOptions(!showStopOptions)}
            disabled={task.status !== 'in_progress' && task.status !== 'paused'}
            className="flex flex-col items-center gap-1 group disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <span className="text-2xl text-muted-foreground group-hover:text-destructive transition-transform active:scale-90">
              &#9632;
            </span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground group-hover:text-destructive">
              Stop
            </span>
          </button>

          {showStopOptions && (
            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-card border border-border shadow-lg p-2 flex flex-col gap-1 min-w-[140px]">
              <button
                onClick={() => handleStop('done')}
                className="text-[10px] uppercase tracking-widest font-bold px-3 py-2 text-tertiary hover:bg-surface-variant transition-colors text-left"
              >
                Mark Done
              </button>
              <button
                onClick={() => handleStop('partial_done')}
                className="text-[10px] uppercase tracking-widest font-bold px-3 py-2 text-primary hover:bg-surface-variant transition-colors text-left"
              >
                Partial Done
              </button>
            </div>
          )}
        </div>

        <div className="h-8 w-px bg-outline-variant/30" />

        {/* Timer display */}
        <div className="flex flex-col items-center gap-1">
          <span className="text-lg font-bold tracking-tighter font-mono text-tertiary">
            {formatDuration(totalTime)}
          </span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Elapsed
          </span>
        </div>
      </div>
    </div>
  )
}
