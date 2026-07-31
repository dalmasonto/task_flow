import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { db } from '@/db/database'
import { playSuccess } from '@/lib/sounds'
import { addNotification } from '@/hooks/use-app-notifications'
import { logActivity } from '@/hooks/use-activity-log'
import { useProjects } from '@/hooks/use-projects'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { TaskStatus, TaskPriority } from '@/types'

const STATUS_OPTIONS: TaskStatus[] = ['not_started', 'in_progress', 'paused', 'blocked']
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'critical']

export default function BulkCreateTasks() {
  const navigate = useNavigate()
  const projects = useProjects()

  const [lines, setLines] = useState('')
  const [projectId, setProjectId] = useState<number | undefined>()
  const [status, setStatus] = useState<TaskStatus>('not_started')
  const [priority, setPriority] = useState<TaskPriority>('medium')

  const taskTitles = lines
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (taskTitles.length === 0) return

    const now = new Date()
    const tasks = taskTitles.map(title => ({
      title,
      status,
      priority,
      projectId,
      dependencies: [] as number[],
      createdAt: now,
      updatedAt: now,
    }))

    await db.tasks.bulkAdd(tasks)
    playSuccess()
    toast.success(`${tasks.length} tasks injected`)
    addNotification('Bulk Import', `${tasks.length} tasks created`, 'success')
    logActivity('tasks_bulk_created', `Bulk created ${tasks.length} tasks`, { entityType: 'task' })
    navigate('/dashboard')
  }

  return (
    <div className="p-8 lg:p-12 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-12 space-y-2">
        <div className="flex items-center gap-2">
          <span className="h-[2px] w-8 bg-secondary" />
          <span className="text-xs tracking-widest uppercase text-secondary font-bold">Batch Input</span>
        </div>
        <h1 className="text-5xl lg:text-6xl font-black tracking-tighter uppercase leading-none">
          Bulk_Task <span className="text-secondary">Injection</span>
        </h1>
        <p className="text-xs text-muted-foreground uppercase tracking-widest mt-2">
          One task per line — all tasks share the same defaults below
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Textarea */}
        <div className="space-y-3">
          <label className="block text-xs font-bold tracking-widest uppercase text-muted-foreground">
            Task_Identifiers
          </label>
          <textarea
            value={lines}
            onChange={(e) => setLines(e.target.value)}
            placeholder={"Set up database schema\nDesign landing page\nWrite API endpoints\nConfigure CI/CD pipeline"}
            rows={10}
            className="w-full bg-input border-0 border-b-2 border-border focus:border-secondary focus:ring-0 text-sm py-4 px-2 placeholder:text-muted-foreground/20 placeholder:text-sm resize-y font-mono"
          />
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {taskTitles.length} task{taskTitles.length !== 1 ? 's' : ''} detected
          </p>
        </div>

        {/* Shared defaults */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-3">
            <label className="block text-xs font-bold tracking-widest uppercase text-muted-foreground">
              Assigned_Project
            </label>
            <Select
              value={projectId !== undefined ? String(projectId) : 'none'}
              onValueChange={(v) => setProjectId(v === 'none' ? undefined : Number(v))}
            >
              <SelectTrigger className="w-full bg-card border border-border text-xs tracking-widest uppercase">
                <SelectValue placeholder="UNASSIGNED" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs uppercase tracking-widest">UNASSIGNED</SelectItem>
                {(projects ?? []).map(p => (
                  <SelectItem key={p.id} value={String(p.id)} className="text-xs uppercase tracking-widest">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            <label className="block text-xs font-bold tracking-widest uppercase text-muted-foreground">
              Default_Status
            </label>
            <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
              <SelectTrigger className="w-full bg-card border border-border text-xs tracking-widest uppercase">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map(s => (
                  <SelectItem key={s} value={s} className="text-xs uppercase tracking-widest">
                    {s.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            <label className="block text-xs font-bold tracking-widest uppercase text-muted-foreground">
              Default_Priority
            </label>
            <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
              <SelectTrigger className="w-full bg-card border border-border text-xs tracking-widest uppercase">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map(p => (
                  <SelectItem key={p} value={p} className="text-xs uppercase tracking-widest">
                    {p.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Preview */}
        {taskTitles.length > 0 && (
          <div className="bg-card p-6 border-t border-secondary/20">
            <h3 className="text-xs font-bold tracking-widest uppercase text-secondary mb-4">
              Preview — {taskTitles.length} tasks
            </h3>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {taskTitles.map((title, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-2 bg-accent/30 text-xs"
                >
                  <span className="text-muted-foreground font-mono w-6 text-right">
                    {(i + 1).toString().padStart(2, '0')}
                  </span>
                  <span className="uppercase tracking-tight">{title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={taskTitles.length === 0}
          className="w-full bg-secondary text-secondary-foreground font-headline text-xl font-black py-6 tracking-tighter uppercase transition-all active:scale-95 glow-secondary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          INJECT_{taskTitles.length}_TASK{taskTitles.length !== 1 ? 'S' : ''}
        </button>
      </form>
    </div>
  )
}
