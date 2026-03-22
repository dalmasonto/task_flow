import { useState } from 'react'
import { useNavigate } from 'react-router'
import { db } from '@/db/database'
import { useProjects } from '@/hooks/use-projects'
import { useTasks } from '@/hooks/use-tasks'
import { hasCycle } from '@/lib/dag'
import { MarkdownEditor } from '@/components/markdown-editor'
import { DependencyPicker } from '@/components/dependency-picker'
import type { TaskStatus, TaskPriority } from '@/types'

const STATUS_OPTIONS: TaskStatus[] = ['not_started', 'in_progress', 'paused', 'blocked']
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'critical']

export default function CreateTask() {
  const navigate = useNavigate()
  const projects = useProjects()
  const allTasks = useTasks()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState<number | undefined>()
  const [status, setStatus] = useState<TaskStatus>('not_started')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [dependencies, setDependencies] = useState<number[]>([])
  const [estimatedTime, setEstimatedTime] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!title.trim()) {
      setError('Task identifier is required')
      return
    }

    // Validate DAG — create a temporary task to check cycles
    if (dependencies.length > 0 && allTasks) {
      const tempTask = {
        id: Date.now(), // temp ID
        title,
        status,
        priority,
        dependencies,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const tasksWithTemp = [...allTasks, tempTask]
      for (const depId of dependencies) {
        if (hasCycle(tasksWithTemp, tempTask.id, depId)) {
          setError('Adding these dependencies would create a circular dependency')
          return
        }
      }
    }

    await db.tasks.add({
      title: title.trim(),
      description: description || undefined,
      status,
      priority,
      projectId,
      dependencies,
      estimatedTime: estimatedTime ? parseFloat(estimatedTime) * 3600000 : undefined, // hours to ms
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    navigate('/dashboard')
  }

  return (
    <div className="p-8 lg:p-12 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="h-[2px] w-8 bg-primary" />
            <span className="text-xs tracking-widest uppercase text-primary font-bold">System Input</span>
          </div>
          <h1 className="text-5xl lg:text-6xl font-black tracking-tighter uppercase leading-none">
            New_Task <span className="text-primary">Initialization</span>
          </h1>
        </div>
        <div className="text-right">
          <div className="flex justify-end">
            <div className="w-2 h-2 bg-tertiary animate-pulse" />
          </div>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="grid grid-cols-12 gap-8">
        {/* Left Column */}
        <div className="col-span-12 lg:col-span-7 space-y-8">
          {/* Title */}
          <div className="space-y-3 group">
            <label className="block text-xs font-bold tracking-widest uppercase text-muted-foreground group-focus-within:text-secondary transition-colors">
              Task_Identifier
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="ENTER_TASK_NAME..."
              className="w-full bg-input border-0 border-b-2 border-border focus:border-secondary focus:ring-0 text-xl font-headline tracking-tight py-4 px-0 placeholder:text-muted-foreground/20"
            />
          </div>

          {/* Description */}
          <div className="space-y-3">
            <label className="block text-xs font-bold tracking-widest uppercase text-muted-foreground">
              Operational_Specs
            </label>
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              placeholder="DEFINE_OBJECTIVES..."
            />
          </div>

          {/* Project & Status Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <label className="block text-xs font-bold tracking-widest uppercase text-muted-foreground">
                Assigned_Project
              </label>
              <div className="relative">
                <select
                  value={projectId ?? ''}
                  onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : undefined)}
                  className="w-full bg-card border border-border focus:border-secondary appearance-none py-3 px-4 text-xs tracking-widest uppercase focus:ring-0"
                >
                  <option value="">UNASSIGNED</option>
                  {(projects ?? []).map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />
              </div>
            </div>

            <div className="space-y-3">
              <label className="block text-xs font-bold tracking-widest uppercase text-muted-foreground">
                Current_State
              </label>
              <div className="relative">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as TaskStatus)}
                  className="w-full bg-card border border-border focus:border-secondary appearance-none py-3 px-4 text-xs tracking-widest uppercase focus:ring-0"
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s} value={s}>{s.toUpperCase()}</option>
                  ))}
                </select>
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-secondary animate-pulse" />
              </div>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="col-span-12 lg:col-span-5 space-y-8">
          {/* Dependencies */}
          <DependencyPicker
            selectedIds={dependencies}
            onChange={setDependencies}
          />

          {/* Priority & Time */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-card p-4 border-l-2 border-secondary/40">
              <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="w-full bg-transparent border-0 focus:ring-0 text-xs uppercase tracking-widest p-0 text-secondary"
              >
                {PRIORITY_OPTIONS.map(p => (
                  <option key={p} value={p}>{p.toUpperCase()}</option>
                ))}
              </select>
            </div>
            <div className="bg-card p-4 border-l-2 border-tertiary/40">
              <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Time_Weight</span>
              <input
                type="number"
                value={estimatedTime}
                onChange={(e) => setEstimatedTime(e.target.value)}
                placeholder="0"
                step="0.5"
                className="w-full bg-transparent border-0 focus:ring-0 text-lg font-headline tracking-tight p-0"
              />
              <span className="text-[10px] text-muted-foreground">hours</span>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="p-4 bg-destructive/10 border-l-2 border-destructive text-destructive text-xs uppercase tracking-widest">
              {error}
            </div>
          )}

          {/* Submit */}
          <div className="pt-4">
            <button
              type="submit"
              className="w-full bg-primary text-primary-foreground font-headline text-xl font-black py-6 tracking-tighter uppercase transition-all active:scale-95 glow-primary"
            >
              INITIALIZE_TASK_SEQUENCE
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
