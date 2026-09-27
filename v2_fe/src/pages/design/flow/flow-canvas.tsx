/// #508: the Flow view — every open page as a live screen on a React Flow
/// canvas, with arrows for how a user moves between them ("new user" →
/// sign-up, "existing user" → log in).
///
/// What the view owns: node POSITIONS (drag a screen and it stays there) and
/// EDGES (drag from a screen's right handle to another's left handle to link
/// them; click a link to name or remove it). Both live in the shared layout
/// document, so an agent's `design_link_pages` shows up here live and a link
/// drawn here is what an agent reads back.
///
/// The screens are the same live, device-framed iframes the other views
/// draw, but inert here (no pointer events): this surface is for arranging
/// and linking. Inspecting an element is the other views' job.

import "@xyflow/react/dist/style.css"

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react"
import { memo, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { sandboxUrl } from "@/lib/design-api"
import { boardHeight, boardWidth, deviceById, type DevicePreset } from "@/lib/design-devices"
import { DeviceChrome, LazyFrame } from "../design-canvas"
import {
  flowPositions,
  linkPages,
  linkProblem,
  placePage,
  relabel,
  unlink,
  type FlowDoc,
} from "./flow-layout"

/// Height of the node's title strip — also its drag handle.
const HEADER_H = 40

type ScreenData = {
  route: string
  label: string
  device: DevicePreset
  src: string | null
  theme: string
  epoch: number
  /// Links in and out, shown on the strip so a dead end is visible.
  outgoing: number
  incoming: number
}

const ScreenNode = memo(function ScreenNode({ data, selected }: NodeProps<Node<ScreenData>>) {
  const { device } = data
  return (
    <div
      className={`rounded-xl transition-shadow ${selected ? "ring-2 ring-primary ring-offset-4 ring-offset-transparent" : ""}`}
      style={{ width: boardWidth(device) }}
    >
      <div
        className="flow-drag mb-2 flex cursor-grab items-center gap-2 rounded-lg border border-white/10 bg-zinc-900/90 px-3 text-white shadow-lg active:cursor-grabbing"
        style={{ height: HEADER_H }}
        title="Drag to move this screen"
      >
        <span className="truncate text-sm font-semibold">{data.label}</span>
        <span className="truncate font-mono text-[11px] text-zinc-400">{data.route}</span>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-400" title="Links in / out">
          ↘{data.incoming} ↗{data.outgoing}
        </span>
      </div>
      <div style={{ pointerEvents: "none" }}>
        <DeviceChrome device={device}>
          {data.src ? (
            <LazyFrame
              src={data.src}
              width={device.width}
              height={device.height}
              name={`flow:${data.route}`}
              theme={data.theme}
              picking={false}
              epoch={data.epoch}
            />
          ) : (
            <div style={{ width: device.width, height: device.height }} className="bg-zinc-900" />
          )}
        </DeviceChrome>
      </div>
      {/* Where links leave (right) and arrive (left) — the direction a flow
          reads. Big targets: these are what a person aims a drag at. */}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-5 !w-5 !border-2 !border-white !bg-primary"
        style={{ top: HEADER_H + boardHeight(device) / 2 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-5 !w-5 !border-2 !border-white !bg-primary"
        style={{ top: HEADER_H + boardHeight(device) / 2 }}
      />
    </div>
  )
})

const nodeTypes: NodeTypes = { screen: ScreenNode }

export function FlowCanvas({
  routes,
  doc,
  onDocChange,
  deviceId,
  sandboxToken,
  theme,
  contentEpoch,
  labelFor,
  readOnly = false,
}: {
  /// The pages on the canvas, in flow order (the open pages).
  routes: string[]
  /// The layout document (its `edges` / `positions`).
  doc: FlowDoc
  /// Save an edited document — the same path every layout edit takes.
  onDocChange: (next: FlowDoc) => void
  /// One device for every screen: a flow compares steps, not sizes.
  deviceId: string
  sandboxToken: string | null
  theme: string
  contentEpoch: number
  labelFor: (route: string) => string
  readOnly?: boolean
}) {
  const device = useMemo(() => deviceById(deviceId), [deviceId])
  const nodeSize = useMemo(() => ({ w: boardWidth(device), h: HEADER_H + 8 + boardHeight(device) }), [device])
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /// While a node is being dragged, its live position; committed on drop so a
  /// drag is ONE save, not one per pointer move.
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null)

  const onCanvas = useMemo(() => new Set(routes), [routes])
  const edgesOnCanvas = useMemo(
    () => (doc.edges ?? []).filter((e) => onCanvas.has(e.from) && onCanvas.has(e.to)),
    [doc.edges, onCanvas],
  )
  const positions = useMemo(() => flowPositions(routes, doc, nodeSize), [routes, doc, nodeSize])

  const nodes: Node<ScreenData>[] = useMemo(
    () =>
      routes.map((route) => {
        const at = dragging?.id === route ? { x: dragging.x, y: dragging.y } : positions[route]
        return {
          id: route,
          type: "screen",
          position: at,
          dragHandle: ".flow-drag",
          // Declared, not measured: iframes load late, and the minimap and
          // fit-view need a node's size before its screen has painted.
          width: nodeSize.w,
          height: nodeSize.h,
          draggable: !readOnly,
          data: {
            route,
            label: labelFor(route),
            device,
            src: sandboxToken ? sandboxUrl(sandboxToken, route) : null,
            theme,
            epoch: contentEpoch,
            outgoing: edgesOnCanvas.filter((e) => e.from === route).length,
            incoming: edgesOnCanvas.filter((e) => e.to === route).length,
          },
        }
      }),
    [routes, positions, dragging, readOnly, labelFor, device, nodeSize, sandboxToken, theme, contentEpoch, edgesOnCanvas],
  )

  const edges: Edge[] = useMemo(
    () =>
      edgesOnCanvas.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "smoothstep",
        // Moving dashes: the "live flow" — the direction a user travels.
        animated: true,
        label: e.label,
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 6,
        labelStyle: { fontSize: 14, fontWeight: 600 },
        style: { strokeWidth: selectedEdge === e.id ? 5 : 3 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
        selected: selectedEdge === e.id,
      })),
    [edgesOnCanvas, selectedEdge],
  )

  const connect = (c: Connection) => {
    if (readOnly || !c.source || !c.target) return
    const why = linkProblem(doc, c.source, c.target)
    if (why) {
      setProblem(why)
      return
    }
    setProblem(null)
    onDocChange(linkPages(doc, c.source, c.target))
  }

  const current = (doc.edges ?? []).find((e) => e.id === selectedEdge) ?? null

  return (
    <div className="h-full w-full" data-flow-canvas>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onConnect={connect}
        onNodeDrag={(_, node) => setDragging({ id: node.id, x: node.position.x, y: node.position.y })}
        onNodeDragStop={(_, node) => {
          setDragging(null)
          if (!readOnly) onDocChange(placePage(doc, node.id, node.position))
        }}
        onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
        onPaneClick={() => setSelectedEdge(null)}
        onEdgesDelete={(deleted) => {
          if (readOnly) return
          let next = doc
          for (const e of deleted) next = unlink(next, e.id)
          onDocChange(next)
          setSelectedEdge(null)
        }}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        minZoom={0.05}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
        colorMode={theme === "dark" ? "dark" : "light"}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.4} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor="#6366f1" nodeBorderRadius={12} maskColor="rgba(15, 23, 42, 0.08)" />
        {/* Bottom centre: out of the way of the screens' titles, which is
            where the first drag of any session starts. */}
        <Panel position="bottom-center">
          <div className="max-w-md rounded-lg border bg-background/95 px-3 py-2 text-center text-xs text-muted-foreground shadow-sm">
            {readOnly
              ? "Viewing the flow."
              : "Drag a screen by its title. Drag from a screen's right dot to another's left dot to link them; click a link to name or remove it."}
            {problem ? <p className="mt-1 text-rose-600 dark:text-rose-300">{problem}</p> : null}
          </div>
        </Panel>
        {current && !readOnly ? (
          <Panel position="top-right">
            <EdgeEditor
              key={current.id}
              title={`${labelFor(current.from)} → ${labelFor(current.to)}`}
              label={current.label ?? ""}
              onSave={(label) => onDocChange(relabel(doc, current.id, label))}
              onDelete={() => {
                onDocChange(unlink(doc, current.id))
                setSelectedEdge(null)
              }}
              onClose={() => setSelectedEdge(null)}
            />
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  )
}

function EdgeEditor({
  title,
  label,
  onSave,
  onDelete,
  onClose,
}: {
  title: string
  label: string
  onSave: (label: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(label)
  return (
    <form
      className="w-72 space-y-2 rounded-lg border bg-background p-3 shadow-lg"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(draft)
      }}
    >
      <p className="truncate text-sm font-semibold">{title}</p>
      <Input
        value={draft}
        maxLength={40}
        autoFocus
        placeholder="Label, e.g. new user"
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Link label"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm">
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button type="button" size="sm" variant="ghost" className="ml-auto text-rose-600" onClick={onDelete}>
          Remove link
        </Button>
      </div>
    </form>
  )
}
