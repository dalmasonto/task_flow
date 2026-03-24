import { useMemo, useState, useCallback, useEffect } from 'react'
import { Link } from 'react-router'
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  Panel,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
} from '@xyflow/react'
import type {
  Node,
  Edge,
  NodeTypes,
  NodeProps,
} from '@xyflow/react'
import { MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'
import { useTasks } from '@/hooks/use-tasks'
import { useProjects } from '@/hooks/use-projects'
import { useActiveSessions, useSessions } from '@/hooks/use-sessions'
import { useTimer } from '@/hooks/use-timer'
import { useSetting, trackRecentProject } from '@/hooks/use-settings'
import { getStatusColor, getStatusLabel, getDisplayStatus } from '@/lib/status'
import { getBlockers } from '@/lib/dag'
import { formatDuration, computeSessionDuration } from '@/lib/time'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { useTaskActivityLog } from '@/hooks/use-activity-log'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { Task, TaskStatus, Project } from '@/types'

// ---------- Dagre layout ----------

const NODE_SIZES: Record<string, { width: number; height: number }> = {
  taskNode: { width: 220, height: 120 },
  projectNode: { width: 200, height: 80 },
}

function getLayoutedElements(nodes: Node[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 200, marginx: 40, marginy: 40 })

  nodes.forEach((node) => {
    const size = NODE_SIZES[node.type ?? 'taskNode'] ?? NODE_SIZES.taskNode
    g.setNode(node.id, { ...size })
  })
  edges.forEach((edge) => g.setEdge(edge.source, edge.target))

  dagre.layout(g)

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id)
    const size = NODE_SIZES[node.type ?? 'taskNode'] ?? NODE_SIZES.taskNode
    return { ...node, position: { x: pos.x - size.width / 2, y: pos.y - size.height / 2 } }
  })

  return { nodes: layoutedNodes, edges }
}

// ---------- Progress helpers ----------

function getProgress(status: TaskStatus): number {
  switch (status) {
    case 'not_started':
      return 0
    case 'in_progress':
      return 40
    case 'paused':
      return 30
    case 'blocked':
      return 20
    case 'partial_done':
      return 70
    case 'done':
      return 100
  }
}

// ---------- Custom Node ----------

type TaskNodeData = {
  task: Task
  allTasks: Task[]
  selected: boolean
  projectColor?: string
}

function TaskNode({ data, id }: NodeProps<Node<TaskNodeData>>) {
  const task = data.task as Task
  const allTasks = data.allTasks as Task[]
  const projectColor = data.projectColor as string | undefined
  const display = getDisplayStatus(task, allTasks)
  const statusColor = display.label === 'Unblocked' ? '#69fd5d' : getStatusColor(task.status)
  const progress = getProgress(task.status)

  return (
    <div
      className="group bg-card/90 backdrop-blur-sm border border-muted-foreground/20 w-[220px] h-[120px] relative transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50"
      style={{ borderLeft: `3px solid ${statusColor}`, borderTop: projectColor ? `2px solid ${projectColor}` : undefined }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-muted-foreground/50 !border-none"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-muted-foreground/50 !border-none"
      />

      <div className="p-3 h-full flex flex-col justify-between">
        <div>
          <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
            TASK-{id}
          </div>
          <div className="text-xs font-bold uppercase tracking-tight leading-tight line-clamp-2">
            {task.title}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span
              className="text-[8px] uppercase tracking-widest font-bold"
              style={{ color: statusColor }}
            >
              {display.label}
            </span>
            <span className="text-[8px] text-muted-foreground">{progress}%</span>
          </div>
          <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress}%`,
                backgroundColor: statusColor,
                boxShadow: `0 0 6px ${statusColor}`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- Project Node ----------

type ProjectNodeData = {
  name: string
  color: string
  taskCount: number
}

function ProjectNode({ data, id }: NodeProps<Node<ProjectNodeData>>) {
  const name = data.name as string
  const color = data.color as string
  const taskCount = data.taskCount as number
  const isUnassigned = id === `proj-${UNASSIGNED_KEY}`

  return (
    <div
      className="bg-card/90 backdrop-blur-sm border-2 w-[200px] h-[80px] relative transition-all duration-200 hover:-translate-y-0.5"
      style={{ borderColor: color, boxShadow: `0 0 12px ${color}30` }}
    >
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !border-none"
        style={{ backgroundColor: color }}
      />

      <div className="p-3 h-full flex flex-col justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-sm" style={{ color }}>{isUnassigned ? 'folder_off' : 'folder'}</span>
          <span className="text-xs font-bold uppercase tracking-tight leading-tight line-clamp-1">
            {name}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[8px] uppercase tracking-widest font-bold" style={{ color }}>
            Project
          </span>
          <span className="text-[8px] text-muted-foreground">
            {taskCount} task{taskCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

const nodeTypes: NodeTypes = {
  taskNode: TaskNode,
  projectNode: ProjectNode,
}

// ---------- All statuses for legend ----------

const ALL_STATUSES: TaskStatus[] = [
  'not_started',
  'in_progress',
  'paused',
  'blocked',
  'partial_done',
  'done',
]

// ---------- Detail Panel (separate component so hooks work) ----------

function TaskDetailPanel({
  task,
  allTasks,
  taskMap,
  onClose,
}: {
  task: Task
  allTasks: Task[]
  taskMap: Map<number, Task>
  onClose: () => void
}) {
  const sessions = useSessions(task.id)
  const taskLogs = useTaskActivityLog(task.id)
  const activeSessions = useActiveSessions()
  const hasActiveSession = activeSessions?.some(s => s.taskId === task.id) ?? false
  const { startTask, pauseTask } = useTimer(hasActiveSession)
  const blockers = getBlockers(allTasks, task.id!)
  const isBlocked = blockers.length > 0
  const canPlay = !hasActiveSession && !isBlocked && task.status !== 'done'
  const canPause = hasActiveSession

  const dependents = allTasks.filter(
    t => t.id !== undefined && task.id !== undefined && t.dependencies.includes(task.id)
  )

  return (
    <div className="absolute top-0 right-0 h-full w-80 bg-card/95 backdrop-blur-md border-l border-muted-foreground/20 z-20 overflow-y-auto">
      <div className="p-6 space-y-6">
        {/* Close */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground tracking-[0.2em] uppercase">
            Node Details
          </span>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {/* Task ID */}
        <div>
          <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
            Identifier
          </div>
          <div className="font-mono text-sm text-primary">
            TASK-{task.id}
          </div>
        </div>

        {/* Title */}
        <div>
          <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
            Title
          </div>
          <div className="text-sm font-bold uppercase tracking-tight">
            {task.title}
          </div>
        </div>

        {/* Description */}
        {task.description && (
          <div>
            <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
              Description
            </div>
            <div className="text-xs text-muted-foreground leading-relaxed prose prose-sm prose-invert max-w-none">
              <MarkdownRenderer content={task.description} />
            </div>
          </div>
        )}

        {/* Status */}
        <div>
          <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
            Status
          </div>
          {(() => {
            const display = getDisplayStatus(task, allTasks)
            const color = display.label === 'Unblocked' ? '#69fd5d' : getStatusColor(task.status)
            return (
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
                />
                <span
                  className="text-xs uppercase tracking-widest font-bold"
                  style={{ color }}
                >
                  {display.label}
                </span>
              </div>
            )
          })()}
        </div>

        {/* Priority */}
        <div>
          <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
            Priority
          </div>
          <span className="text-xs uppercase tracking-widest font-bold">
            {task.priority}
          </span>
        </div>

        {/* Timer Controls */}
        <div>
          <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-2">
            Timer Controls
          </div>
          {isBlocked && (
            <p className="text-[10px] text-destructive uppercase tracking-widest mb-2">
              Blocked by {blockers.map(b => b.title).join(', ')}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => canPlay && startTask(task)}
              disabled={!canPlay}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-tertiary/10 text-tertiary text-[10px] uppercase tracking-widest font-bold border border-tertiary/30 hover:bg-tertiary/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-sm">play_arrow</span>
              {task.status === 'paused' ? 'Resume' : 'Start'}
            </button>
            <button
              onClick={() => canPause && pauseTask(task)}
              disabled={!canPause}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-primary/10 text-primary text-[10px] uppercase tracking-widest font-bold border border-primary/30 hover:bg-primary/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-sm">pause</span>
              Pause
            </button>
          </div>
        </div>

        {/* Dependencies */}
        {task.dependencies.length > 0 && (
          <div>
            <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-2">
              Depends On
            </div>
            <div className="space-y-1.5">
              {task.dependencies.map((depId) => {
                const dep = taskMap.get(depId)
                if (!dep) return null
                const depColor = getStatusColor(dep.status)
                return (
                  <div key={depId} className="flex items-center gap-2 text-xs">
                    <div
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: depColor }}
                    />
                    <span className="font-mono text-muted-foreground">#{depId}</span>
                    <span className="uppercase tracking-tight truncate">{dep.title}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Dependents */}
        {dependents.length > 0 && (
          <div>
            <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-2">
              Depended By
            </div>
            <div className="space-y-1.5">
              {dependents.map((dep) => {
                const depColor = getStatusColor(dep.status)
                return (
                  <div key={dep.id} className="flex items-center gap-2 text-xs">
                    <div
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: depColor }}
                    />
                    <span className="font-mono text-muted-foreground">#{dep.id}</span>
                    <span className="uppercase tracking-tight truncate">{dep.title}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Activity Log */}
        {taskLogs && taskLogs.length > 0 && (
          <div>
            <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-2">
              Activity Log ({taskLogs.length})
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {taskLogs.map((log, i) => {
                const iconMap: Record<string, { icon: string; color: string }> = {
                  debug_log: { icon: 'bug_report', color: '#ffeb3b' },
                  timer_started: { icon: 'play_circle', color: '#00fbfb' },
                  timer_paused: { icon: 'pause_circle', color: '#de8eff' },
                  timer_stopped: { icon: 'stop_circle', color: '#ff6e84' },
                  task_completed: { icon: 'task_alt', color: '#69fd5d' },
                  task_status_changed: { icon: 'sync', color: '#00fbfb' },
                  task_created: { icon: 'add_task', color: '#69fd5d' },
                }
                const config = iconMap[log.action] ?? { icon: 'info', color: '#484847' }
                const time = new Date(log.createdAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })

                return (
                  <div key={log.id ?? i} className="flex items-start gap-2 text-xs p-2 bg-accent/30">
                    <span className="material-symbols-outlined text-xs mt-0.5" style={{ color: config.color }}>{config.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="uppercase tracking-tight truncate text-[10px] font-bold">{log.title}</span>
                        <span className="text-[9px] text-muted-foreground font-mono shrink-0 ml-1">{time}</span>
                      </div>
                      {log.detail && (
                        <div className="text-muted-foreground mt-0.5">
                          <MarkdownRenderer content={log.detail} compact />
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Edit Button */}
        <Link
          to={`/tasks/${task.id}`}
          className="block w-full text-center px-4 py-2.5 bg-primary text-primary-foreground text-[10px] tracking-widest uppercase font-bold hover:opacity-90 transition-opacity"
        >
          Edit Task Details
        </Link>

        {/* Session History */}
        {sessions && sessions.length > 0 && (
          <div>
            <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-2">
              Session History ({sessions.length})
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {[...sessions].reverse().map((session) => {
                const isActive = !session.end
                const duration = computeSessionDuration(session)
                return (
                  <div
                    key={session.id}
                    className="flex items-center gap-2 text-xs p-2 bg-accent/30"
                  >
                    <div
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isActive ? 'pulse-active' : ''}`}
                      style={{
                        backgroundColor: isActive ? '#69fd5d' : '#484847',
                        boxShadow: isActive ? '0 0 6px #69fd5d' : 'none',
                      }}
                    />
                    <span className="text-muted-foreground font-mono text-[10px]">
                      {session.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {' '}
                      {session.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="ml-auto font-bold tabular-nums" style={{ color: isActive ? '#69fd5d' : undefined }}>
                      {isActive ? 'LIVE' : formatDuration(duration)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- Main Component ----------

const UNASSIGNED_KEY = 'unassigned'
const UNASSIGNED_COLOR = '#484847'

export default function DependencyGraph() {
  const tasks = useTasks()
  const projects = useProjects()
  const recentProjectIds = useSetting('recentProjectIds')
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [activeFilters, setActiveFilters] = useState<Set<string> | null>(null) // null = not yet initialized
  const [filterDialogOpen, setFilterDialogOpen] = useState(false)
  const [filterSearch, setFilterSearch] = useState('')

  // Derive filter options from data
  const filterOptions = useMemo(() => {
    if (!tasks || tasks.length === 0) return []
    const opts: { key: string; label: string; color: string; count: number }[] = []
    const projectTaskCounts = new Map<number, number>()
    let unassignedCount = 0
    for (const t of tasks) {
      if (t.id === undefined) continue
      if (t.projectId !== undefined) {
        projectTaskCounts.set(t.projectId, (projectTaskCounts.get(t.projectId) ?? 0) + 1)
      } else {
        unassignedCount++
      }
    }
    for (const p of projects ?? []) {
      const count = projectTaskCounts.get(p.id!) ?? 0
      if (count > 0) opts.push({ key: String(p.id), label: p.name, color: p.color, count })
    }
    if (unassignedCount > 0) {
      opts.push({ key: UNASSIGNED_KEY, label: 'Unassigned', color: UNASSIGNED_COLOR, count: unassignedCount })
    }
    return opts
  }, [tasks, projects])

  // Initialize filters from recently viewed projects (once)
  const [initialized, setInitialized] = useState(false)
  useEffect(() => {
    if (initialized || filterOptions.length === 0) return
    setInitialized(true)

    if (recentProjectIds.length > 0) {
      const validKeys = new Set(filterOptions.map(o => o.key))
      const recentKeys = recentProjectIds
        .map(String)
        .filter(k => validKeys.has(k))
        .slice(0, 2)
      if (recentKeys.length > 0) {
        setActiveFilters(new Set(recentKeys))
        return
      }
    }
    // Fallback: show the 2 most recently created projects
    const projectKeys = filterOptions.filter(o => o.key !== UNASSIGNED_KEY).map(o => o.key)
    const newest = projectKeys.slice(-2)
    setActiveFilters(newest.length > 0 ? new Set(newest) : null)
  }, [filterOptions, recentProjectIds, initialized])

  const toggleFilter = useCallback((key: string) => {
    setActiveFilters((prev) => {
      const current = prev ?? new Set(filterOptions.map(o => o.key))
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
        if (next.size === 0) return new Set() // empty = show nothing (user explicitly deselected all)
      } else {
        next.add(key)
      }
      // Track project as recently viewed when selected
      if (next.has(key) && key !== UNASSIGNED_KEY) {
        trackRecentProject(Number(key))
      }
      return next
    })
  }, [filterOptions])

  const showAll = activeFilters === null
  const selectedCount = activeFilters?.size ?? filterOptions.length

  // Build nodes & edges from tasks + projects
  const { initialNodes, initialEdges, taskMap } = useMemo(() => {
    if (!tasks || tasks.length === 0) {
      return { initialNodes: [], initialEdges: [], taskMap: new Map<number, Task>() }
    }

    const tMap = new Map<number, Task>()
    for (const t of tasks) {
      if (t.id !== undefined) tMap.set(t.id, t)
    }

    // Determine which tasks pass the filter
    const isTaskVisible = (t: Task) => {
      if (showAll) return true
      if (t.projectId !== undefined) return activeFilters!.has(String(t.projectId))
      return activeFilters!.has(UNASSIGNED_KEY)
    }

    const visibleTasks = tasks.filter(t => t.id !== undefined && isTaskVisible(t))
    const visibleTaskIds = new Set(visibleTasks.map(t => t.id!))

    // Group visible tasks by projectId
    const tasksByProject = new Map<number, Task[]>()
    const unassignedTasks: Task[] = []
    for (const t of visibleTasks) {
      if (t.projectId !== undefined) {
        if (!tasksByProject.has(t.projectId)) tasksByProject.set(t.projectId, [])
        tasksByProject.get(t.projectId)!.push(t)
      } else {
        unassignedTasks.push(t)
      }
    }

    const pMap = new Map<number, Project>()
    for (const p of projects ?? []) {
      if (p.id !== undefined && tasksByProject.has(p.id)) pMap.set(p.id, p)
    }

    // Project nodes
    const projectNodes: Node[] = [...pMap.values()].map((p) => ({
      id: `proj-${p.id}`,
      type: 'projectNode',
      position: { x: 0, y: 0 },
      data: { name: p.name, color: p.color, taskCount: tasksByProject.get(p.id!)!.length },
    }))

    // Unassigned group node
    if (unassignedTasks.length > 0) {
      projectNodes.push({
        id: `proj-${UNASSIGNED_KEY}`,
        type: 'projectNode',
        position: { x: 0, y: 0 },
        data: { name: 'Unassigned', color: UNASSIGNED_COLOR, taskCount: unassignedTasks.length } as any,
      })
    }

    // Task nodes
    const taskNodes: Node[] = visibleTasks.map((t) => {
      const proj = t.projectId !== undefined ? pMap.get(t.projectId) : undefined
      return {
        id: String(t.id),
        type: 'taskNode',
        position: { x: 0, y: 0 },
        data: { task: t, allTasks: tasks, selected: false, projectColor: proj?.color ?? (t.projectId === undefined ? UNASSIGNED_COLOR : undefined) },
      }
    })

    const nodes: Node[] = [...projectNodes, ...taskNodes]

    const edges: Edge[] = []

    // Project → root task edges (only tasks with no parent in the same project)
    for (const [projectId, projectTasks] of tasksByProject) {
      const project = pMap.get(projectId)
      if (!project) continue
      const projectTaskIds = new Set(projectTasks.map(t => t.id!))
      for (const t of projectTasks) {
        const hasParentInProject = t.dependencies.some(depId => projectTaskIds.has(depId))
        if (hasParentInProject) continue
        edges.push({
          id: `proj-${projectId}-t-${t.id}`,
          source: `proj-${projectId}`,
          target: String(t.id),
          style: { stroke: project.color, strokeWidth: 1.5, strokeDasharray: '6 3' },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: project.color,
          },
        })
      }
    }

    // Unassigned → root task edges
    if (unassignedTasks.length > 0) {
      const unassignedTaskIds = new Set(unassignedTasks.map(t => t.id!))
      for (const t of unassignedTasks) {
        const hasParentInGroup = t.dependencies.some(depId => unassignedTaskIds.has(depId))
        if (hasParentInGroup) continue
        edges.push({
          id: `proj-${UNASSIGNED_KEY}-t-${t.id}`,
          source: `proj-${UNASSIGNED_KEY}`,
          target: String(t.id),
          style: { stroke: UNASSIGNED_COLOR, strokeWidth: 1.5, strokeDasharray: '6 3' },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: UNASSIGNED_COLOR,
          },
        })
      }
    }

    // Task → task dependency edges (only between visible tasks)
    for (const t of visibleTasks) {
      if (t.id === undefined) continue
      for (const depId of t.dependencies) {
        if (visibleTaskIds.has(depId) && tMap.has(depId)) {
          const sourceTask = tMap.get(depId)!
          const sourceColor = getStatusColor(sourceTask.status)
          edges.push({
            id: `e${depId}-${t.id}`,
            source: String(depId),
            target: String(t.id),
            animated: sourceTask.status === 'in_progress',
            style: { stroke: sourceColor, strokeWidth: 2 },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: sourceColor,
            },
          })
        }
      }
    }

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(nodes, edges)
    return { initialNodes: layoutedNodes, initialEdges: layoutedEdges, taskMap: tMap }
  }, [tasks, projects, activeFilters, showAll])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Sync when tasks change
  useEffect(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
  }, [initialNodes, initialEdges, setNodes, setEdges])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.id.startsWith('proj-')) return
      setSelectedTaskId(Number(node.id))
    },
    []
  )

  const selectedTask = selectedTaskId !== null ? taskMap.get(selectedTaskId) : undefined

  // Stats
  const activeNodes = tasks?.filter((t) => t.status === 'in_progress').length ?? 0
  const totalEdges = initialEdges.filter(e => !e.id.startsWith('proj-')).length
  const hasAnyEdges = initialEdges.length > 0
  const hasTasks = (tasks?.length ?? 0) > 0

  if (!tasks) return null

  // Empty state
  if (!hasTasks) {
    return (
      <div className="p-8 flex flex-col items-center justify-center h-[calc(100vh-4rem-var(--timer-bar-height,0px))]">
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold tracking-tighter uppercase">
            Dependency <span className="text-primary">Flux_Graph</span>
          </h1>
          <p className="text-muted-foreground text-sm tracking-widest uppercase">
            No tasks found. Create tasks with dependencies to visualize the graph.
          </p>
          <Link
            to="/tasks/new"
            className="inline-block px-6 py-2 bg-primary text-primary-foreground text-xs tracking-widest uppercase font-bold hover:opacity-90 transition-opacity"
          >
            Create Task
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem-var(--timer-bar-height,0px))]">
      {/* Header */}
      <header className="flex items-end justify-between p-6 pb-2 flex-shrink-0">
        <div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tighter uppercase leading-none">
            Dependency <span className="text-primary">Flux_Graph</span>
          </h1>
          <p className="text-muted-foreground text-sm tracking-[0.2em] uppercase mt-1">
            System Topology
          </p>
        </div>
        <div className="flex gap-6">
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground tracking-widest uppercase">
              Active Nodes
            </div>
            <div className="text-xl font-bold font-mono text-primary">{activeNodes}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground tracking-widest uppercase">
              System Load
            </div>
            <div className="text-xl font-bold font-mono">
              {totalEdges} <span className="text-xs text-muted-foreground">edges</span>
            </div>
          </div>
        </div>
      </header>

      {/* Project Filter Bar — compact chips + dialog */}
      {filterOptions.length > 0 && (
        <div className="flex items-center gap-2 px-6 py-2 flex-shrink-0">
          <span className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mr-1">Showing</span>

          {/* Selected project chips */}
          {showAll ? (
            <span className="px-3 py-1 text-[10px] uppercase tracking-widest font-bold border border-secondary/40 text-secondary bg-secondary/10">
              All Projects
            </span>
          ) : (
            filterOptions
              .filter(opt => activeFilters?.has(opt.key))
              .map(opt => (
                <button
                  key={opt.key}
                  onClick={() => toggleFilter(opt.key)}
                  className="flex items-center gap-1.5 px-3 py-1 text-[10px] uppercase tracking-widest font-bold border transition-colors group"
                  style={{
                    backgroundColor: `${opt.color}15`,
                    borderColor: opt.color,
                    color: opt.color,
                  }}
                >
                  <span
                    className="w-2 h-2 flex-shrink-0"
                    style={{ backgroundColor: opt.color }}
                  />
                  {opt.label}
                  <span className="text-[8px] opacity-60">{opt.count}</span>
                  <span className="material-symbols-outlined text-xs opacity-0 group-hover:opacity-100 transition-opacity">close</span>
                </button>
              ))
          )}

          {activeFilters?.size === 0 && (
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
              No projects selected
            </span>
          )}

          {/* Filter dialog trigger */}
          <Dialog open={filterDialogOpen} onOpenChange={(open) => { setFilterDialogOpen(open); if (!open) setFilterSearch('') }}>
            <DialogTrigger asChild>
              <button className="flex items-center gap-1.5 px-3 py-1 text-[10px] uppercase tracking-widest font-bold border border-muted-foreground/20 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors">
                <span className="material-symbols-outlined text-sm">filter_list</span>
                Filter
                {!showAll && selectedCount > 0 && (
                  <span className="bg-primary/20 text-primary px-1.5 py-0.5 text-[8px] font-bold">
                    {selectedCount}
                  </span>
                )}
              </button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="uppercase tracking-widest text-sm">Project Filter</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                {/* Search */}
                <input
                  type="text"
                  placeholder="Search projects..."
                  value={filterSearch}
                  onChange={e => setFilterSearch(e.target.value)}
                  className="w-full bg-input border border-border focus:border-primary text-sm py-2 px-3 uppercase tracking-widest placeholder:normal-case placeholder:tracking-normal"
                  autoFocus
                />

                {/* Quick actions */}
                <div className="flex gap-2">
                  <button
                    onClick={() => setActiveFilters(null)}
                    className="flex-1 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold border border-secondary/30 text-secondary hover:bg-secondary/10 transition-colors"
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => setActiveFilters(new Set())}
                    className="flex-1 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold border border-muted-foreground/20 text-muted-foreground hover:bg-accent transition-colors"
                  >
                    Clear All
                  </button>
                </div>

                {/* Project list */}
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {filterOptions
                    .filter(opt => !filterSearch || opt.label.toLowerCase().includes(filterSearch.toLowerCase()))
                    .map(opt => {
                      const isActive = showAll || (activeFilters?.has(opt.key) ?? false)
                      return (
                        <button
                          key={opt.key}
                          onClick={() => toggleFilter(opt.key)}
                          className="w-full flex items-center gap-3 p-3 transition-colors hover:bg-accent/50 text-left"
                          style={{
                            backgroundColor: isActive ? `${opt.color}10` : undefined,
                          }}
                        >
                          {/* Checkbox indicator */}
                          <div
                            className="w-4 h-4 border flex-shrink-0 flex items-center justify-center"
                            style={{
                              borderColor: isActive ? opt.color : 'var(--muted-foreground)',
                              backgroundColor: isActive ? opt.color : 'transparent',
                            }}
                          >
                            {isActive && (
                              <span className="material-symbols-outlined text-[10px] text-card font-bold">check</span>
                            )}
                          </div>

                          <span
                            className="w-3 h-3 flex-shrink-0"
                            style={{ backgroundColor: opt.color }}
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-bold uppercase tracking-widest">
                              {opt.label}
                            </span>
                          </div>
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {opt.count} task{opt.count !== 1 ? 's' : ''}
                          </span>
                        </button>
                      )
                    })}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* Graph Area */}
      <div className="flex-1 relative">
        {!hasAnyEdges && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div className="bg-card/90 backdrop-blur-md border border-muted-foreground/20 p-8 text-center pointer-events-auto">
              <p className="text-muted-foreground text-xs tracking-widest uppercase mb-2">
                No dependency edges found
              </p>
              <p className="text-muted-foreground/60 text-[10px] tracking-wider uppercase">
                Tasks are shown but have no dependencies linking them.
                <br />
                Add dependencies to tasks to see the graph connections.
              </p>
            </div>
          </div>
        )}

        <ReactFlow
          key={activeFilters === null ? 'all' : [...activeFilters].sort().join(',')}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="rgba(0, 251, 251, 0.08)"
          />
          <Controls
            className="!bg-card/80 !border-muted-foreground/20 !backdrop-blur-md !shadow-none [&>button]:!bg-card [&>button]:!border-muted-foreground/20 [&>button]:!text-foreground [&>button:hover]:!bg-muted"
          />

          {/* Legend */}
          <Panel position="top-left">
            <div className="bg-card/80 backdrop-blur-md border border-muted-foreground/20 p-3 space-y-2">
              <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-2">
                Status Legend
              </div>
              {ALL_STATUSES.map((status) => {
                const color = getStatusColor(status)
                return (
                  <div key={status} className="flex items-center gap-2">
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{
                        backgroundColor: color,
                        boxShadow: `0 0 6px ${color}`,
                      }}
                    />
                    <span className="text-[10px] uppercase tracking-wider">
                      {getStatusLabel(status)}
                    </span>
                  </div>
                )
              })}
            </div>
          </Panel>
        </ReactFlow>

        {/* Detail Panel */}
        {selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            allTasks={tasks ?? []}
            taskMap={taskMap}
            onClose={() => setSelectedTaskId(null)}
          />
        )}
      </div>
    </div>
  )
}
