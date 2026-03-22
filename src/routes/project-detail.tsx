import { useState, useRef, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { toast } from 'sonner'
import { logActivity } from '@/hooks/use-activity-log'
import { useProject } from '@/hooks/use-projects'
import { useTasks } from '@/hooks/use-tasks'
import { useActiveSessions } from '@/hooks/use-sessions'
import { useTimer } from '@/hooks/use-timer'
import { db } from '@/db/database'
import { syncTaskUpdate, syncProjectUpdate, syncProjectDelete } from '@/lib/sync-api'
import { TaskCard } from '@/components/task-card'
import { EmptyState } from '@/components/empty-state'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { MarkdownEditor } from '@/components/markdown-editor'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { formatDuration, computeTotalTime } from '@/lib/time'
import type { TaskStatus, ProjectType } from '@/types'

const PRESET_COLORS = [
  { name: 'Primary', value: '#de8eff' },
  { name: 'Secondary', value: '#00fbfb' },
  { name: 'Tertiary', value: '#69fd5d' },
  { name: 'Error', value: '#ff6e84' },
  { name: 'Magenta', value: '#ff00ff' },
  { name: 'Yellow', value: '#ffeb3b' },
]

const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Not_Started',
  in_progress: 'In_Progress',
  paused: 'Paused',
  blocked: 'Blocked',
  partial_done: 'Partial_Done',
  done: 'Done',
}

// Sub-component: total time across all tasks in this project
function TotalProjectTime({ projectId, tick }: { projectId?: number; tick: number }) {
  const sessions = useLiveQuery(async () => {
    if (projectId === undefined) return []
    const allSessions = await db.sessions.toArray()
    const projectTasks = await db.tasks.where('projectId').equals(projectId).toArray()
    const taskIds = new Set(projectTasks.map(t => t.id))
    return allSessions.filter(s => taskIds.has(s.taskId))
  }, [projectId])

  const totalMs = useMemo(() => {
    void tick // dependency — recompute on every timer tick for active sessions
    return sessions ? computeTotalTime(sessions) : 0
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, tick])

  return (
    <div className="bg-surface-container-high p-6 border-t-2 border-tertiary/20">
      <h3 className="text-[10px] font-bold tracking-widest uppercase text-tertiary mb-2">
        Total_Time_Invested
      </h3>
      <span className="text-3xl font-bold tracking-tighter font-mono">
        {formatDuration(totalMs)}
      </span>
    </div>
  )
}

export default function ProjectDetail() {
  const { id } = useParams()
  const projectId = id ? Number(id) : undefined
  const navigate = useNavigate()

  const project = useProject(projectId)
  const tasks = useTasks({ projectId })
  const activeSessions = useActiveSessions()

  const hasActive =
    activeSessions?.some(s => tasks?.some(t => t.id === s.taskId)) ?? false
  const { tick } = useTimer(hasActive)

  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editColor, setEditColor] = useState('#de8eff')
  const [editType, setEditType] = useState<ProjectType>('active_project')
  const [showCustom, setShowCustom] = useState(false)
  // confirmDelete state removed — using AlertDialog instead
  const customColorRef = useRef<HTMLInputElement>(null)

  // Loading — query still in flight
  if (project === undefined && projectId !== undefined) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-card w-32" />
          <div className="h-12 bg-card w-64" />
          <div className="grid grid-cols-3 gap-4 mt-8">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-20 bg-card" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Not found
  if (!project) {
    return (
      <div className="p-8">
        <p className="text-xs font-bold text-destructive tracking-widest uppercase">
          Error_404
        </p>
        <h1 className="text-3xl md:text-5xl font-bold tracking-tighter uppercase mt-1">
          Project_Not_Found
        </h1>
        <p className="text-muted-foreground text-sm mt-4">
          The project you are looking for does not exist or has been deleted.
        </p>
        <Link
          to="/projects"
          className="text-secondary hover:text-secondary/80 text-sm mt-4 inline-block tracking-widest uppercase font-bold"
        >
          Return_to_Projects
        </Link>
      </div>
    )
  }

  const handleEditToggle = () => {
    if (!editing) {
      setEditName(project.name)
      setEditDescription(project.description ?? '')
      setEditColor(project.color)
      setEditType(project.type)
      setShowCustom(false)
    }
    setEditing(!editing)
  }

  const handleSave = async () => {
    if (!editName.trim()) return
    const updates = {
      name: editName.trim(),
      description: editDescription.trim() || undefined,
      color: editColor,
      type: editType,
    }
    await db.projects.update(project.id!, updates)
    syncProjectUpdate(project.id!, updates)
    logActivity('project_updated', `Updated project: ${editName.trim()}`, { entityType: 'project', entityId: project.id })
    setEditing(false)
  }

  const handleDelete = async () => {
    logActivity('project_deleted', `Deleted project: ${project.name}`, { entityType: 'project' })
    syncProjectDelete(project.id!)
    await db.projects.delete(project.id!)
    navigate('/projects')
  }

  const isPreset = PRESET_COLORS.some(c => c.value === editColor)
  const totalTaskCount = tasks?.length ?? 0
  const accentColor = editing ? editColor : project.color

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6">
        <Link
          to="/projects"
          className="text-xs font-bold tracking-widest uppercase text-muted-foreground hover:text-foreground transition-colors"
        >
          Projects
        </Link>
        <span className="text-muted-foreground/40 text-xs">›</span>
        <span className="text-xs font-bold tracking-widest uppercase" style={{ color: accentColor }}>
          {project.name}
        </span>
      </div>

      {/* Page header */}
      <div className="border-l-4 pl-6 mb-8" style={{ borderColor: accentColor }}>
        <p
          className="text-xs font-bold tracking-widest uppercase mb-2"
          style={{ color: accentColor }}
        >
          Project_Module
        </p>

        {editing ? (
          <input
            type="text"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            className="w-full bg-transparent border-0 border-b border-border text-4xl font-bold tracking-tighter uppercase placeholder:text-muted-foreground/40 placeholder:text-4xl focus:border-secondary focus:ring-0 focus:outline-none py-2 px-2 transition-colors"
            placeholder="Project name..."
            autoFocus
          />
        ) : (
          <h1 className="text-3xl md:text-5xl font-bold tracking-tighter uppercase">
            {project.name}
          </h1>
        )}
        <div className="mt-2">
          <span className={cn(
            'inline-flex items-center gap-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest',
            project.type === 'active_project'
              ? 'bg-secondary/10 text-secondary border-l-2 border-secondary'
              : 'bg-primary/10 text-primary border-l-2 border-primary'
          )}>
            {project.type === 'active_project' ? 'Active Project' : 'Project Idea'}
          </span>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
        {/* Left: main content */}
        <div className="lg:col-span-8 space-y-10">

          {/* Description */}
          <section>
            <div className="flex items-center gap-4 mb-4">
              <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
                Scope_Description
              </h2>
              <div className="h-px flex-1 bg-border" />
              {!editing && (
                <button
                  onClick={handleEditToggle}
                  className="text-[10px] uppercase tracking-widest font-bold px-3 py-1 bg-surface-variant text-muted-foreground hover:text-foreground transition-colors"
                >
                  Edit
                </button>
              )}
            </div>

            {editing ? (
              <MarkdownEditor
                value={editDescription}
                onChange={setEditDescription}
                placeholder="Define project parameters..."
                rows={5}
              />
            ) : (
              <div className="bg-surface-container-high p-6 border-l border-secondary/20">
                {project.description ? (
                  <MarkdownRenderer content={project.description} />
                ) : (
                  <p className="text-muted-foreground/50 italic text-sm">
                    No description provided.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Type selector — edit mode only */}
          {editing && (
            <section>
              <label className="text-xs font-bold text-muted-foreground tracking-widest uppercase block mb-3">
                Project_Classification
              </label>
              <Select value={editType} onValueChange={(v) => setEditType(v as ProjectType)}>
                <SelectTrigger className="w-full bg-card border border-border text-xs tracking-widest uppercase">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active_project" className="text-xs uppercase tracking-widest">
                    Active Project
                  </SelectItem>
                  <SelectItem value="project_idea" className="text-xs uppercase tracking-widest">
                    Project Idea
                  </SelectItem>
                </SelectContent>
              </Select>
            </section>
          )}

          {/* Color picker — edit mode only */}
          {editing && (
            <section>
              <label className="text-xs font-bold text-muted-foreground tracking-widest uppercase block mb-3">
                Neon_Accent_Signature
              </label>
              <div className="flex flex-wrap gap-3">
                {PRESET_COLORS.map(preset => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => {
                      setEditColor(preset.value)
                      setShowCustom(false)
                    }}
                    className={cn(
                      'w-10 h-10 rounded-none transition-all flex items-center justify-center',
                      editColor === preset.value
                        ? 'outline outline-2 outline-offset-2'
                        : 'hover:scale-110'
                    )}
                    style={{
                      backgroundColor: preset.value,
                      outlineColor: editColor === preset.value ? preset.value : undefined,
                    }}
                    title={preset.name}
                  >
                    {editColor === preset.value && (
                      <span className="material-symbols-outlined text-sm text-black font-bold">
                        check
                      </span>
                    )}
                  </button>
                ))}

                {/* Custom color */}
                <button
                  type="button"
                  onClick={() => {
                    setShowCustom(true)
                    setTimeout(() => customColorRef.current?.click(), 100)
                  }}
                  className={cn(
                    'w-10 h-10 rounded-none border border-dashed border-border flex items-center justify-center transition-all hover:border-foreground',
                    showCustom && !isPreset && 'outline outline-2 outline-offset-2'
                  )}
                  style={
                    showCustom && !isPreset
                      ? { backgroundColor: editColor, outlineColor: editColor }
                      : undefined
                  }
                  title="Custom color"
                >
                  {showCustom && !isPreset ? (
                    <span className="material-symbols-outlined text-sm text-black font-bold">
                      check
                    </span>
                  ) : (
                    <span className="material-symbols-outlined text-sm text-muted-foreground">
                      add
                    </span>
                  )}
                </button>

                <input
                  ref={customColorRef}
                  type="color"
                  value={editColor}
                  onChange={e => {
                    setEditColor(e.target.value)
                    setShowCustom(true)
                  }}
                  className="sr-only"
                  tabIndex={-1}
                />
              </div>
            </section>
          )}

          {/* Edit action buttons */}
          {editing && (
            <div className="flex gap-4">
              <Button
                onClick={handleSave}
                className="bg-primary text-primary-foreground font-bold tracking-widest uppercase hover:shadow-[0_0_20px_rgba(222,142,255,0.4)] px-8 py-5 rounded-none"
              >
                Save_Changes
              </Button>
              <Button
                variant="outline"
                onClick={() => setEditing(false)}
                className="border border-border text-muted-foreground hover:text-foreground hover:border-foreground font-bold tracking-widest uppercase px-8 py-5 rounded-none bg-transparent"
              >
                Cancel
              </Button>
            </div>
          )}

          {/* Task list */}
          <section>
            <div className="flex items-center gap-4 mb-6">
              <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
                Task_Roster
              </h2>
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] tracking-widest uppercase text-muted-foreground">
                {totalTaskCount} task{totalTaskCount !== 1 ? 's' : ''}
              </span>
              <Link
                to="/tasks/new"
                className="text-[10px] uppercase tracking-widest font-bold px-3 py-1 bg-surface-variant text-muted-foreground hover:text-foreground transition-colors"
              >
                + New_Task
              </Link>
            </div>

            {/* Link existing tasks */}
            <TaskLinker projectId={projectId!} />

            {tasks === undefined ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-24 bg-card animate-pulse" />
                ))}
              </div>
            ) : tasks.length === 0 ? (
              <EmptyState
                icon="task_alt"
                title="No Tasks in This Project"
                description="Create your first task to start tracking work in this project"
                action={
                  <Button asChild>
                    <Link to="/tasks/new">Create Task</Link>
                  </Button>
                }
              />
            ) : (
              <div className="space-y-3">
                {tasks.map(task => (
                  <TaskCard key={task.id} task={task} tick={tick} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right: sidebar */}
        <aside className="lg:col-span-4 space-y-6">

          {/* Color swatch — view mode */}
          {!editing && (
            <div
              className="bg-surface-container-high p-6 border-t-2"
              style={{ borderColor: project.color }}
            >
              <h3 className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
                Accent_Signature
              </h3>
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 border border-border"
                  style={{ backgroundColor: project.color }}
                />
                <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                  {project.color}
                </span>
              </div>
            </div>
          )}

          {/* Status breakdown */}
          {tasks && tasks.length > 0 && (
            <div className="bg-surface-container-high p-6 border-t-2 border-primary/20">
              <h3 className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground mb-4">
                Status_Breakdown
              </h3>
              <div className="space-y-3">
                {(Object.keys(STATUS_LABELS) as TaskStatus[]).map(status => {
                  const count = tasks.filter(t => t.status === status).length
                  if (count === 0) return null
                  const pct = Math.round((count / totalTaskCount) * 100)
                  return (
                    <div key={status}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                          {STATUS_LABELS[status]}
                        </span>
                        <span className="text-[10px] font-bold text-foreground">
                          {count}
                        </span>
                      </div>
                      <div className="h-1 bg-border">
                        <div
                          className="h-full bg-primary/60 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Total time invested */}
          <TotalProjectTime projectId={projectId} tick={tick} />

          {/* Meta info */}
          <div className="bg-surface-container-high p-6 border-t-2 border-outline-variant">
            <h3 className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
              Module_Meta
            </h3>
            <div className="space-y-3">
              <div>
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground block">
                  Created
                </span>
                <span className="text-sm font-medium">
                  {new Date(project.createdAt)
                    .toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })
                    .toUpperCase()}
                </span>
              </div>
              <div>
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground block">
                  Project ID
                </span>
                <span className="text-sm font-mono text-muted-foreground">
                  #{project.id}
                </span>
              </div>
            </div>
          </div>

          {/* Danger zone */}
          <div className="bg-surface-container-high p-6 border-t-2 border-destructive/30">
            <h3 className="text-[10px] font-bold tracking-widest uppercase text-destructive mb-4">
              Danger_Zone
            </h3>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button className="text-[10px] uppercase tracking-widest font-bold px-4 py-2 border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors">
                  Delete_Project
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="uppercase tracking-widest">Delete Project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete "{project.name}". Tasks will remain but lose their project association.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Confirm Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </aside>
      </div>
    </div>
  )
}

function TaskLinker({ projectId }: { projectId: number }) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const allTasks = useTasks()

  const linkableTasks = useMemo(() => {
    if (!allTasks) return []
    return allTasks.filter(t =>
      t.projectId !== projectId &&
      t.title.toLowerCase().includes(search.toLowerCase())
    )
  }, [allTasks, projectId, search])

  const handleLink = async (taskId: number) => {
    await db.tasks.update(taskId, { projectId, updatedAt: new Date() })
    syncTaskUpdate(taskId, { projectId })
    toast.success('Task linked to project')
    logActivity('task_linked', `Task linked to project`, { entityType: 'task', entityId: taskId })
  }

  const handleUnlink = async (taskId: number) => {
    await db.tasks.update(taskId, { projectId: undefined, updatedAt: new Date() })
    syncTaskUpdate(taskId, { projectId: null })
    toast.info('Task unlinked from project')
    logActivity('task_unlinked', `Task unlinked from project`, { entityType: 'task', entityId: taskId })
  }

  const projectTasks = useMemo(() => {
    if (!allTasks) return []
    return allTasks.filter(t => t.projectId === projectId)
  }, [allTasks, projectId])

  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold text-secondary hover:text-secondary/80 transition-colors mb-3"
      >
        <span className="material-symbols-outlined text-sm">
          {open ? 'expand_less' : 'link'}
        </span>
        {open ? 'Close Linker' : 'Link Existing Tasks'}
      </button>

      {open && (
        <div className="bg-card p-4 border-t border-secondary/20 space-y-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks to link..."
            className="w-full bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-xs py-2 px-2 uppercase tracking-widest placeholder:text-muted-foreground/30 placeholder:text-xs"
          />

          {/* Linkable tasks */}
          <div className="max-h-48 overflow-y-auto space-y-1">
            {linkableTasks.length === 0 ? (
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest text-center py-4">
                {search ? 'No matching tasks' : 'All tasks are already linked'}
              </p>
            ) : (
              linkableTasks.map(task => (
                <button
                  key={task.id}
                  onClick={() => handleLink(task.id!)}
                  className="w-full flex items-center justify-between p-2 bg-accent/30 hover:bg-accent transition-colors text-left"
                >
                  <span className="text-xs uppercase tracking-tight truncate">{task.title}</span>
                  <span className="material-symbols-outlined text-sm text-secondary shrink-0">add</span>
                </button>
              ))
            )}
          </div>

          {/* Currently linked — option to unlink */}
          {projectTasks.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2 mt-3">
                Linked ({projectTasks.length})
              </p>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {projectTasks.map(task => (
                  <div
                    key={task.id}
                    className="flex items-center justify-between p-2 bg-accent/30"
                  >
                    <span className="text-xs uppercase tracking-tight truncate">{task.title}</span>
                    <button
                      onClick={() => handleUnlink(task.id!)}
                      className="material-symbols-outlined text-sm text-muted-foreground hover:text-destructive shrink-0"
                    >
                      link_off
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
