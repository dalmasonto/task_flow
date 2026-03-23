import { useState } from 'react'
import { useParams, Link } from 'react-router'
import { useTask, useTasks } from '@/hooks/use-tasks'
import { useProject, useProjects } from '@/hooks/use-projects'
import { useSessions, useTaskTotalTime, useActiveSessions } from '@/hooks/use-sessions'
import { useTimer } from '@/hooks/use-timer'
import { getBlockers, getDependents } from '@/lib/dag'
import { canTransition } from '@/lib/status'
import { formatDuration, formatSmartDuration, computeSessionDuration, formatHumanDuration, msToMinutes, minutesToMs } from '@/lib/time'
import { StatusBadge } from '@/components/status-badge'
import { PriorityBadge } from '@/components/priority-badge'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { MarkdownEditor } from '@/components/markdown-editor'
import { DependencyPicker } from '@/components/dependency-picker'
import { hasCycle } from '@/lib/dag'
import { syncTaskUpdate } from '@/lib/sync-api'
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
import { toast } from 'sonner'
import { db } from '@/db/database'
import { playSuccess, playTimerStart, playTimerPause, playTaskDone, playClick, playError } from '@/lib/sounds'
import { addNotification } from '@/hooks/use-app-notifications'
import { logActivity, useTaskActivityLog } from '@/hooks/use-activity-log'
import type { Task, TaskStatus, TaskPriority } from '@/types'

const ALL_STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'paused', 'blocked', 'partial_done', 'done']
const ALL_PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'critical']

export default function TaskDetail() {
  const { id } = useParams()
  const taskId = id ? Number(id) : undefined
  const task = useTask(taskId)
  const project = useProject(task?.projectId)
  const allProjects = useProjects()
  const sessions = useSessions(taskId)
  const allTasks = useTasks()
  const activeSessions = useActiveSessions()

  const hasActive = activeSessions?.some(s => s.taskId === taskId) ?? false
  const { tick, startTask, pauseTask, stopTask } = useTimer(hasActive)
  const totalTime = useTaskTotalTime(taskId, tick)

  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState('')
  const [showStopOptions, setShowStopOptions] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [linkLabel, setLinkLabel] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [tagInput, setTagInput] = useState('')

  const taskLogs = useTaskActivityLog(taskId)
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
    syncTaskUpdate(task.id!, { description })
    setEditing(false)
    playClick()
    toast.success('Description updated')
  }

  const handleStart = async () => {
    if (hasUnresolvedBlockers) return
    await startTask(task)
    playTimerStart()
    toast.success('Timer started')
    addNotification('Timer Started', `Started working on: ${task.title}`, 'info')
    logActivity('timer_started', `Started: ${task.title}`, { entityType: 'task', entityId: task.id })
  }

  const handlePause = async () => {
    await pauseTask(task)
    playTimerPause()
    toast.info('Timer paused')
    addNotification('Timer Paused', `Paused: ${task.title}`, 'info')
    logActivity('timer_paused', `Paused: ${task.title}`, { entityType: 'task', entityId: task.id })
  }

  const handleStop = async (finalStatus: 'done' | 'partial_done') => {
    await stopTask(task, finalStatus)
    setShowStopOptions(false)
    if (finalStatus === 'done') {
      playTaskDone()
      toast.success('Task completed!')
      addNotification('Task Completed', `Finished: ${task.title}`, 'success')
      logActivity('task_completed', `Completed: ${task.title}`, { entityType: 'task', entityId: task.id })
    } else {
      playSuccess()
      toast.info('Task marked as partial done')
      addNotification('Partial Completion', `Progress on: ${task.title}`, 'info')
      logActivity('task_partial_done', `Partial done: ${task.title}`, { entityType: 'task', entityId: task.id })
    }
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

    // Auto-start a session when moving to in_progress
    if (newStatus === 'in_progress') {
      const alreadyActive = await db.sessions
        .where('taskId')
        .equals(task.id!)
        .filter(s => s.end === undefined)
        .first()
      if (!alreadyActive) {
        await db.sessions.add({ taskId: task.id!, start: new Date() })
      }
    }

    await db.tasks.update(task.id!, { status: newStatus, updatedAt: new Date() })
    syncTaskUpdate(task.id!, { status: newStatus })

    if (newStatus === 'done') {
      playTaskDone()
      toast.success('Task completed!')
      addNotification('Task Completed', `Finished: ${task.title}`, 'success')
      logActivity('task_completed', `Completed: ${task.title}`, { entityType: 'task', entityId: task.id })
    } else if (newStatus === 'partial_done') {
      playSuccess()
      toast.info('Task marked as partial done')
      addNotification('Partial Completion', `Progress on: ${task.title}`, 'info')
      logActivity('task_partial_done', `Partial done: ${task.title}`, { entityType: 'task', entityId: task.id })
    } else {
      playClick()
      toast(`Status updated to ${newStatus.replace(/_/g, ' ')}`)
      addNotification('Status Changed', `${task.title} → ${newStatus.replace(/_/g, ' ')}`, 'info')
      logActivity('task_status_changed', `${task.title} → ${newStatus.replace(/_/g, ' ')}`, { entityType: 'task', entityId: task.id, detail: `${task.status} → ${newStatus}` })
    }
  }

  const handleAddLink = async () => {
    if (!linkUrl.trim()) return
    const currentLinks = task.links ?? []
    const newLinks = [...currentLinks, { label: linkLabel.trim() || linkUrl.trim(), url: linkUrl.trim() }]
    await db.tasks.update(task.id!, { links: newLinks, updatedAt: new Date() })
    syncTaskUpdate(task.id!, { links: newLinks })
    logActivity('link_added', `Link added to: ${task.title}`, { entityType: 'task', entityId: task.id, detail: linkUrl.trim() })
    setLinkLabel('')
    setLinkUrl('')
  }

  const handleRemoveLink = async (index: number) => {
    const currentLinks = task.links ?? []
    const newLinks = currentLinks.filter((_, i) => i !== index)
    await db.tasks.update(task.id!, { links: newLinks, updatedAt: new Date() })
    syncTaskUpdate(task.id!, { links: newLinks })
  }

  const formatDate = (date?: Date) => {
    if (!date) return 'Not set'
    const d = new Date(date)
    const datePart = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).toUpperCase()
    const timePart = d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    return `${datePart} ${timePart}`
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
            <StatusBadge status={task.status} task={task} allTasks={allTasks ?? []} />
            <PriorityBadge priority={task.priority} />
            <span className="text-muted-foreground text-[10px] tracking-widest uppercase ml-auto">
              TASK-{task.id}
            </span>
          </div>

          {editingTitle ? (
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={async () => {
                if (titleDraft.trim() && titleDraft.trim() !== task.title) {
                  await db.tasks.update(task.id!, { title: titleDraft.trim(), updatedAt: new Date() })
                  syncTaskUpdate(task.id!, { title: titleDraft.trim() })
                  playClick()
                  toast.success('Title updated')
                }
                setEditingTitle(false)
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditingTitle(false) }}
              autoFocus
              className="text-5xl md:text-6xl font-bold tracking-tighter leading-none max-w-3xl w-full bg-transparent border-0 border-b border-border focus:border-secondary focus:ring-0 p-0"
            />
          ) : (
            <h1
              className="text-5xl md:text-6xl font-bold tracking-tighter leading-none max-w-3xl cursor-pointer hover:text-secondary/80 transition-colors"
              onClick={() => { setTitleDraft(task.title); setEditingTitle(true) }}
              title="Click to edit title"
            >
              {task.title}
            </h1>
          )}

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
                <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                  Project
                </span>
                <Select
                  value={task.projectId !== undefined ? String(task.projectId) : 'none'}
                  onValueChange={async (v) => {
                    const newProjectId = v === 'none' ? undefined : Number(v)
                    await db.tasks.update(task.id!, { projectId: newProjectId, updatedAt: new Date() })
                    syncTaskUpdate(task.id!, { projectId: newProjectId ?? null })
                    playClick()
                    toast(`Project updated`)
                    logActivity('task_linked', `${task.title} → ${v === 'none' ? 'Unassigned' : 'project #' + v}`, { entityType: 'task', entityId: task.id })
                  }}
                >
                  <SelectTrigger className="w-full bg-transparent border-0 p-0 h-auto text-sm font-medium shadow-none">
                    <div className="flex items-center gap-2">
                      {project && (
                        <span className="w-2 h-2 inline-block" style={{ backgroundColor: project.color }} />
                      )}
                      <SelectValue />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="text-xs uppercase tracking-widest">Unassigned</SelectItem>
                    {(allProjects ?? []).map(p => (
                      <SelectItem key={p.id} value={String(p.id)} className="text-xs uppercase tracking-widest">
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="bg-card p-4 border-t-2 border-outline-variant">
                <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                  Priority
                </span>
                <Select
                  value={task.priority}
                  onValueChange={async (v) => {
                    await db.tasks.update(task.id!, { priority: v as TaskPriority, updatedAt: new Date() })
                    syncTaskUpdate(task.id!, { priority: v })
                    playClick()
                    toast(`Priority → ${v}`)
                    logActivity('task_status_changed', `${task.title} priority → ${v}`, { entityType: 'task', entityId: task.id })
                  }}
                >
                  <SelectTrigger className="w-full bg-transparent border-0 p-0 h-auto text-sm font-medium capitalize shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_PRIORITIES.map(p => (
                      <SelectItem key={p} value={p} className="text-xs uppercase tracking-widest">
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                        if (!date) {
                          await db.tasks.update(task.id!, { dueDate: undefined, updatedAt: new Date() })
                          syncTaskUpdate(task.id!, { dueDate: null })
                          return
                        }
                        // Preserve existing time if due date already set
                        const existing = task.dueDate ? new Date(task.dueDate) : null
                        if (existing) {
                          date.setHours(existing.getHours(), existing.getMinutes())
                        }
                        await db.tasks.update(task.id!, { dueDate: date, updatedAt: new Date() })
                        syncTaskUpdate(task.id!, { dueDate: date })
                      }}
                    />
                    <div className="border-t border-border px-4 py-3 flex items-center gap-3">
                      <span className="material-symbols-outlined text-sm text-muted-foreground">schedule</span>
                      <input
                        type="number"
                        min="0"
                        max="23"
                        value={task.dueDate ? new Date(task.dueDate).getHours() : 0}
                        onChange={async (e) => {
                          const d = task.dueDate ? new Date(task.dueDate) : new Date()
                          d.setHours(Number(e.target.value))
                          await db.tasks.update(task.id!, { dueDate: d, updatedAt: new Date() })
                          syncTaskUpdate(task.id!, { dueDate: d })
                        }}
                        className="w-14 bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-sm py-1 px-2 text-center tabular-nums"
                      />
                      <span className="text-muted-foreground text-sm">:</span>
                      <input
                        type="number"
                        min="0"
                        max="59"
                        step="5"
                        value={task.dueDate ? new Date(task.dueDate).getMinutes() : 0}
                        onChange={async (e) => {
                          const d = task.dueDate ? new Date(task.dueDate) : new Date()
                          d.setMinutes(Number(e.target.value))
                          await db.tasks.update(task.id!, { dueDate: d, updatedAt: new Date() })
                          syncTaskUpdate(task.id!, { dueDate: d })
                        }}
                        className="w-14 bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-sm py-1 px-2 text-center tabular-nums"
                      />
                      <span className="text-[10px] text-muted-foreground uppercase tracking-widest ml-auto">HH:MM</span>
                    </div>
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
                      const est = mins > 0 ? minutesToMs(mins) : undefined
                      await db.tasks.update(task.id!, {
                        estimatedTime: est,
                        updatedAt: new Date(),
                      })
                      syncTaskUpdate(task.id!, { estimatedTime: est ?? null })
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
          <div className="mt-8">
            <div className="flex items-center gap-4 mb-4">
              <h2 className="text-lg font-bold tracking-tight uppercase">Graph Dependencies</h2>
              <div className="h-px flex-1 bg-outline-variant" />
            </div>
            {(blockers.length > 0 || dependents.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                {dependents.map((dep: Task) => (
                  <Link
                    key={dep.id}
                    to={`/tasks/${dep.id}`}
                    className="bg-card p-4 flex items-center justify-between border-l-2 border-destructive hover:bg-surface-variant transition-colors"
                  >
                    <div>
                      <span className="block text-[9px] uppercase tracking-widest text-destructive font-bold">Blocking</span>
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
                      <span className="block text-[9px] uppercase tracking-widest text-secondary font-bold">Blocked By</span>
                      <span className="text-sm">{blocker.title}</span>
                    </div>
                    <span className="text-muted-foreground">&#128274;</span>
                  </Link>
                ))}
              </div>
            )}
            <DependencyPicker
              selectedIds={task.dependencies}
              excludeTaskId={task.id}
              onChange={async (newDeps) => {
                if (allTasks) {
                  for (const depId of newDeps) {
                    if (!task.dependencies.includes(depId)) {
                      const tempTask = { ...task, dependencies: newDeps }
                      if (hasCycle([...allTasks.filter(t => t.id !== task.id), tempTask], task.id!, depId)) {
                        playError()
                        toast.error('Adding this dependency would create a cycle')
                        return
                      }
                    }
                  }
                }
                await db.tasks.update(task.id!, { dependencies: newDeps, updatedAt: new Date() })
                syncTaskUpdate(task.id!, { dependencies: newDeps })
                playClick()
                toast.success('Dependencies updated')
                logActivity('dependency_added', `Dependencies updated for: ${task.title}`, { entityType: 'task', entityId: task.id })
              }}
            />
          </div>

          {/* External Links */}
          <div className="mt-8">
            <div className="flex items-center gap-4 mb-4">
              <h2 className="text-lg font-bold tracking-tight uppercase">External Links</h2>
              <div className="h-px flex-1 bg-outline-variant" />
            </div>
            <div className="space-y-2">
              {task.links?.map((link, i) => (
                <div key={i} className="flex items-center gap-3 p-2 bg-accent/30 group">
                  <span className="material-symbols-outlined text-sm text-muted-foreground">link</span>
                  <div className="flex-1 min-w-0">
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-secondary hover:text-secondary/80 underline truncate block"
                    >
                      {link.label}
                    </a>
                    {link.label !== link.url && (
                      <span className="text-[10px] text-muted-foreground truncate block">{link.url}</span>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemoveLink(i)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <span className="material-symbols-outlined text-sm">close</span>
                  </button>
                </div>
              ))}
              <div className="flex gap-2 mt-3">
                <input
                  type="text"
                  value={linkLabel}
                  onChange={(e) => setLinkLabel(e.target.value)}
                  placeholder="Label..."
                  className="w-32 bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-xs py-2 px-2 placeholder:text-muted-foreground/30 placeholder:text-xs"
                />
                <input
                  type="url"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
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

          {/* Task Activity Log */}
          {taskLogs && taskLogs.length > 0 && (
            <div className="mt-8">
              <div className="flex items-center gap-4 mb-4">
                <h2 className="text-lg font-bold tracking-tight uppercase">Activity Log</h2>
                <div className="h-px flex-1 bg-outline-variant" />
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                  {taskLogs.length} events
                </span>
              </div>
              <div className="space-y-3">
                {taskLogs.map((log, i) => {
                  const iconMap: Record<string, { icon: string; color: string }> = {
                    debug_log: { icon: 'bug_report', color: '#ffeb3b' },
                    timer_started: { icon: 'play_circle', color: '#00fbfb' },
                    timer_paused: { icon: 'pause_circle', color: '#de8eff' },
                    timer_stopped: { icon: 'stop_circle', color: '#ff6e84' },
                    task_completed: { icon: 'task_alt', color: '#69fd5d' },
                    task_partial_done: { icon: 'pending', color: '#b90afc' },
                    task_status_changed: { icon: 'sync', color: '#00fbfb' },
                    task_created: { icon: 'add_task', color: '#69fd5d' },
                    dependency_added: { icon: 'account_tree', color: '#00fbfb' },
                    task_linked: { icon: 'link', color: '#00fbfb' },
                    link_added: { icon: 'add_link', color: '#00fbfb' },
                  }
                  const config = iconMap[log.action] ?? { icon: 'info', color: '#484847' }
                  const time = new Date(log.createdAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  const date = new Date(log.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

                  return (
                    <div key={log.id ?? i} className="flex gap-3 items-start p-3 bg-card border-l-2" style={{ borderColor: config.color }}>
                      <span className="material-symbols-outlined text-sm mt-0.5" style={{ color: config.color }}>{config.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-0.5">
                          <span className="text-xs font-bold tracking-tight uppercase truncate">{log.title}</span>
                          <span className="text-[9px] text-muted-foreground font-mono shrink-0">{date} {time}</span>
                        </div>
                        {log.detail && (
                          <div className="text-muted-foreground">
                            <MarkdownRenderer content={log.detail} compact />
                          </div>
                        )}
                        <span
                          className="inline-block mt-1 px-2 py-0.5 text-[8px] font-bold uppercase tracking-widest"
                          style={{ backgroundColor: `${config.color}1A`, color: config.color }}
                        >
                          {log.action.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
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
          <div className="flex flex-col gap-4">
            <h3 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
              Metadata Tags
            </h3>
            <div className="flex flex-wrap gap-2">
              {(task.tags ?? []).map((tag, i) => (
                <button
                  key={i}
                  onClick={async () => {
                    const updated = (task.tags ?? []).filter((_, idx) => idx !== i)
                    await db.tasks.update(task.id!, { tags: updated, updatedAt: new Date() })
                    syncTaskUpdate(task.id!, { tags: updated })
                  }}
                  className="group px-3 py-1 bg-surface-container-high border border-outline-variant text-[10px] uppercase tracking-tighter flex items-center gap-1 hover:border-destructive/50 transition-colors"
                >
                  {tag}
                  <span className="material-symbols-outlined text-[10px] text-muted-foreground group-hover:text-destructive">close</span>
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="Add tag..."
                className="flex-1 bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-xs py-2 px-2 uppercase tracking-widest placeholder:text-muted-foreground/30 placeholder:text-xs"
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    const val = tagInput.trim()
                    if (!val) return
                    const current = task.tags ?? []
                    if (current.includes(val)) return
                    const newTags = [...current, val]
                    await db.tasks.update(task.id!, { tags: newTags, updatedAt: new Date() })
                    syncTaskUpdate(task.id!, { tags: newTags })
                    setTagInput('')
                  }
                }}
              />
            </div>
          </div>

          {/* Total Time */}
          <div className="bg-surface-container-high p-6 border-t border-tertiary/20">
            <h3 className="text-xs font-bold tracking-widest uppercase mb-3 text-tertiary">
              Total Time
            </h3>
            <span className="text-3xl font-bold tracking-tighter font-mono">
              {formatSmartDuration(totalTime)}
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
