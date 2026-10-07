/// The design canvas (§9.2): an infinite pannable plotting surface with
/// iframes in device frames as artboards.
///
/// Rules that matter:
/// * Zoom is CSS `transform: scale()` on the frame WRAPPER — never on the
///   iframe, whose width is the device's true CSS px. Changing the iframe
///   width would change the page's breakpoint; scale changes nothing but
///   appearance.
/// * Artboards mount lazily by intersection — a frame nobody has scrolled near
///   costs nothing — and then LATCH: mounting is one-way, and a mounted frame
///   is never unmounted. Lazy mounting is what keeps a twelve-frame canvas from
///   melting a laptop; the latch is what makes two artboards comparable, since
///   a page that tore down when scrolled past would reload and lose the live
///   state being compared. The observer's margin is 150% of the viewport.
/// * Selection rects arriving from the sandbox are divided by scale when
///   converted to canvas coordinates.

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
  ViewportPortal,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react"
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  MaximizeIcon,
  RotateCwIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  Undo2Icon,
  XIcon,
  EllipsisIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  ImageDownIcon,
  SmartphoneIcon,
  ScrollTextIcon,
  FileCodeIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { frameFor } from "./export/export-plan"
import { canvasFrame, framedViewportHeight, statusBarHtml, statusBarStyle } from "@/lib/design-frames"
import { EdgeEditor } from "./flow/edge-editor"
import { FloatingEdge } from "./flow/floating-edge"
import { linkPages, linkProblem, placePage, relabel, unlink, type FlowDoc } from "./flow/flow-layout"

import {
  DEVICE_PRESETS,
  type Artboard,
  type ChromeStyle,
  type DevicePreset,
  HEADER_H,
  classicChrome,
  boardContentOrigin,
  boardHeight,
  boardWidth,
  deviceById,
  rotateDecisionFor,
} from "@/lib/design-devices"
import { sandboxUrl, downloadPageHtml, fetchPageHtmlFragment } from "@/lib/design-api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { type CanvasTool } from "./canvas-tools"
import { boardKeyForSource } from "./design-frame-source"
import {
  frameChrome,
  inkColour,
  parseStatusBarReport,
  sameStatusBarReport,
  type FrameChrome,
  type StatusBarReport,
  type ThemeAppearance,
} from "./status-bar"
import {
  divergedRoute,
  reportedRoute,
  routeFromSandboxPath,
  sameFrameReport,
  type FrameReport,
} from "./design-route"
import { MAX_SCALE, MIN_SCALE, ZOOM_STEP } from "./canvas-zoom"

export type CanvasTransform = { x: number; y: number; scale: number }

// The zoom range's home is `canvas-zoom` (no component imports, so a pure test
// can pin the ends of the range without importing this file's React tree).
// Re-exported here because every call site reads it beside the canvas: the
// toolbar's zoom buttons, Fit's clamp and the stored-viewport sanitiser.
export { MAX_SCALE, MIN_SCALE, ZOOM_STEP }

/** How long the gesture's events must stop before the live transform is
 *  committed to React state (and, behind it, to Dexie). Trackpad wheel events
 *  arrive every 8–16ms, so 120ms swallows a whole flick; it is short enough
 *  that the committed value — the toolbar's zoom % — is never visibly behind
 *  the canvas. */
export const GESTURE_SETTLE_MS = 120

type FrameMessage =
  | { type: "design:ready"; h: number }
  | { type: "design:size"; h: number }
  | { type: "design:deselect" }
  /** Where the frame is, as the sandbox serves it (`/s/{token}{route}`) — NOT
   *  an app route. `design-route.ts` converts it, and only there. */
  | { type: "design:route"; path: string }
  | {
      type: "design:select"
      [key: string]: unknown
    }

export type DesignCanvasProps = {
  artboards: Artboard[]
  transform: CanvasTransform
  onTransformChange: (t: CanvasTransform) => void
  picking: boolean
  theme: string
  /** #626: the active theme's appearance (`themeAppearance`). Sent with
   *  `design:theme` so a frame sets its `color-scheme`, and the frame chrome's
   *  second rule for the status-bar ink. */
  appearance?: ThemeAppearance | null
  /** #626: the active theme's `--background` swatch — the strip's last fallback. */
  themeBackground?: string | null
  /** Owning project, for the per-artboard Copy HTML / Download actions
   * (`GET /api/design/{project}/page.html`). Null while the surface is still
   * resolving its project — those actions are hidden until it lands. */
  projectId: number | null
  /** The display name for a page, resolved by the CALLER through `pageLabel`
   * (label → manifest title → route). Each artboard header renders this string
   * and derives nothing itself, so it can never disagree with the Pages panel
   * or the row headers — the guess this replaced was `route === "/" ?
   * "Dashboard" : route.slice(1)`. */
  labelFor: (route: string) => string
  /** Pointer mode: "select" (today's click/pick behavior) or "pan" (plain
   * left-drag pans). Space-drag and middle-drag pan regardless of mode.
   * Defaults to "select" when omitted. */
  canvasTool?: CanvasTool
  /** Short-lived sandbox read token; frames 404 (with retry UI) without it. */
  sandboxToken: string | null
  onSelect?: (selection: Record<string, unknown>, board: Artboard) => void
  /** Bumped whenever files change server-side; remounts live iframes. */
  contentEpoch: number
  /** One counter per board, owned by the SURFACE (it owns the actions) and
   *  layered ON TOP of `contentEpoch` when each frame's key is built. The
   *  global epoch still remounts every frame — that is the "the project's
   *  content changed" signal — while a single board's Reload must remount only
   *  that board. Without this overlay one Reload click would reload the whole
   *  canvas. */
  boardEpochs: Map<string, number>
  /** The devices currently selected on the surface. "Duplicate at another
   *  device" offers the presets this list does NOT already contain. */
  deviceIds: string[]
  /** Remount this ONE board's frame. It is the whole mechanism behind "put this
   *  frame back on the page it belongs to": a frame's `src` IS that page, so a
   *  remount returns it — which is what the header's reset control and the ⋯
   *  menu's Reload both ask for. The per-board half only, never the global one:
   *  a global bump would reload every board at every device. */
  onReloadBoard: (key: string) => void
  /** Open this board's route in a new tab, in the same origin-isolated sandbox
   *  render the frame shows. */
  onOpenBoard: (key: string) => void
  /** Show this board's route at another device size. It adds the DEVICE, not a
   *  board: boards are derived from `openRoutes × deviceIds`, so that is the
   *  only way the route appears at the new size in every arrangement. */
  onDuplicateBoard: (key: string, deviceId: string) => void
  /** Close this board's route from the canvas — the page, everywhere. */
  onRemoveBoard: (route: string) => void
  /** Download this board's screen as a PNG — the visible screen or the whole
   *  page, bare or in its device's frame.
   *  Absent: the menu offers no download. */
  onDownloadImage?: (route: string, label: string, deviceId: string, withFrame: boolean, fullPage: boolean) => void
  /** Move this board's PAGE to the trash (after the menu's confirm dialog).
   *  Absent: the menu offers no delete. */
  onDeletePage?: (route: string) => void
  /** #508: the Flow view. Present, the canvas draws the layout's links
   *  between screens, lets screens be dragged (positions persist) and links be
   *  drawn, named and removed. Absent, it is a board canvas. */
  flow?: { doc: FlowDoc; onDocChange: (next: FlowDoc) => void }
  /** Current chrome-side selection (world-space overlay). */
  selection?: {
    rect: { x: number; y: number; w: number; h: number }
    boardKey: string
  } | null
  /** Rendered comment pins, positioned in world space. */
  pins?: React.ReactNode
}

/// Memoised, because the surface re-renders for reasons that have nothing to do
/// with the canvas — a toolbar toggle, a right-panel tab, an arrival in the
/// chat rail — and without this every one of them rebuilt this subtree down to
/// each board's header and frame. The props here ARE the gate: every callback
/// the surface hands down is a `useCallback` and every array/object a `useMemo`
/// (see the surface's `pinLayer`, which exists only so the pins element is not
/// rebuilt per render). A fresh object or arrow at the call site silently
/// defeats this and is invisible when it happens — pressing a button would just
/// feel a little worse.
///
/// This does NOT stop a content-epoch bump from remounting the frames: the
/// epoch is a genuine prop change, and remounting is exactly what it means.
export const DesignCanvas = memo(function DesignCanvas({
  artboards,
  transform,
  onTransformChange,
  picking,
  theme,
  appearance = null,
  themeBackground = null,
  projectId,
  labelFor,
  canvasTool = "select",
  sandboxToken,
  onSelect,
  contentEpoch,
  boardEpochs,
  deviceIds,
  onReloadBoard,
  onOpenBoard,
  onDuplicateBoard,
  onRemoveBoard,
  onDownloadImage,
  onDeletePage,
  flow,
  selection,
  pins,
}: DesignCanvasProps) {
  const rfRef = useRef<ReactFlowInstance<BoardNodeType, Edge> | null>(null)
  /// True while React Flow is running a gesture: the committed `transform`
  /// prop is then behind what is on screen, and must not be pushed back into
  /// the viewport (that would snap the canvas back under a moving hand).
  const movingRef = useRef(false)
  const [spaceDown, setSpaceDown] = useState(false)
  /** Where to deliver a route report for each board on the canvas, registered
   *  by the board itself as it mounts (`ArtboardCard`) and dropped as it
   *  unmounts. The canvas ROUTES a report; the board KEEPS it — and that split
   *  is load-bearing rather than tidy. `route@device` is a key a CLOSED board
   *  hands back to a reopened one, and the surface re-derives `artboards` from
   *  the open set, so a report held up here would outlive the frame that sent it
   *  and read as a claim about the next frame to occupy that key: a reopened
   *  board, or a device removed and selected again. Held in the board's own
   *  state, it dies with the board by construction — no clearing for anything to
   *  forget. (A new token — a project switch — is the one remount that reuses
   *  the very same board instance, so that one is the stamp's job: see
   *  `FrameReport`.) */
  const reportSinks = useRef(new Map<string, (report: FrameReport) => void>())
  const registerBoardReport = useCallback(
    (key: string, sink: (report: FrameReport) => void) => {
      const sinks = reportSinks.current
      sinks.set(key, sink)
      // Belt-and-braces, and it is only fair to say so: `registerReport` is
      // stable for the canvas's life and board keys are unique among the mounted
      // boards, so no cleanup can reach a newer registration today. The identity
      // check is what keeps that true if a future path ever re-registers a key
      // (a changed key, a second set of boards) — the failure it prevents is a
      // live sink silently deleted, which would drop a board's reports.
      return () => {
        if (sinks.get(key) === sink) sinks.delete(key)
      }
    },
    [],
  )
  const selectionBoard = selection
    ? artboards.find((b) => b.key === selection.boardKey)
    : undefined


  // --- viewport -------------------------------------------------------------
  // React Flow runs every gesture itself (drag the background, two-finger
  // scroll, pinch, Ctrl/⌘+scroll, its own +/−/fit controls) and this component
  // COMMITS the viewport when a gesture ends — the surface persists it, and the
  // toolbar's zoom % and Fit read it. A change from OUTSIDE (Fit, the toolbar
  // zoom, a stored viewport arriving) is pushed into React Flow, unless a
  // gesture is in flight.
  useEffect(() => {
    const rf = rfRef.current
    if (!rf || movingRef.current) return
    const v = rf.getViewport()
    if (
      Math.abs(v.x - transform.x) > 0.5 ||
      Math.abs(v.y - transform.y) > 0.5 ||
      Math.abs(v.zoom - transform.scale) > 0.0005
    ) {
      void rf.setViewport({ x: transform.x, y: transform.y, zoom: transform.scale })
    }
  }, [transform])

  // "Show me this board" from anywhere on the surface (the Pages panel, the
  // palette, a comment): React Flow frames that node.
  useEffect(() => {
    const onFocus = (event: Event) => {
      const key = (event as CustomEvent<string>).detail
      const rf = rfRef.current
      if (!rf || !key) return
      void rf.fitView({ nodes: [{ id: key }], duration: 350, padding: 0.35, maxZoom: Math.max(rf.getZoom(), 0.6) })
    }
    window.addEventListener(FOCUS_BOARD_EVENT, onFocus)
    return () => window.removeEventListener(FOCUS_BOARD_EVENT, onFocus)
  }, [])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) setSpaceDown(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false)
    }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
    }
  }, [])

  // --- messages from frames -------------------------------------------------
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data as FrameMessage | undefined
      if (!m || typeof m !== "object" || typeof m.type !== "string") return
      if (m.type === "design:select" && onSelect) {
        // Hostile-input rule: validate shape, clamp lengths before use.
        //
        // The sender is identified by WindowProxy IDENTITY (`boardKeyForSource`,
        // which must never read a property off `event.source` — see its doc
        // comment for the SecurityError that cost inspect the whole handler).
        const key = boardKeyForSource(frameSources(), event.source as Window | null)
        const board = artboards.find((b) => b.key === key)
        if (board) onSelect(m as unknown as Record<string, unknown>, board)
      } else if (m.type === "design:route") {
        // Navigational state derived from a frame's URL, so it is accepted on
        // exactly the same terms as a selection: the same identity check (never
        // a property off `event.source`), and only from a frame this canvas
        // mounted for a board it still knows — a closed board's frame can
        // outlive its board by a tick, and its path is not a claim about
        // anything on screen. The path itself is then parsed by `design-route`,
        // which refuses anything that is not a sandbox path or is absurdly long;
        // a report it refuses is IGNORED, not recorded as unknown.
        const key = boardKeyForSource(frameSources(), event.source as Window | null)
        if (!key || !artboards.some((b) => b.key === key)) return
        // No token, no frames (a board without one renders `FrameError`), so a
        // report arriving in that state belongs to a document this canvas is no
        // longer showing.
        if (!sandboxToken) return
        const route = typeof m.path === "string" ? routeFromSandboxPath(m.path) : null
        if (!route) return
        // Stamped with the document the frame is on NOW — the epoch halves and
        // the token its iframe's key is built from — so the report expires with
        // the document that sent it, and with it goes everything a remount
        // changes (a file write, a Reload, another project's token).
        const epoch = contentEpoch + (boardEpochs.get(key) ?? 0)
        reportSinks.current.get(key)?.({ route, epoch, token: sandboxToken })
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [artboards, onSelect, contentEpoch, boardEpochs, sandboxToken])

  // Broadcast picking/theme state to every mounted frame. `appearance` rides
  // along on `design:theme` (#626); a frame from before it ignores the field.
  useEffect(() => {
    for (const frame of mountedFrames()) {
      frame.contentWindow?.postMessage({ type: "design:mode", picking }, "*")
      frame.contentWindow?.postMessage({ type: "design:theme", theme, appearance }, "*")
    }
  }, [picking, theme, appearance])

  // --- nodes and (Flow view) links ------------------------------------------
  const panMode = spaceDown || canvasTool === "pan"
  const inFlow = !!flow
  const nodes: BoardNodeType[] = useMemo(
    () =>
      artboards.map((board) => {
        const device = deviceById(board.deviceId)
        return {
          id: board.key,
          type: "board",
          position: { x: board.x, y: board.y },
          width: boardWidth(device),
          height: HEADER_H + boardHeight(device),
          draggable: inFlow,
          selectable: inFlow,
          connectable: inFlow,
          dragHandle: ".board-drag",
          // React Flow turns pointer events OFF for a node that is neither
          // draggable, selectable nor connectable — every board outside the
          // Flow view. A board is a live page to scroll, click and pick in,
          // so they stay on.
          style: { pointerEvents: "all" },
          data: {
            board,
            label: labelFor(board.route),
            // This frame's generation, computed ONCE: it is both what remounts
            // the iframe (`LazyFrame`'s key) and half of what expires the route
            // the frame last reported, and two spellings of it could disagree.
            epoch: contentEpoch + (boardEpochs.get(board.key) ?? 0),
            registerReport: registerBoardReport,
            theme,
            appearance,
            themeBackground,
            picking,
            deviceIds,
            onReloadBoard,
            onOpenBoard,
            onDuplicateBoard,
            onRemoveBoard,
            onDownloadImage,
            onDeletePage,
            sandboxToken,
            projectId,
            panMode,
            inFlow,
          },
        }
      }),
    [
      artboards, labelFor, contentEpoch, boardEpochs, registerBoardReport, theme, appearance, themeBackground, picking, deviceIds,
      onReloadBoard, onOpenBoard, onDuplicateBoard, onRemoveBoard, onDownloadImage, onDeletePage,
      sandboxToken, projectId, panMode, inFlow,
    ],
  )

  /// Flow view: the node standing for each route (one device, so one node).
  const keyOfRoute = useMemo(() => new Map(artboards.map((b) => [b.route, b.key])), [artboards])
  const routeOfKey = useMemo(() => new Map(artboards.map((b) => [b.key, b.route])), [artboards])
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [linkProblemText, setLinkProblemText] = useState<string | null>(null)
  const edges: Edge[] = useMemo(() => {
    if (!flow) return []
    return (flow.doc.edges ?? [])
      .filter((e) => keyOfRoute.has(e.from) && keyOfRoute.has(e.to))
      .map((e) => {
        const on = selectedEdge === e.id
        return {
          id: e.id,
          source: keyOfRoute.get(e.from)!,
          target: keyOfRoute.get(e.to)!,
          // Drawn between the facing sides of the two screens — see
          // `flow/floating-edge.tsx` for why fixed handles tangled.
          type: "floating",
          label: e.label,
          selected: on,
          style: { strokeWidth: on ? 9 : 6, stroke: on ? "var(--primary)" : "#6366f1", strokeDasharray: "18 12" },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: on ? "var(--primary)" : "#6366f1" },
        }
      })
  }, [flow, keyOfRoute, selectedEdge])

  const connect = (c: Connection) => {
    if (!flow || !c.source || !c.target) return
    const from = routeOfKey.get(c.source)
    const to = routeOfKey.get(c.target)
    if (!from || !to) return
    const why = linkProblem(flow.doc, from, to)
    setLinkProblemText(why)
    if (!why) flow.onDocChange(linkPages(flow.doc, from, to))
  }
  const currentEdge = flow ? (flow.doc.edges ?? []).find((e) => e.id === selectedEdge) ?? null : null

  return (
    <div
      className="relative h-full w-full bg-[#0b0b0f] select-none"
      data-testid="design-canvas-surface"
    >
      <ReactFlow<BoardNodeType, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onInit={(instance) => {
          rfRef.current = instance
          void instance.setViewport({ x: transform.x, y: transform.y, zoom: transform.scale })
        }}
        onMoveStart={() => {
          movingRef.current = true
        }}
        onMoveEnd={(_, v) => {
          movingRef.current = false
          onTransformChange({ x: v.x, y: v.y, scale: v.zoom })
        }}
        minZoom={MIN_SCALE}
        maxZoom={MAX_SCALE}
        // Trackpad: two fingers pan, pinch zooms; a mouse wheel pans, and
        // Ctrl/⌘+wheel zooms toward the cursor. Over a screen, the wheel scrolls
        // THAT PAGE — the frame gets its own events.
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomActivationKeyCode={["Meta", "Control"]}
        panOnDrag={canvasTool === "pan" ? true : [0, 1]}
        selectionOnDrag={false}
        nodesDraggable={inFlow}
        nodesConnectable={inFlow}
        elementsSelectable={inFlow}
        onNodeDragStop={(_, node) => {
          const route = routeOfKey.get(node.id)
          if (flow && route) flow.onDocChange(placePage(flow.doc, route, node.position))
        }}
        onConnect={connect}
        onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
        onPaneClick={() => setSelectedEdge(null)}
        onEdgesDelete={(deleted) => {
          if (!flow) return
          let next = flow.doc
          for (const e of deleted) next = unlink(next, e.id)
          flow.onDocChange(next)
          setSelectedEdge(null)
        }}
        deleteKeyCode={inFlow ? ["Backspace", "Delete"] : null}
        connectionLineStyle={{ strokeWidth: 6, stroke: "#6366f1" }}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        style={{ cursor: panMode ? "grab" : undefined }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#27272a" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor="#3f3f46"
          nodeBorderRadius={10}
          maskColor="rgba(0, 0, 0, 0.55)"
          style={{ background: "#18181b" }}
        />
        <ViewportPortal>
          {/* Selection rect: chrome-owned, drawn over the frame at the captured
              rect. ~120ms ease-out; direct manipulation stays unanimated. */}
          {selection && selectionBoard ? (
            <div
              aria-hidden
              className="pointer-events-none absolute z-10 border-2 border-accent transition-all duration-[120ms] ease-out"
              style={{
                // The rect is in the PAGE's px; the page sits at the board's
                // content origin (under the header, inside the frame).
                left: selectionBoard.x + boardContentOrigin(deviceById(selectionBoard.deviceId)).x + selection.rect.x,
                top: selectionBoard.y + boardContentOrigin(deviceById(selectionBoard.deviceId)).y + selection.rect.y,
                width: selection.rect.w,
                height: selection.rect.h,
                boxShadow: "0 0 0 1px rgba(255,255,255,0.35)",
              }}
            />
          ) : null}
          {/* Comment pins live in world space so pan/zoom carry them for free. */}
          {pins ? pins : null}
        </ViewportPortal>
        {inFlow ? (
          <Panel position="bottom-center">
            <div className="max-w-md rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-center text-xs text-zinc-300 shadow-sm">
              Drag a screen by its title. Drag from a screen's right dot to another's left dot to link them; click a link to
              name or remove it.
              {linkProblemText ? <p className="mt-1 text-rose-300">{linkProblemText}</p> : null}
            </div>
          </Panel>
        ) : null}
        {flow && currentEdge ? (
          <Panel position="top-right">
            <EdgeEditor
              key={currentEdge.id}
              title={`${labelFor(currentEdge.from)} → ${labelFor(currentEdge.to)}`}
              label={currentEdge.label ?? ""}
              onSave={(label) => flow.onDocChange(relabel(flow.doc, currentEdge.id, label))}
              onDelete={() => {
                flow.onDocChange(unlink(flow.doc, currentEdge.id))
                setSelectedEdge(null)
              }}
              onClose={() => setSelectedEdge(null)}
            />
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  )
})

/// Ask the canvas to frame one board (the Pages panel, the palette, a
/// comment). An event, not a prop: the callers are all over the surface, and
/// the viewport belongs to React Flow.
export const FOCUS_BOARD_EVENT = "design:focus-board"

type BoardNodeData = {
  board: Artboard
  label: string
  epoch: number
  registerReport: (key: string, sink: (report: FrameReport) => void) => () => void
  theme: string
  appearance: ThemeAppearance | null
  themeBackground: string | null
  picking: boolean
  deviceIds: string[]
  onReloadBoard: (key: string) => void
  onOpenBoard: (key: string) => void
  onDuplicateBoard: (key: string, deviceId: string) => void
  onRemoveBoard: (route: string) => void
  onDownloadImage?: (route: string, label: string, deviceId: string, withFrame: boolean, fullPage: boolean) => void
  onDeletePage?: (route: string) => void
  sandboxToken: string | null
  projectId: number | null
  panMode: boolean
  inFlow: boolean
}
type BoardNodeType = Node<BoardNodeData, "board">

/// A React Flow node that IS an artboard: the same header, menu and live frame
/// every view draws — plus, in the Flow view, the dots links are dragged from.
const BoardNode = memo(function BoardNode({ data }: NodeProps<BoardNodeType>) {
  const device = deviceById(data.board.deviceId)
  const mid = HEADER_H + boardHeight(device) / 2
  return (
    <>
      <ArtboardCard {...data} />
      {data.inFlow ? (
        <>
          <Handle type="target" position={Position.Left} className="!h-5 !w-5 !border-2 !border-white !bg-indigo-500" style={{ top: mid }} />
          <Handle type="source" position={Position.Right} className="!h-5 !w-5 !border-2 !border-white !bg-indigo-500" style={{ top: mid }} />
        </>
      ) : null}
    </>
  )
})

const NODE_TYPES = { board: BoardNode }
const EDGE_TYPES = { floating: FloatingEdge }

// ---------------------------------------------------------------------------
// Artboards
// ---------------------------------------------------------------------------

function mountedFrames(): HTMLIFrameElement[] {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[data-design-frame]"))
}

/// Every mounted frame as a `{key, win}` pair for `boardKeyForSource`: the key
/// comes from the iframe's own `name` ATTRIBUTE (`name={board.key}` in
/// `LazyFrame`), read off OUR element. `getAttribute` on our own DOM is safe;
/// the Window's `name` property is not (see `boardKeyForSource`, which lives in
/// `design-frame-source.ts` — the one line that broke has to be testable).
function frameSources(): { key: string; win: Window | null }[] {
  const out: { key: string; win: Window | null }[] = []
  for (const frame of mountedFrames()) {
    const key = frame.getAttribute("name")
    if (key) out.push({ key, win: frame.contentWindow })
  }
  return out
}

/// Memoised, because this is the component the canvas MULTIPLIES: once per open
/// route per selected device, so three times over under Responsive review, each
/// board a header plus a live iframe. Nothing in its render depends on anything
/// outside its props, so when `DesignCanvas` re-renders for a reason no board
/// cares about — a pan/zoom commit writing `transform`, a selection rect, the
/// comment pins — the whole per-board subtree is skipped instead of rebuilt.
/// All of its props are stable (`board` only changes identity when the
/// arrangement is genuinely re-derived, which is a real change and must
/// re-render). Re-rendering it is cheap and safe in one specific way that
/// matters: the iframe is only ever remounted by an EPOCH, never by a render.
const ArtboardCard = memo(function ArtboardCard({
  board,
  label,
  epoch,
  registerReport,
  theme,
  appearance,
  themeBackground,
  picking,
  deviceIds,
  onReloadBoard,
  onOpenBoard,
  onDuplicateBoard,
  onRemoveBoard,
  onDownloadImage,
  onDeletePage,
  sandboxToken,
  projectId,
  panMode,
}: {
  /** Flow view: the header becomes the drag handle (ignored elsewhere). */
  inFlow?: boolean
  board: Artboard
  /** The page's resolved display name (see `labelFor`). */
  label: string
  /** This frame's GENERATION: `contentEpoch + boardEpoch`, the sum the iframe
   *  below is keyed by, handed over already computed so the key and the route
   *  report's stamp can never spell it differently. */
  epoch: number
  /** Register this board's report sink with the canvas, which routes a frame's
   *  report back here (see `DesignCanvas`'s `reportSinks` for why the report is
   *  held by the BOARD and not by the canvas). */
  registerReport: (key: string, sink: (report: FrameReport) => void) => () => void
  theme: string
  /** #626: see `DesignCanvasProps.appearance`. */
  appearance: ThemeAppearance | null
  /** #626: see `DesignCanvasProps.themeBackground`. */
  themeBackground: string | null
  picking: boolean
  deviceIds: string[]
  /** Remount this board's frame — what the header's reset control and the ⋯
   *  menu's Reload both do, because a frame's `src` IS the page it belongs to
   *  and the generation above is how a remount is asked for. */
  onReloadBoard: (key: string) => void
  onOpenBoard: (key: string) => void
  onDuplicateBoard: (key: string, deviceId: string) => void
  onRemoveBoard: (route: string) => void
  onDownloadImage?: (route: string, label: string, deviceId: string, withFrame: boolean, fullPage: boolean) => void
  onDeletePage?: (route: string) => void
  sandboxToken: string | null
  projectId: number | null
  /** Pan tool active or Space held: the iframe must not swallow the drag that
   * starts over it, so the surface below gets pointer events instead. */
  panMode: boolean
}) {
  const device = deviceById(board.deviceId)
  const src = sandboxToken ? sandboxUrl(sandboxToken, board.route) : null
  /** Where this board's frame SAYS it is, or null while it is home (or has said
   *  nothing). It lives HERE, at the lifetime of the board, so it cannot
   *  outlive the frame that reported it — see `DesignCanvas`'s `reportSinks`. */
  const [report, setReport] = useState<FrameReport | null>(null)
  const onFrameReport = useCallback((next: FrameReport) => {
    // Same value in, same value out: React drops the update, so a frame that
    // re-announces where it already was costs no render at all (see
    // `sameFrameReport`).
    setReport((current) => (sameFrameReport(current, next) ? current : next))
  }, [])
  useEffect(() => registerReport(board.key, onFrameReport), [registerReport, board.key, onFrameReport])
  // Read through the stamp: a report describes the document that sent it, so the
  // moment that frame is remounted — a file write, a Reload, another project's
  // token — this reads as nothing and the header goes back to naming the
  // board's own page.
  const strayRoute = divergedRoute(board.route, reportedRoute(report, epoch, sandboxToken))
  // #626/#632: what the frame last said about its top — the colour the device
  // frame fills its status strip with, and the strip's ink. Accepted by
  // WindowProxy IDENTITY, exactly like a route report; the payload is validated
  // by `parseStatusBarReport`. Held across a remount on purpose: the new
  // document reports on `load`.
  const [statusReport, setStatusReport] = useState<StatusBarReport | null>(null)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const next = parseStatusBarReport(event.data)
      if (!next) return
      if (boardKeyForSource(frameSources(), event.source as Window | null) !== board.key) return
      setStatusReport((current) => (sameStatusBarReport(current, next) ? current : next))
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [board.key])
  // Named apart from the classic `chrome` below, which shadows inside the IIFE.
  const statusChrome = frameChrome({ report: statusReport, appearance, themeBackground })

  return (
    // Positioned by its React Flow node, which is placed at (board.x, board.y).
    <div data-artboard-key={board.key}>
      <div className="board-drag">
      <ArtboardHeader
        boardKey={board.key}
        route={board.route}
        label={label}
        strayRoute={strayRoute}
        device={device}
        projectId={projectId}
        width={boardWidth(device)}
        deviceIds={deviceIds}
        onReloadBoard={onReloadBoard}
        onOpenBoard={onOpenBoard}
        onDuplicateBoard={onDuplicateBoard}
        onRemoveBoard={onRemoveBoard}
        onDownloadImage={onDownloadImage}
        onDeletePage={onDeletePage}
      />
      </div>
      {/* `nodrag`: the page is for using — scroll it, pick in it — never for
          dragging the node by. */}
      <div className="nodrag nowheel overflow-visible" style={panMode ? { pointerEvents: "none" } : undefined}>
        {(() => {
          const frameHeight = framedViewportHeight(device)
          const page = src ? (
            <LazyFrame
              src={src}
              width={device.width}
              height={frameHeight}
              name={board.key}
              theme={theme}
              appearance={appearance}
              picking={picking}
              epoch={epoch}
            />
          ) : (
            <FrameError width={device.width} height={frameHeight} reason="No sandbox token — reload the surface." />
          )
          // The toolbar's frame mode: a real device frame, the classic bezel,
          // or a plain outline. A breakpoint width is no device, so it is
          // always the outline.
          if (canvasFrame(device)) {
            return (
              <FramedBoard device={device} chrome={statusChrome}>
                {page}
              </FramedBoard>
            )
          }
          const chrome = classicChrome(device)
          return chrome ? (
            <ClassicBoard chrome={chrome}>{page}</ClassicBoard>
          ) : (
            <OutlineBoard device={device}>{page}</OutlineBoard>
          )
        })()}
      </div>
    </div>
  )
})

/// Exported for `design-canvas.test.ts`, which renders it with
/// `renderToStaticMarkup`: the repo has no jsdom, so the markup this draws — and
/// in particular whether the "the frame has gone elsewhere" chip is drawn at all
/// — is only assertable if the component can be reached from outside. It is
/// rendered by `ArtboardCard` and by nothing else, and it takes the stray route
/// as a STRING rather than reading the report map, so the rule that decides
/// whether a frame has wandered stays in `design-route.ts` with its tests.
///
/// Its ⋯ menu's Rotate item draws its disabled state and its reason text from
/// `rotateDecisionFor`, which lives with the other preset rules in
/// `design-devices.ts` — and is tested there, because a closed menu renders no
/// items for a markup test to reach.
export function ArtboardHeader({
  boardKey,
  route,
  label,
  strayRoute,
  device,
  projectId,
  width,
  deviceIds,
  onReloadBoard,
  onOpenBoard,
  onDuplicateBoard,
  onRemoveBoard,
  onDownloadImage,
  onDeletePage,
}: {
  /** This board's `route@device` key — what the per-board actions are keyed by
   *  (`route` alone is not unique: one route renders once per device). */
  boardKey: string
  /** The route, for the per-page actions (Copy HTML / Download) — NOT for the
   *  header's text: the name comes in as `label`. */
  route: string
  /** The page's resolved display name, computed by the caller. The header
   *  displays it and derives nothing, so it cannot disagree with the Pages
   *  panel or the row headers. */
  label: string
  /** The route this board's frame has navigated to, when that is NOT the page
   *  the board points at — else null. Null draws nothing: a frame that is home
   *  (or has not reported) must look exactly as it always did. */
  strayRoute: string | null
  device: DevicePreset
  projectId: number | null
  /** The board's rendered width. The header is clamped to it so a narrow
   *  device's label and actions can never spill into the neighbouring board —
   *  which is what the old unconstrained flex row did. */
  width: number
  /** Devices already on the canvas — the duplicate submenu omits them. */
  deviceIds: string[]
  /** Remount this board's frame, which is how it is returned to its own page:
   *  a frame's `src` IS that page. The ⋯ menu's Reload is the same action and
   *  goes through this same prop, so the header's reset control and the menu
   *  cannot drift apart — and neither has to clear the tracked route, whose
   *  stamp this remount moves. */
  onReloadBoard: (key: string) => void
  onOpenBoard: (key: string) => void
  onDuplicateBoard: (key: string, deviceId: string) => void
  onRemoveBoard: (route: string) => void
  /** Download this screen as a PNG — visible screen or full page, bare or in
   *  the board's device frame. */
  onDownloadImage?: (route: string, label: string, deviceId: string, withFrame: boolean, fullPage: boolean) => void
  /** Trash this page; only ever called from the confirm dialog below. */
  onDeletePage?: (route: string) => void
}) {
  /// The delete confirmation. Held here, beside the menu that opens it: the
  /// menu closes on the click, and the dialog must outlive it.
  const [confirmDelete, setConfirmDelete] = useState(false)
  /// The open-source frame this board's device wears, or null (breakpoints).
  const frame = frameFor(device.id)
  const copyHtml = async () => {
    if (projectId == null) return
    try {
      const fragment = await fetchPageHtmlFragment(projectId, route)
      await navigator.clipboard.writeText(fragment)
    } catch (err) {
      console.error("Could not copy page HTML", err)
    }
  }
  const downloadHtml = async () => {
    if (projectId == null) return
    try {
      await downloadPageHtml(projectId, route)
    } catch (err) {
      console.error("Could not download page HTML", err)
    }
  }

  // Only the sizes this route is not already rendered at: adding a device that
  // is already on the canvas would change nothing.
  const otherDevices = DEVICE_PRESETS.filter((d) => !deviceIds.includes(d.id))

  // Rotate shows this board at its landscape preset — the SAME device at
  // swapped dimensions, which is a real breakpoint change because the iframe
  // always renders at its true pixel width. It is a duplicate at the variant's
  // id, so it reuses that plumbing rather than a second mechanism.
  //
  // Three outcomes, and the item says which: the variant to add, "no landscape
  // form" for laptops and breakpoints and boards that are ALREADY landscape
  // (`landscapeVariant` is total, so it never hands back an id no preset
  // declares), and "already on canvas" when the variant is up — the case the
  // sibling submenu below already filters with `otherDevices`.
  const rotate = rotateDecisionFor(device, deviceIds)

  return (
    <div
      className="mb-2 flex items-center gap-1.5 overflow-hidden text-xs text-zinc-400"
      style={{ width }}
    >
      <span className="truncate font-medium text-zinc-200">{label}</span>
      <span className="shrink-0 text-zinc-500">·</span>
      <span className="shrink-0">{device.label}</span>
      {strayRoute ? (
        // The frame is not on the page this board was created for — its own
        // links can navigate it to another one — so the header says WHERE it is
        // instead of leaving the page name above to be read as a claim about
        // what is on screen. The name stays: it is what this board IS, and what
        // the control beside it returns the frame to.
        <>
          <span
            className="max-w-24 shrink-0 truncate font-mono text-amber-300"
            title={`This frame navigated to ${strayRoute}`}
          >
            → {strayRoute}
          </span>
          <button
            type="button"
            className="nopan nodrag shrink-0 rounded p-1 text-amber-300 hover:bg-zinc-800"
            title={`Show ${route} again`}
            aria-label={`Show ${route} again`}
            onClick={() => onReloadBoard(boardKey)}
          >
            <Undo2Icon className="size-3.5" />
          </button>
        </>
      ) : null}
      <button
        className="nopan nodrag ml-auto shrink-0 rounded p-1 hover:bg-zinc-800 disabled:opacity-40"
        title="Copy HTML"
        disabled={projectId == null}
        onClick={copyHtml}
      >
        <ClipboardCopyIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className="nopan nodrag shrink-0 rounded p-1 hover:bg-zinc-800"
        title="Reload"
        aria-label={`Reload ${label}`}
        onClick={() => onReloadBoard(boardKey)}
      >
        <RefreshCwIcon className="size-3.5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={projectId == null}
          render={
            // `nopan nodrag`: React Flow must not take this press as a pan.
            <button
              type="button"
              className="nopan nodrag shrink-0 rounded p-1 hover:bg-zinc-800 disabled:opacity-40"
              title="Download"
              aria-label={`Download ${label}`}
            />
          }
        >
          <DownloadIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {onDownloadImage ? (
            // GroupLabel needs Menu.Group context, or Base UI throws on open.
            <DropdownMenuGroup>
              <DropdownMenuLabel>Download</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onDownloadImage(route, label, device.id, false, false)}>
                <ImageDownIcon className="size-3.5" />
                <span className="flex-1">Image</span>
                <span className="text-[10px] text-muted-foreground">screen</span>
              </DropdownMenuItem>
              {/* A breakpoint is a width, not a device: there is no honest
                  frame to draw, and the row says so rather than hiding. */}
              <DropdownMenuItem
                disabled={!frame}
                onClick={() => frame && onDownloadImage(route, label, device.id, true, false)}
              >
                <SmartphoneIcon className="size-3.5" />
                <span className="flex-1">Image with frame</span>
                {!frame ? <span className="text-[10px] text-muted-foreground">no frame</span> : null}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDownloadImage(route, label, device.id, false, true)}>
                <ScrollTextIcon className="size-3.5" />
                <span className="flex-1">Full page</span>
                <span className="text-[10px] text-muted-foreground">whole scroll</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!frame}
                onClick={() => frame && onDownloadImage(route, label, device.id, true, true)}
              >
                <SmartphoneIcon className="size-3.5" />
                <span className="flex-1">Full page with frame</span>
                {!frame ? <span className="text-[10px] text-muted-foreground">no frame</span> : null}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          ) : null}
          {onDownloadImage ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={downloadHtml}>
            <FileCodeIcon className="size-3.5" />
            HTML file
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            // `nopan nodrag`: React Flow must not take this press as the start
            // of a pan or a node drag, or the menu never opens.
            <button className="nopan nodrag shrink-0 rounded p-1 hover:bg-zinc-800" title="More actions" />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {/* Whether Rotate is available, and why not, must be legible without
              a hover: a disabled item is `data-disabled:pointer-events-none`
              (dropdown-menu.tsx), so its `title` is unreadable — the reason has
              to be the row's own text, as "Every device is already shown"
              below does it. */}
          <DropdownMenuItem
            disabled={rotate.kind === "blocked"}
            title={
              rotate.kind === "add"
                ? `Add ${rotate.device.label} — ${rotate.device.width}×${rotate.device.height}`
                : undefined
            }
            onClick={() => rotate.kind === "add" && onDuplicateBoard(boardKey, rotate.device.id)}
          >
            <RotateCwIcon className="size-3.5" />
            <span className="flex-1">Rotate</span>
            {rotate.kind === "blocked" ? (
              <span className="text-[10px] text-muted-foreground">
                {rotate.reason}
              </span>
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <CopyIcon className="size-3.5" />
              Duplicate at another device
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
              {otherDevices.length ? (
                otherDevices.map((d) => (
                  <DropdownMenuItem
                    key={d.id}
                    onClick={() => onDuplicateBoard(boardKey, d.id)}
                  >
                    <span className="flex-1">{d.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {d.width}×{d.height}
                    </span>
                  </DropdownMenuItem>
                ))
              ) : (
                // Reachable: the DevicePicker lets every preset be selected.
                <DropdownMenuItem disabled>Every device is already shown</DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => onOpenBoard(boardKey)}>
            <ExternalLinkIcon className="size-3.5" />
            Open in new tab
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onRemoveBoard(route)}>
            <XIcon className="size-3.5" />
            Remove
          </DropdownMenuItem>
          {onDeletePage ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon className="size-3.5" />
                Delete page…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {onDeletePage ? (
        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Delete “{label}”?</DialogTitle>
              <DialogDescription>
                The page {route} leaves the canvas, the Pages panel and every export, at every device. It goes
                to the Trash at the bottom of the Pages panel, where you can restore it.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                autoFocus
                onClick={() => {
                  setConfirmDelete(false)
                  onDeletePage(route)
                }}
              >
                Delete page
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}

/// A board in its REAL device frame (devices.css, MIT). The frame is scaled so
/// its screen is exactly `device.width` wide, and the page inside is scaled
/// back so it renders 1:1 — its breakpoints honest, its text the usual size,
/// and a position it reports needing only `boardContentOrigin`'s offset.
///
/// #632: the EXPORT's geometry (`export-run.inDeviceFrame`): the page's
/// viewport starts below the screen's status-bar strip and runs to the bottom
/// of the screen, so the canvas, a download and `design_screenshot` frame a
/// page identically. The strip is filled with the page's top colour and its
/// ink is resolved by `chrome` (`status-bar.ts`, tested) — the same answer the
/// export and the renderer paint. Nothing is drawn over the page.
export function FramedBoard({
  device,
  chrome,
  children,
}: {
  device: DevicePreset
  chrome: FrameChrome
  children: React.ReactNode
}) {
  const framed = canvasFrame(device)
  if (!framed) return <>{children}</>
  const { frame, metrics: m, scale: k } = framed
  return (
    <div className="relative" style={{ width: Math.round(m.w * k), height: Math.round(m.h * k) }}>
      <div
        className={`tf-frame device device-${frame}`}
        style={{ position: "absolute", top: 0, left: 0, transform: `scale(${k})`, transformOrigin: "top left" }}
      >
        <div className="device-frame">
          <div
            className="device-screen"
            style={{ position: "relative", overflow: "hidden", background: chrome.screenBackground, colorScheme: chrome.colorScheme }}
          >
            {/* The strip a notch or Dynamic Island sits in, drawn as the status
                bar a real phone shows there, in the page's top colour — so it
                reads as part of the page rather than a gap above it. */}
            {m.statusBar ? (
              <StatusBar frame={frame} width={m.screenW} height={m.statusBar} fill={chrome.stripFill} ink={inkColour(chrome.ink)} />
            ) : null}
            <div
              style={{
                position: "absolute",
                top: m.statusBar,
                left: 0,
                width: device.width,
                height: framedViewportHeight(device),
                transform: `scale(${1 / k})`,
                transformOrigin: "top left",
              }}
            >
              {children}
            </div>
          </div>
        </div>
        <div className="device-stripe" />
        <div className="device-header" />
        <div className="device-sensors" />
        <div className="device-btns" />
        <div className="device-power" />
        <div className="device-home" />
      </div>
    </div>
  )
}

/// The device's own status bar (see `statusBarHtml`: each phone lays it out as
/// its platform does), on the strip's fill. Static, trusted markup built in
/// `lib/design-frames` — the export and the renderer draw the very same string;
/// the ink is one of two constants and the fill a validated colour.
function StatusBar({ frame, width, height, fill, ink }: { frame: string; width: number; height: number; fill: string; ink: string }) {
  const style = statusBarStyle(frame)
  return (
    <div
      aria-hidden
      data-status-strip=""
      className="pointer-events-none absolute top-0 left-0"
      style={{ width, height, background: fill }}
      dangerouslySetInnerHTML={style ? { __html: statusBarHtml(style, width, height, ink) } : undefined}
    />
  )
}

/// The canvas's original chrome — the `classic` frame mode (see `ChromeStyle`):
/// a black bezel round the page, with a notch pill and home indicator on a
/// phone, a camera dot on a tablet, and a window bar on a laptop. The page
/// renders 1:1 inside it, so `boardContentOrigin` is its padding plus border.
export function ClassicBoard({ chrome, children }: { chrome: ChromeStyle; children: React.ReactNode }) {
  const { padding } = chrome
  return (
    <div
      className="relative border border-zinc-700/80 bg-black shadow-[0_18px_50px_-12px_rgba(0,0,0,0.9)]"
      style={{
        borderRadius: chrome.outerRadius,
        paddingTop: padding.top,
        paddingRight: padding.right,
        paddingBottom: padding.bottom,
        paddingLeft: padding.left,
      }}
    >
      {chrome.notch ? (
        <div className="absolute top-2 left-1/2 h-4 w-24 -translate-x-1/2 rounded-full bg-zinc-900 ring-1 ring-zinc-800" />
      ) : null}
      {chrome.homeIndicator ? (
        <div className="absolute bottom-1.5 left-1/2 h-1 w-28 -translate-x-1/2 rounded-full bg-zinc-700" />
      ) : null}
      {chrome.cameraDot ? (
        <div className="absolute top-1.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-zinc-800 ring-1 ring-zinc-600/60" />
      ) : null}
      {chrome.topBar ? (
        <div
          className="absolute top-0 right-0 left-0 flex h-[22px] items-center gap-1.5 bg-zinc-900 px-3"
          style={{ borderTopLeftRadius: chrome.outerRadius, borderTopRightRadius: chrome.outerRadius }}
        >
          <span className="size-2 rounded-full bg-zinc-700" />
          <span className="size-2 rounded-full bg-zinc-700" />
          <span className="size-2 rounded-full bg-zinc-700" />
        </div>
      ) : null}
      <div className="overflow-hidden bg-zinc-950" style={{ borderRadius: chrome.innerRadius }}>
        {children}
      </div>
    </div>
  )
}

/// A frameless board: the page in a 1px, softly rounded outline — what every
/// board is with frames off, and what a breakpoint width always is.
export function OutlineBoard({ device, children }: { device: DevicePreset; children: React.ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-[18px] border border-zinc-700/80 bg-white shadow-[0_18px_50px_-12px_rgba(0,0,0,0.85)]"
      style={{ width: device.width + 2, height: device.height + 2 }}
    >
      {children}
    </div>
  )
}

/// Mount an iframe once it comes near the viewport (§9.2): within ~1.5 viewports
/// (IntersectionObserver margin) → mount, and it stays mounted. A static
/// placeholder keeps the canvas free of holes while unmounted. Frames are never
/// released, so a long session on a large canvas costs one live document per
/// board seen: that is the accepted price of keeping pages comparable side by
/// side, not an oversight.
///
/// Memoised for the same reason as `ArtboardCard` above, one level down: a
/// board that re-renders for its own reasons (the header's menus, `panMode`)
/// must not drag a live iframe's element tree with it. Every prop is a
/// primitive or a string here, so a shallow compare is exact — and the one prop
/// that MUST re-render it, `epoch`, is the whole inventory of "this frame's
/// document has changed".
export const LazyFrame = memo(function LazyFrame({
  src,
  width,
  height,
  name,
  theme,
  appearance,
  picking,
  epoch,
}: {
  src: string
  width: number
  height: number
  name: string
  theme: string
  /** #626: sent with `design:theme`; also this iframe's own `color-scheme`. */
  appearance: ThemeAppearance | null
  picking: boolean
  epoch: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  /** A load failure, STAMPED with the epoch of the frame that produced it. */
  const [failed, setFailed] = useState<{ epoch: number; reason: string } | null>(null)

  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        // Latch: mount on first sight, never unmount. A page that vanishes when
        // scrolled past cannot be compared against its neighbour, and reloading
        // it on return throws away exactly the live state the comparison needs.
        // Initial mounting stays lazy — a frame nobody has scrolled to still
        // costs nothing, which is what keeps a large canvas from mounting a
        // dozen documents at once.
        for (const entry of entries) if (entry.isIntersecting) setNear(true)
      },
      { root: null, rootMargin: "150%", threshold: 0 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Push mode/theme into the frame when it announces readiness, and
  // whenever the state changes for frames already up. Only THIS frame's
  // `design:ready` triggers a re-push; every board hears every ready.
  const pushRef = useRef<() => void>(() => {})
  useEffect(() => {
    pushRef.current = () => {
      const win = hostRef.current?.querySelector("iframe")?.contentWindow
      win?.postMessage({ type: "design:mode", picking }, "*")
      win?.postMessage({ type: "design:theme", theme, appearance }, "*")
    }
    pushRef.current()
  }, [picking, theme, appearance, epoch])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type?: string } | undefined
      if (m?.type !== "design:ready") return
      if (e.source !== hostRef.current?.querySelector("iframe")?.contentWindow) return
      pushRef.current()
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  const frameSrc = `${src}${src.includes("?") ? "&" : "?"}board=${encodeURIComponent(name)}`

  // A failure counts only while it belongs to the frame CURRENTLY on screen. A
  // new epoch (this board's Reload counter or the global content epoch) retires
  // it in the same render that changes the epoch, so a Reload of a frame that
  // failed before it ever rendered mounts straight away instead of being a
  // silent no-op — there is no iframe for the new key to remount, which is
  // exactly the state a user reaches for Reload in. Deriving it from the stamp
  // rather than clearing it in an effect keeps one source of truth for "which
  // epoch failed" and avoids an error-state flash on every reload (an effect
  // runs after render, so `failed` would paint once more first). Nothing in the
  // failure path moves the epoch, so a retry that fails again simply re-arms
  // this and cannot loop. `near` is untouched, so the latch above still holds —
  // and that is why this is a stamp and NOT a `key` on LazyFrame: remounting
  // the component would reset `near` to false and undo the latch.
  const failure = failed && failed.epoch === epoch ? failed.reason : null

  if (failure) {
    return <FrameError width={width} height={height} reason={failure} />
  }

  return (
    <div ref={hostRef} style={{ width, height }} className="relative bg-zinc-900">
      {near ? (
        <iframe
          key={`${frameSrc}|${epoch}`}
          data-design-frame
          data-board-key={name}
          name={name}
          title={`Design preview ${name}`}
          src={frameSrc}
          className="h-full w-full border-0"
          /* #626: when the iframe element's color-scheme matches the
             document's, Chrome keeps the frame's backdrop transparent. */
          style={{ colorScheme: appearance ?? "normal" }}
          /* allow-same-origin is required so the composed page's CSP `'self'`
             resolves: without a real origin, tokens.css and component scripts
             are CSP-blocked. Safe because the sandbox is served from a DIFFERENT
             origin (SANDBOX_ORIGIN) than the app, so the frame still cannot
             reach the parent. */
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
          /* Stamp the CURRENT epoch — this closure renders with the frame it
             belongs to, so the comparison above reads as fresh. An unstamped
             failure would go stale immediately and never show. */
          onError={() => setFailed({ epoch, reason: "The sandbox refused this frame." })}
        />
      ) : (
        <PlaceholderSkeleton width={width} height={height} label={name} />
      )}
    </div>
  )
})

/// §9.8 failure states: never a blank white rectangle.
function FrameError({ width, height, reason }: { width: number; height: number; reason: string }) {
  return (
    <div
      style={{ width, height }}
      className="flex flex-col items-center justify-center gap-2 bg-zinc-900 p-6 text-center"
    >
      <p className="text-sm text-zinc-300">This artboard could not load.</p>
      <p className="font-mono text-[11px] text-zinc-500">{reason}</p>
      <button
        type="button"
        className="mt-1 rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
        onClick={() => window.location.reload()}
      >
        Retry
      </button>
    </div>
  )
}

function PlaceholderSkeleton({ width, height }: { width: number; height: number; label: string }) {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-gradient-to-b from-zinc-900 to-zinc-800"
      style={{ width, height }}
    >
      <MaximizeIcon className="size-5 text-zinc-700" />
    </div>
  )
}
