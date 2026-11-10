/// The v3 Database page (#1148), from the design's database.html,
/// database--data.html and database--model.html, on the #885 backend.
///
/// The project's data model as its agents wrote it (`db_write_model`) and a
/// person edited it: the database room's chat on the left, the schema map (or
/// a model's sample rows) in the middle, and the models list on the right,
/// which the model editor takes over while a model is open. A field a person
/// changes becomes theirs and locked; agents must ask before touching it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Background, Controls, type Edge, MarkerType, MiniMap, type Node, type NodeChange, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, useViewport } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { DatabaseIcon, GitBranchIcon, HashIcon, HistoryIcon, MessageSquareIcon, MinusIcon, MousePointerClickIcon, PlusIcon, RefreshCwIcon, SearchIcon, TableIcon, XIcon } from "lucide-react"

import { AgentsConversationView } from "@/components/chat/conversation-view"
import { useAgentChat } from "@/components/chat/use-agent-chat"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import {
  DbSaveError,
  fetchDbRoom,
  fetchDbSchema,
  fetchDbVersions,
  restoreDbVersion,
  saveDbSchema,
  type DbModel,
  type DbSchema,
  type DbSchemaDoc,
  type DbVersionSummary,
} from "@/lib/db-api"
import { liveId } from "@/lib/live-mappers"
import { cn } from "@/lib/utils"
import type { Project } from "@/lib/workspace-view"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { timeAgo } from "../lib/time"
import { useDetail } from "../lib/use-detail"
import { seedTaskFrom } from "../tasks/task-seed"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { DataTab } from "./data-tab"
import { cardinality, facingSides, fkEdges, groupsOf, layoutModels, relatedModels, sourceHandle, targetHandle, toneFor, withModel } from "./db-graph"
import { matchModels } from "./db-search"
import { DbTableNode } from "./db-table-node"
import { ModelEditor } from "./model-editor"

const NODE_TYPES = { table: DbTableNode }
const REFRESH_MS = 10_000

type SaveState = { message: string; errors: string[]; stale: boolean } | null

export function DatabasePage() {
  const { activeProject } = useWorkspace()
  const [reload, setReload] = useState(0)
  return (
    <V3Shell
      title="Database"
      flush
      actions={
        <Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)} title="Fetch the latest schema, with anything agents wrote since">
          <RefreshCwIcon />
          <span className="hidden sm:inline">Read schema again</span>
        </Button>
      }
    >
      {activeProject ? (
        <ReactFlowProvider>
          <DatabaseWorkspace project={activeProject} reload={reload} />
        </ReactFlowProvider>
      ) : (
        <Empty className="mx-auto mt-16 max-w-md rounded-2xl border border-dashed">
          <EmptyHeader>
            <EmptyTitle>No project yet</EmptyTitle>
            <EmptyDescription>A data model belongs to a project. Create one to start.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </V3Shell>
  )
}

function DatabaseWorkspace({ project, reload }: { project: Project; reload: number }) {
  const projectId = liveId(project.id)
  const now = useLivenessNow()
  const [schema, setSchema] = useState<DbSchema | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<"schema" | "data">("schema")
  const [selected, setSelected] = useState<string | null>(null)
  const [draftNew, setDraftNew] = useState<DbModel | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<SaveState>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)
  const [query, setQuery] = useState("")
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  // React Flow hides a node until it has measured it; a controlled node list
  // must hand the measurement back or the tables never appear.
  const [measured, setMeasured] = useState<Map<string, { width?: number; height?: number }>>(new Map())

  const load = useCallback(async () => {
    if (!projectId) return
    try {
      const next = await fetchDbSchema(projectId)
      setSchema((cur) => (cur && cur.version === next.version ? cur : next))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load the schema.")
    }
  }, [projectId])

  // First load (and "Read schema again"), then a quiet refresh while the tab
  // is visible, so a model an agent writes shows up without a reload.
  useEffect(() => {
    const first = setTimeout(() => void load(), 0)
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, REFRESH_MS)
    return () => {
      clearTimeout(first)
      clearInterval(tick)
    }
  }, [load, reload])

  const doc: DbSchemaDoc = useMemo(() => schema?.doc ?? { models: [] }, [schema])
  const version = schema?.version ?? 0
  const openModel = draftNew ?? doc.models.find((m) => m.name === selected) ?? null

  const layout = useMemo(() => layoutModels(doc), [doc])
  const related = useMemo(() => (openModel ? relatedModels(doc, openModel.name) : null), [doc, openModel])
  const nodes: Node[] = useMemo(
    () =>
      doc.models.map((m) => ({
        id: m.name,
        type: "table",
        position: positions.get(m.name) ?? layout.get(m.name) ?? { x: 0, y: 0 },
        measured: measured.get(m.name),
        data: { model: m, dot: toneFor(doc, m.group).dot, faded: related ? !related.has(m.name) : false, selected: openModel?.name === m.name },
      })),
    [doc, layout, positions, measured, related, openModel],
  )
  // Column to column (database.html): from the foreign-key field's row to the
  // target's key row, arrow at the target, in the target group's colour.
  const edges: Edge[] = useMemo(() => {
    // Brackets that share a side lane (same-column relations, self-joins)
    // each get their own offset, so stacked lines stay readable.
    const lane = new Map<string, number>()
    return fkEdges(doc).map((e) => {
        const target = doc.models.find((m) => m.name === e.target)
        const colour = toneFor(doc, target?.group).line
        const dim = related && !(related.has(e.source) && related.has(e.target))
        const at = (name: string) => (positions.get(name) ?? layout.get(name) ?? { x: 0 }).x
        const sides = facingSides(at(e.source), at(e.target), e.selfJoin)
        const laneKey = sides.from === sides.to ? `${Math.round(at(e.source))}:${sides.from}` : ""
        const nth = laneKey ? (lane.get(laneKey) ?? 0) : 0
        if (laneKey) lane.set(laneKey, nth + 1)
        const holder = doc.models.find((m) => m.name === e.source)
        const field = holder?.fields.find((f) => f.name === e.field)
        const kind = holder && field ? cardinality(holder, field) : "N:1"
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: sourceHandle(e.field, sides.from),
          targetHandle: e.targetField ? targetHandle(e.targetField, sides.to) : undefined,
          type: "smoothstep",
          pathOptions: { offset: 18 + nth * 14, borderRadius: 6 },
          markerEnd: { type: MarkerType.ArrowClosed, color: colour, width: 16, height: 16 },
          // N:1 many-to-one, 1:1 one-to-one, M:N half of a join table.
          label: kind,
          labelStyle: { fontSize: 10, fontFamily: "var(--font-mono)", fill: colour, fontWeight: 600 },
          labelBgStyle: { fill: "var(--card)" },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          labelShowBg: true,
          style: { stroke: colour, strokeWidth: 1.5, strokeDasharray: e.selfJoin ? "6 4" : undefined, opacity: dim ? 0.2 : 1 },
        }
      })
  }, [doc, related, positions, layout])
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const next = applyNodeChanges(changes, nodes)
      if (changes.some((c) => c.type === "position")) setPositions(new Map(next.map((n) => [n.id, n.position])))
      if (changes.some((c) => c.type === "dimensions")) setMeasured(new Map(next.map((n) => [n.id, n.measured ?? {}])))
    },
    [nodes],
  )

  const open = (name: string | null) => {
    setDraftNew(null)
    setSaveError(null)
    setSelected(name)
  }

  const commit = async (next: DbSchemaDoc) => {
    if (!projectId) return false
    setBusy(true)
    setSaveError(null)
    try {
      setSchema(await saveDbSchema(projectId, version, next))
      return true
    } catch (err) {
      if (err instanceof DbSaveError) {
        setSaveError({ message: err.message, errors: err.errors, stale: err.code === "version_conflict" })
        if (err.code === "version_conflict") void load()
      } else {
        setSaveError({ message: err instanceof Error ? err.message : "The save didn't go through.", errors: [], stale: false })
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!projectId) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar (database.html) */}
      <div className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-3 [&>*]:shrink-0">
        <Button variant={chatOpen ? "secondary" : "ghost"} size="sm" aria-pressed={chatOpen} onClick={() => setChatOpen((o) => !o)}>
          <MessageSquareIcon />
          Chat
        </Button>
        <span className="h-5 w-px bg-border" aria-hidden />
        <div className="inline-flex rounded-md border border-border p-0.5 text-sm" role="tablist" aria-label="Database view">
          {(
            [
              ["schema", "Schema", GitBranchIcon],
              ["data", "Data", TableIcon],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn("inline-flex h-7 items-center gap-1.5 rounded px-2.5", tab === id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground md:inline-flex">
          {version === 0 ? (
            "No models yet"
          ) : openModel ? (
            <>
              Schema v{version} by {schema?.updated_by_label}
              {schema?.updated_at ? `, ${timeAgo(schema.updated_at, now)}` : ""}
            </>
          ) : (
            <>
              <MousePointerClickIcon className="size-3.5" />
              Click a table to edit its fields
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={version === 0} onClick={() => setVersionsOpen(true)}>
            <HistoryIcon />
            <span className="hidden sm:inline">Versions</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraftNew({ name: "NewModel", fields: [{ name: "id", type: "i64", primary_key: true }] })
              setSelected(null)
              setSaveError(null)
            }}
          >
            <PlusIcon />
            <span className="hidden sm:inline">New model</span>
          </Button>
          {tab === "schema" && doc.models.length ? <ZoomControls /> : null}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* LEFT: the database room */}
        {chatOpen ? (
          <aside className="absolute inset-y-0 left-0 z-30 flex w-[min(20rem,100%)] min-h-0 flex-col border-r border-border bg-background shadow-2xl lg:relative lg:z-auto lg:w-80 lg:shrink-0 lg:shadow-none">
            <DbRoom projectId={projectId} project={project} onClose={() => setChatOpen(false)} />
          </aside>
        ) : null}

        {/* MIDDLE: the schema map, or the open model's sample rows */}
        <main className="relative min-w-0 flex-1 bg-muted/30">
          {loadError ? (
            <p className="p-8 text-sm text-destructive">{loadError}</p>
          ) : tab === "schema" ? (
            doc.models.length === 0 && !draftNew ? (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <DatabaseIcon />
                  </EmptyMedia>
                  <EmptyTitle>No models yet</EmptyTitle>
                  <EmptyDescription>
                    Agents write this project&apos;s models with <code>db_write_model</code> as they build. Ask one in the chat, or add a model yourself.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={NODE_TYPES}
                  onNodesChange={onNodesChange}
                  onNodeClick={(_, node) => open(node.id)}
                  onPaneClick={() => open(null)}
                  fitView
                  minZoom={0.2}
                  proOptions={{ hideAttribution: true }}
                  nodesConnectable={false}
                  // Pan by dragging the background, zoom with the wheel or a
                  // pinch, Shift-drag to box-select tables (then drag them together).
                  panOnDrag
                  zoomOnScroll
                  selectionKeyCode="Shift"
                  multiSelectionKeyCode={["Meta", "Control"]}
                  className="[--xy-controls-button-background-color:var(--card)] [--xy-controls-button-background-color-hover:var(--accent)] [--xy-controls-button-border-color:var(--border)] [--xy-controls-button-color:var(--foreground)] [--xy-minimap-background-color:var(--card)]"
                >
                  <Background gap={20} size={1} />
                  {/* Zoom in / out, fit (centre) and lock, bottom right. */}
                  <Controls position="bottom-right" showInteractive aria-label="Map controls" />
                  <MiniMap position="top-left" pannable zoomable nodeColor="var(--muted-foreground)" maskColor="color-mix(in oklab, var(--background) 70%, transparent)" className="!h-24 !w-36 rounded-md border border-border" />
                </ReactFlow>
                <Legend />
              </>
            )
          ) : openModel && !draftNew ? (
            <DataTab key={`${openModel.name}@${version}`} model={openModel} busy={busy} onSave={(rows) => void commit(withModel(doc, { ...openModel, samples: rows }))} />
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <TableIcon />
                </EmptyMedia>
                <EmptyTitle>Pick a model</EmptyTitle>
                <EmptyDescription>Choose one on the right to see and edit its sample rows.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </main>

        {/* RIGHT: the models list, or the editor for the open model */}
        <aside className="hidden min-h-0 w-80 shrink-0 flex-col border-l border-border bg-background md:flex">
          {openModel ? (
            <ModelEditor
              key={`${draftNew ? "new" : openModel.name}@${version}`}
              doc={doc}
              model={openModel}
              isNew={!!draftNew}
              version={version}
              busy={busy}
              error={saveError}
              onClose={() => open(null)}
              onSave={async (model, previousName) => {
                if (await commit(withModel(doc, model, previousName))) {
                  setDraftNew(null)
                  setSelected(model.name)
                }
              }}
              onDelete={async () => {
                if (!window.confirm(`Delete ${openModel.name}? Versions can bring it back.`)) return
                if (await commit({ ...doc, models: doc.models.filter((m) => m.name !== openModel.name) })) setSelected(null)
              }}
            />
          ) : (
            <ModelsList doc={doc} schema={schema} selected={selected} query={query} onQuery={setQuery} onSelect={open} />
          )}
        </aside>
      </div>

      {versionsOpen ? (
        <VersionsDialog
          projectId={projectId}
          current={version}
          onClose={() => setVersionsOpen(false)}
          onRestored={(next) => {
            setSchema(next)
            setVersionsOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

/// database.html's "− 100% +" in the toolbar.
function ZoomControls() {
  const flow = useReactFlow()
  const { zoom } = useViewport()
  return (
    <div className="flex items-center rounded-md border border-border">
      <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => void flow.zoomOut()}>
        <MinusIcon />
      </Button>
      <button type="button" className="w-12 text-center text-xs tabular-nums" title="Fit the whole schema" onClick={() => void flow.fitView()}>
        {Math.round(zoom * 100)}%
      </button>
      <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => void flow.zoomIn()}>
        <PlusIcon />
      </Button>
    </div>
  )
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-0.5 w-4 bg-chart-1" aria-hidden />
        relation, arrow at the model it points to
      </span>
      <span>
        <b className="font-mono">N:1</b> many-to-one · <b className="font-mono">1:1</b> one-to-one · <b className="font-mono">M:N</b> many-to-many (through a join table)
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="w-4 border-t-2 border-dashed border-chart-1" aria-hidden />
        joins a model to itself
      </span>
      <span>? optional</span>
    </div>
  )
}

function ModelsList({
  doc,
  schema,
  selected,
  query,
  onQuery,
  onSelect,
}: {
  doc: DbSchemaDoc
  schema: DbSchema | null
  selected: string | null
  query: string
  onQuery: (q: string) => void
  onSelect: (name: string) => void
}) {
  const now = useLivenessNow()
  const shown = useMemo(() => new Set(matchModels(doc, query).map((m) => m.name)), [doc, query])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Find a model or field" aria-label="Find a model or field" className="h-8 pl-8" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <ul className="space-y-3 text-sm">
          {groupsOf(doc).map((g) => {
            const all = doc.models.filter((m) => (m.group ?? "") === g)
            const models = all.filter((m) => shown.has(m.name))
            if (!models.length) return null
            return (
              <li key={g || "_"}>
                <p className="flex items-center gap-2 px-1 pb-1 text-xs font-medium text-muted-foreground">
                  <span className={cn("size-2 rounded-full", toneFor(doc, g || undefined).dot)} aria-hidden />
                  {g || "Other"}
                  <span className="ml-auto tabular-nums">{all.length}</span>
                </p>
                <ul className="space-y-0.5 font-mono text-xs">
                  {models.map((m) => (
                    <li key={m.name}>
                      <button
                        type="button"
                        onClick={() => onSelect(m.name)}
                        aria-current={selected === m.name ? "true" : undefined}
                        className={cn("flex w-full items-center rounded-md px-2 py-1.5 text-left hover:bg-accent", selected === m.name && "bg-accent font-semibold")}
                      >
                        <span className="truncate">{m.name}</span>
                        <span className="ml-auto pl-2 text-muted-foreground">{m.fields.length}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
          {doc.models.length && !shown.size ? <li className="px-1 text-xs text-muted-foreground">No model or field matches.</li> : null}
        </ul>
      </div>
      {schema && schema.version > 0 ? (
        <p className="border-t border-border p-3 text-xs text-muted-foreground">
          Schema v{schema.version}, saved by {schema.updated_by_label}
          {schema.updated_at ? ` ${timeAgo(schema.updated_at, now)}` : ""}.
        </p>
      ) : null}
    </div>
  )
}

function VersionsDialog({ projectId, current, onClose, onRestored }: { projectId: number; current: number; onClose: () => void; onRestored: (next: DbSchema) => void }) {
  const [versions, setVersions] = useState<DbVersionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchDbVersions(projectId)
      .then((v) => !cancelled && setVersions(v))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [projectId])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto">
        <DialogTitle>Schema versions</DialogTitle>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {versions === null && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        <ul className="divide-y divide-border text-sm">
          {(versions ?? []).map((v) => (
            <li key={v.version} className="flex items-center gap-3 py-2">
              <span className="w-10 font-mono text-xs text-muted-foreground">v{v.version}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{v.note}</span>
                <span className="text-xs text-muted-foreground">
                  {v.author_label}
                  {v.created_at ? `, ${new Date(v.created_at).toLocaleString()}` : ""}
                </span>
              </span>
              {v.version === current ? (
                <span className="text-xs text-muted-foreground">Current</span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      onRestored(await restoreDbVersion(projectId, v.version, current))
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "The restore didn't go through.")
                    }
                  }}
                >
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/// The database room, found by the id the backend gives for it (not by
/// title). It is created on first use, so a project that just got one
/// refreshes its channel list once to see it.
function DbRoom({ projectId, project, onClose }: { projectId: number; project: Project; onClose: () => void }) {
  const { live, currentUser, applyLiveUpdate, reloadLive, setChatSurfaceMounted } = useWorkspace()
  const detail = useDetail()
  const [room, setRoom] = useState<{ id: number; title: string } | null>(null)
  const [roomError, setRoomError] = useState<string | null>(null)
  const refreshed = useRef(false)

  // The chat slices (messages, read cursors) load while this room is up.
  useEffect(() => {
    setChatSurfaceMounted(true)
    return () => setChatSurfaceMounted(false)
  }, [setChatSurfaceMounted])

  useEffect(() => {
    let cancelled = false
    fetchDbRoom(projectId)
      .then((r) => !cancelled && setRoom({ id: r.channel_id, title: r.title }))
      .catch((e: Error) => !cancelled && setRoomError(e.message))
    return () => {
      cancelled = true
    }
  }, [projectId])

  const known = !!room && !!live?.agentChannels.some((c) => c.id === room.id)
  useEffect(() => {
    if (room && live?.agentChannelsLoaded && !known && !refreshed.current) {
      refreshed.current = true
      void reloadLive()
    }
  }, [room, known, live?.agentChannelsLoaded, reloadLive])

  const { outletContext } = useAgentChat({
    project,
    liveWorkspace: live,
    currentUser,
    onWorkspaceUpdate: applyLiveUpdate,
    onRefreshWorkspace: reloadLive,
    selectedChatId: room ? `live:channel:${room.id}` : null,
    onComposeTask: (body) => {
      if (seedTaskFrom(body)) detail.open({ kind: "new-task", status: "not_started" })
    },
  })
  const chat = outletContext.selectedChat
  const agents = live?.agents ?? []
  const renderAvatar = (from: string) => {
    if (from === "user") return <ActorAvatar name={currentUser?.username || "You"} size="md" />
    const a = agents.find((x) => x.display_name === from)
    return <ActorAvatar name={from} model={a ? (guessModel(a.runtime) ?? guessModel(a.display_name)) : null} size="md" />
  }

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <HashIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{room?.title ?? "Database room"}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Close the chat" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {roomError ? (
        <p className="p-4 text-sm text-destructive">{roomError}</p>
      ) : !chat || !room || chat.id !== `live:channel:${room.id}` ? (
        <p className="p-4 text-sm text-muted-foreground">Opening the database room…</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <AgentsConversationView
            {...outletContext}
            selectedChat={chat}
            bare
            messageLayout="row"
            composerStyle="v3"
            renderAvatar={renderAvatar}
            senderBadge={(from) => (agents.some((a) => a.display_name === from) ? "agent" : null)}
          />
          <p className="shrink-0 px-3 pb-3 text-xs text-muted-foreground">
            Agents read this schema with <code>db_schema</code>. A field you change is yours: they have to ask before touching it.
          </p>
        </div>
      )}
    </>
  )
}
