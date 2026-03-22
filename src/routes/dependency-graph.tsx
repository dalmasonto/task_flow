import { useMemo, useState, useCallback } from 'react'
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
import { getStatusColor, getStatusLabel } from '@/lib/status'
import type { Task, TaskStatus } from '@/types'

// ---------- Dagre layout ----------

function getLayoutedElements(nodes: Node[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 80, ranksep: 150 })

  nodes.forEach((node) => g.setNode(node.id, { width: 220, height: 120 }))
  edges.forEach((edge) => g.setEdge(edge.source, edge.target))

  dagre.layout(g)

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id)
    return { ...node, position: { x: pos.x - 110, y: pos.y - 60 } }
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
  selected: boolean
}

function TaskNode({ data, id }: NodeProps<Node<TaskNodeData>>) {
  const task = data.task as Task
  const statusColor = getStatusColor(task.status)
  const progress = getProgress(task.status)

  return (
    <div
      className="group bg-card/90 backdrop-blur-sm border border-muted-foreground/20 w-[220px] h-[120px] relative transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50"
      style={{ borderLeft: `3px solid ${statusColor}` }}
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
              {getStatusLabel(task.status)}
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

const nodeTypes: NodeTypes = {
  taskNode: TaskNode,
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

// ---------- Main Component ----------

export default function DependencyGraph() {
  const tasks = useTasks()
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)

  // Build nodes & edges from tasks
  const { initialNodes, initialEdges, taskMap } = useMemo(() => {
    if (!tasks || tasks.length === 0) {
      return { initialNodes: [], initialEdges: [], taskMap: new Map<number, Task>() }
    }

    const tMap = new Map<number, Task>()
    for (const t of tasks) {
      if (t.id !== undefined) tMap.set(t.id, t)
    }

    const nodes: Node[] = tasks
      .filter((t) => t.id !== undefined)
      .map((t) => ({
        id: String(t.id),
        type: 'taskNode',
        position: { x: 0, y: 0 },
        data: { task: t, selected: false },
      }))

    const edges: Edge[] = []
    for (const t of tasks) {
      if (t.id === undefined) continue
      for (const depId of t.dependencies) {
        if (tMap.has(depId)) {
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
  }, [tasks])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Sync when tasks change
  useMemo(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
  }, [initialNodes, initialEdges, setNodes, setEdges])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedTaskId(Number(node.id))
    },
    []
  )

  const selectedTask = selectedTaskId !== null ? taskMap.get(selectedTaskId) : undefined

  // Stats
  const activeNodes = tasks?.filter((t) => t.status === 'in_progress').length ?? 0
  const totalEdges = initialEdges.length
  const hasDependencies = initialEdges.length > 0
  const hasTasks = (tasks?.length ?? 0) > 0

  if (!tasks) return null

  // Empty state
  if (!hasTasks) {
    return (
      <div className="p-8 flex flex-col items-center justify-center h-[calc(100vh-4rem)]">
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
    <div className="flex flex-col h-[calc(100vh-4rem)]">
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

      {/* Graph Area */}
      <div className="flex-1 relative">
        {!hasDependencies && (
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
          <div className="absolute top-0 right-0 h-full w-80 bg-card/95 backdrop-blur-md border-l border-muted-foreground/20 z-20 overflow-y-auto">
            <div className="p-6 space-y-6">
              {/* Close */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground tracking-[0.2em] uppercase">
                  Node Details
                </span>
                <button
                  onClick={() => setSelectedTaskId(null)}
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
                  TASK-{selectedTask.id}
                </div>
              </div>

              {/* Title */}
              <div>
                <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
                  Title
                </div>
                <div className="text-sm font-bold uppercase tracking-tight">
                  {selectedTask.title}
                </div>
              </div>

              {/* Description */}
              {selectedTask.description && (
                <div>
                  <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
                    Description
                  </div>
                  <div className="text-xs text-muted-foreground leading-relaxed line-clamp-4">
                    {selectedTask.description}
                  </div>
                </div>
              )}

              {/* Status */}
              <div>
                <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
                  Status
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{
                      backgroundColor: getStatusColor(selectedTask.status),
                      boxShadow: `0 0 6px ${getStatusColor(selectedTask.status)}`,
                    }}
                  />
                  <span
                    className="text-xs uppercase tracking-widest font-bold"
                    style={{ color: getStatusColor(selectedTask.status) }}
                  >
                    {getStatusLabel(selectedTask.status)}
                  </span>
                </div>
              </div>

              {/* Priority */}
              <div>
                <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-1">
                  Priority
                </div>
                <span className="text-xs uppercase tracking-widest font-bold">
                  {selectedTask.priority}
                </span>
              </div>

              {/* Dependencies */}
              {selectedTask.dependencies.length > 0 && (
                <div>
                  <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-2">
                    Depends On
                  </div>
                  <div className="space-y-1.5">
                    {selectedTask.dependencies.map((depId) => {
                      const dep = taskMap.get(depId)
                      if (!dep) return null
                      const depColor = getStatusColor(dep.status)
                      return (
                        <div
                          key={depId}
                          className="flex items-center gap-2 text-xs"
                        >
                          <div
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: depColor }}
                          />
                          <span className="font-mono text-muted-foreground">
                            #{depId}
                          </span>
                          <span className="uppercase tracking-tight truncate">
                            {dep.title}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Dependents */}
              {(() => {
                const dependents = tasks?.filter(
                  (t) =>
                    t.id !== undefined &&
                    selectedTask.id !== undefined &&
                    t.dependencies.includes(selectedTask.id)
                )
                if (!dependents || dependents.length === 0) return null
                return (
                  <div>
                    <div className="text-[8px] text-muted-foreground tracking-[0.2em] uppercase mb-2">
                      Depended By
                    </div>
                    <div className="space-y-1.5">
                      {dependents.map((dep) => {
                        const depColor = getStatusColor(dep.status)
                        return (
                          <div
                            key={dep.id}
                            className="flex items-center gap-2 text-xs"
                          >
                            <div
                              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                              style={{ backgroundColor: depColor }}
                            />
                            <span className="font-mono text-muted-foreground">
                              #{dep.id}
                            </span>
                            <span className="uppercase tracking-tight truncate">
                              {dep.title}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              {/* Edit Button */}
              <Link
                to={`/tasks/${selectedTask.id}`}
                className="block w-full text-center px-4 py-2.5 bg-primary text-primary-foreground text-[10px] tracking-widest uppercase font-bold hover:opacity-90 transition-opacity"
              >
                Edit Task Details
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
