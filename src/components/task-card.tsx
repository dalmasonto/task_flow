import { useNavigate } from 'react-router'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { Task, TaskStatus } from '@/types'
import { getStatusColor, getStatusLabel, canTransition } from '@/lib/status'
import { formatDuration } from '@/lib/time'
import { useTaskTotalTime, useActiveSessions } from '@/hooks/use-sessions'
import { useProject } from '@/hooks/use-projects'
import { useTimer } from '@/hooks/use-timer'
import { db } from '@/db/database'
import { playTimerStart, playTimerPause, playTaskDone, playClick, playDelete } from '@/lib/sounds'
import { addNotification } from '@/hooks/use-app-notifications'
import { logActivity } from '@/hooks/use-activity-log'
import { StatusBadge } from './status-badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

interface TaskCardProps {
  task: Task
  tick?: number
  className?: string
}

const QUICK_STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'paused', 'blocked', 'partial_done', 'done']

export function TaskCard({ task, tick, className }: TaskCardProps) {
  const totalTime = useTaskTotalTime(task.id, tick)
  const project = useProject(task.projectId)
  const color = getStatusColor(task.status)
  const navigate = useNavigate()
  const activeSessions = useActiveSessions()
  const hasActive = activeSessions?.some(s => s.taskId === task.id) ?? false
  const { startTask, pauseTask } = useTimer(hasActive)

  const handleStatusChange = async (newStatus: TaskStatus) => {
    if (!canTransition(task.status, newStatus)) return

    if (newStatus === 'done' || newStatus === 'partial_done') {
      const activeSession = await db.sessions
        .where('taskId').equals(task.id!)
        .filter(s => s.end === undefined).first()
      if (activeSession) {
        await db.sessions.update(activeSession.id!, { end: new Date() })
      }
    }

    await db.tasks.update(task.id!, { status: newStatus, updatedAt: new Date() })

    if (newStatus === 'done') {
      playTaskDone()
      toast.success(`Task completed: ${task.title}`)
      addNotification('Task Completed', task.title, 'success')
      logActivity('task_completed', `Completed: ${task.title}`, { entityType: 'task', entityId: task.id })
    } else {
      playClick()
      toast(`Status → ${newStatus.replace(/_/g, ' ')}`)
      logActivity('task_status_changed', `${task.title} → ${newStatus.replace(/_/g, ' ')}`, { entityType: 'task', entityId: task.id })
    }
  }

  const handleDelete = async () => {
    await db.sessions.where('taskId').equals(task.id!).delete()
    await db.tasks.delete(task.id!)
    playDelete()
    toast.success('Task deleted')
    addNotification('Task Deleted', task.title, 'warning')
    logActivity('task_deleted', `Deleted: ${task.title}`, { entityType: 'task' })
  }

  return (
    <div
      className={cn(
        'bg-card p-6 group cursor-pointer transition-all duration-300',
        'hover:bg-accent hover:translate-x-1',
        className
      )}
      style={{ borderLeft: `4px solid ${color}` }}
      onClick={() => navigate(`/tasks/${task.id}`)}
    >
      <div className="flex justify-between items-start mb-4">
        <StatusBadge status={task.status} />
        <Popover>
          <PopoverTrigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors hover:text-primary"
            >
              <span className="material-symbols-outlined text-sm">more_vert</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-48 p-0"
            align="end"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Quick status changes */}
            <div className="p-1">
              <p className="px-2 py-1 text-[9px] text-muted-foreground uppercase tracking-widest">
                Set Status
              </p>
              {QUICK_STATUSES.map(s => {
                const allowed = s === task.status || canTransition(task.status, s)
                return (
                  <button
                    key={s}
                    disabled={!allowed || s === task.status}
                    onClick={() => handleStatusChange(s)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: getStatusColor(s) }}
                    />
                    <span className="uppercase tracking-widest text-[10px]">
                      {getStatusLabel(s)}
                    </span>
                    {s === task.status && (
                      <span className="material-symbols-outlined text-xs ml-auto text-muted-foreground">check</span>
                    )}
                  </button>
                )
              })}
            </div>

            <div className="border-t border-border p-1">
              {/* Timer actions */}
              {!hasActive && task.status !== 'done' && (
                <button
                  onClick={async () => { await startTask(task); playTimerStart(); toast.success('Timer started') }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left hover:bg-accent transition-colors"
                >
                  <span className="material-symbols-outlined text-sm text-tertiary">play_arrow</span>
                  <span className="uppercase tracking-widest text-[10px]">Start Timer</span>
                </button>
              )}
              {hasActive && (
                <button
                  onClick={async () => { await pauseTask(task); playTimerPause(); toast.info('Timer paused') }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left hover:bg-accent transition-colors"
                >
                  <span className="material-symbols-outlined text-sm text-primary">pause</span>
                  <span className="uppercase tracking-widest text-[10px]">Pause Timer</span>
                </button>
              )}
            </div>

            <div className="border-t border-border p-1">
              {/* Delete */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left hover:bg-destructive/10 text-destructive transition-colors">
                    <span className="material-symbols-outlined text-sm">delete</span>
                    <span className="uppercase tracking-widest text-[10px]">Delete Task</span>
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                  <AlertDialogHeader>
                    <AlertDialogTitle className="uppercase tracking-widest">Delete Task?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete "{task.title}" and all its sessions. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <h3 className="font-bold text-lg mb-3 text-foreground group-hover:text-foreground transition-colors leading-tight tracking-tight">
        {task.title}
      </h3>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {project && (
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2"
                style={{ backgroundColor: project.color }}
              />
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                {project.name}
              </span>
            </div>
          )}
        </div>
        {totalTime > 0 && (
          <span className="text-[10px] font-bold text-muted-foreground tracking-widest font-mono">
            {formatDuration(totalTime)}
          </span>
        )}
      </div>
    </div>
  )
}
