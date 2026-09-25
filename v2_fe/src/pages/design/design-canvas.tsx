/// The design canvas (§9.2): an infinite pannable plotting surface with
/// iframes in device frames as artboards.
///
/// Rules that matter:
/// * Zoom is CSS `transform: scale()` on the frame WRAPPER — never on the
///   iframe, whose width is the device's true CSS px. Changing the iframe
///   width would change the page's breakpoint; scale changes nothing but
///   appearance.
/// * Artboards mount lazily by intersection so twelve live frames don't melt a
///   laptop, and unmount beyond 3 viewports.
/// * Selection rects arriving from the sandbox are divided by scale when
///   converted to canvas coordinates.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  MaximizeIcon,
  RotateCwIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  XIcon,
  EllipsisIcon,
  ClipboardCopyIcon,
  DownloadIcon,
} from "lucide-react"

import {
  DEVICE_PRESETS,
  type Artboard,
  type DevicePreset,
  boardWidth,
  chromeStyleForGroup,
  deviceById,
  landscapeVariant,
} from "@/lib/design-devices"
import { sandboxUrl, downloadPageHtml, fetchPageHtmlFragment } from "@/lib/design-api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { type CanvasTool } from "./canvas-tools"
import { boardKeyForSource } from "./design-frame-source"
import { createSettleGate } from "./settle-gate"
import { gridDotOpacity, transformCss } from "./canvas-paint"

export type CanvasTransform = { x: number; y: number; scale: number }

export const MIN_SCALE = 0.25
export const MAX_SCALE = 2

export const ZOOM_STEP = 1.1

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
  /** Remount this one board's frame (the canvas's explicit reload). */
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
  selection,
  pins,
}: DesignCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  /** The panning layer the transform is applied to, and the dot grid whose fade
   *  follows the zoom. During a gesture both are written DIRECTLY (see the live
   *  transform below) instead of being re-rendered. */
  const layerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const panningRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  /** The LIVE transform: what the canvas is showing right now. Mid-gesture it
   *  deliberately runs ahead of the `transform` prop, which carries only the
   *  COMMITTED value — the gap between the two is what keeps a two-finger pan
   *  from re-rendering this component (and every board under it) 60–120 times a
   *  second. */
  const liveRef = useRef<CanvasTransform>(transform)
  /** The settle gate (see `settle-gate.ts`). Created once, and its commit is
   *  re-SET on every render rather than captured at creation, because the timer
   *  that fires it outlives the render that armed it. Setting it here, in a
   *  layout effect, is also the only shape the hooks lint allows: it refuses to
   *  let a ref-reading closure escape into a function called during render. */
  const [gate] = useState(() => createSettleGate<CanvasTransform>({ settleMs: GESTURE_SETTLE_MS }))
  useLayoutEffect(() => {
    gate.setCommit(onTransformChange)
  })
  // A pending settle must not outlive the canvas — the timer would otherwise
  // call `onTransformChange` for a surface that has moved on.
  useEffect(() => () => gate.cancel(), [gate])
  const [spaceDown, setSpaceDown] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const selectionBoard = selection
    ? artboards.find((b) => b.key === selection.boardKey)
    : undefined

  // --- pan + zoom ----------------------------------------------------------
  const clampScale = useCallback((s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)), [])

  // A gesture PAINTS the transform and only COMMITS it once the events stop.
  // Committing costs a re-render of this component and every board under it
  // (each with a live iframe) plus a Dexie write armed by the surface's persist
  // effect, which is why it cannot happen per event. The maths is untouched:
  // the handlers below read `liveRef.current` where they used to read the
  // `transform` prop, and nothing else about them moved.

  /** Exactly what the JSX below would have written for this value — same two
   *  helpers, so the two cannot drift — minus the render of the whole subtree. */
  const paint = useCallback((t: CanvasTransform) => {
    const layer = layerRef.current
    if (layer) layer.style.transform = transformCss(t)
    const grid = gridRef.current
    if (grid) grid.style.opacity = String(gridDotOpacity(t.scale))
  }, [])

  /** One gesture event: show it now, commit it if the gestures stop. */
  const push = useCallback(
    (next: CanvasTransform) => {
      liveRef.current = next
      paint(next)
      gate.push(next)
    },
    [gate, paint],
  )

  // On EVERY render, and as a LAYOUT effect so the correction lands before the
  // browser paints. React writes this render's `transform` prop onto the layer
  // itself; while a gesture is in flight that prop is the value from BEFORE the
  // gesture, so without this any unrelated re-render (a Space press, a comment
  // arriving over SSE) would snap the canvas back to where the gesture started
  // and hold it there until the settle — the glitch this task exists to remove.
  useLayoutEffect(() => {
    // When no gesture is in flight the two agree, and the prop is the truth
    // (its own commit, Fit, a zoom button, a viewport restored from Dexie):
    // adopt it, so the next gesture pans from where the canvas actually is.
    if (!gate.pending() && transform !== liveRef.current) {
      liveRef.current = transform
    }
    // While one IS in flight, the live value is the truth and this render's
    // prop is stale — including when it is a foreign write. Such a write is
    // deliberately left to the settle (which lands within 120ms and commits the
    // gesture) rather than honoured now: honouring it would yank the canvas to
    // somewhere else under a moving finger, and a lost tap on Fit is the
    // cheaper of the two. The paint below is that decision.
    paint(liveRef.current)
  })

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

  const onPointerDown = (e: React.PointerEvent) => {
    // Space+drag or middle-button pans in any mode; a plain primary-button
    // drag also pans while the Pan tool is active. Everything else (Select
    // mode, plain drag) falls through so clicks/picks reach the artboards.
    if (!(spaceDown || e.button === 1 || (canvasTool === "pan" && e.button === 0))) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    // The anchor is the LIVE position, not the committed one: a drag begun
    // inside a wheel gesture's settle window must start from where the canvas
    // actually is, not from where it was two gestures ago.
    const live = liveRef.current
    panningRef.current = { x: e.clientX, y: e.clientY, ox: live.x, oy: live.y }
    setIsPanning(true)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = panningRef.current
    if (!p) return
    const live = liveRef.current
    push({ ...live, x: p.ox + (e.clientX - p.x), y: p.oy + (e.clientY - p.y) })
  }
  const onPointerUp = () => {
    panningRef.current = null
    setIsPanning(false)
    // A drag has an END, unlike a wheel stream: commit on it rather than
    // making the human wait out the settle window. A drag that never moved
    // pushes nothing, so this is a no-op for a click.
    gate.flush()
  }

  // Cmd/Ctrl+scroll zooms toward the cursor; plain two-finger scroll pans
  // (trackpad). Zoom range 25%–200%. Both compute from the LIVE transform and
  // hand the result to `push`, which paints it now and commits it when the
  // events stop — the arithmetic below is exactly what it always was.
  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const live = liveRef.current
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const next = clampScale(live.scale * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
        // Keep the point under the cursor fixed while scaling.
        const ratio = next / live.scale
        push({
          scale: next,
          x: cx - (cx - live.x) * ratio,
          y: cy - (cy - live.y) * ratio,
        })
      } else if (!e.shiftKey && Math.abs(e.deltaX) + Math.abs(e.deltaY) > 0) {
        // Two-finger pan (trackpad). Shift+scroll leaves vertical scrolling to
        // the browser for mouse users.
        e.preventDefault()
        push({ ...live, x: live.x - e.deltaX, y: live.y - e.deltaY })
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [clampScale, push])

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
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [artboards, onSelect])

  // Broadcast picking/theme state to every mounted frame.
  useEffect(() => {
    for (const frame of mountedFrames()) {
      frame.contentWindow?.postMessage({ type: "design:mode", picking }, "*")
      frame.contentWindow?.postMessage({ type: "design:theme", theme }, "*")
    }
  }, [picking, theme])

  return (
    <div
      ref={surfaceRef}
      className="relative h-full w-full overflow-hidden bg-[#0b0b0f] select-none"
      style={{
        cursor:
          spaceDown || canvasTool === "pan"
            ? isPanning
              ? "grabbing"
              : "grab"
            : "default",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      data-testid="design-canvas-surface"
    >
      {/* Dot grid fades out below 50% zoom — a plotting surface, not a page.
          `gridDotOpacity` is shared with the gesture-time paint above. */}
      <div
        ref={gridRef}
        aria-hidden
        className="absolute inset-0 transition-opacity duration-200"
        style={{
          backgroundImage: "radial-gradient(circle, #27272a 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          opacity: gridDotOpacity(transform.scale),
        }}
      />
      <div
        ref={layerRef}
        className="absolute top-0 left-0 origin-top-left"
        style={{
          transform: transformCss(transform),
          willChange: "transform",
        }}
      >
        {artboards.map((board) => (
          <ArtboardCard
            key={board.key}
            board={board}
            label={labelFor(board.route)}
            theme={theme}
            picking={picking}
            contentEpoch={contentEpoch}
            boardEpoch={boardEpochs.get(board.key) ?? 0}
            deviceIds={deviceIds}
            onReloadBoard={onReloadBoard}
            onOpenBoard={onOpenBoard}
            onDuplicateBoard={onDuplicateBoard}
            onRemoveBoard={onRemoveBoard}
            sandboxToken={sandboxToken}
            projectId={projectId}
            panMode={spaceDown || canvasTool === "pan"}
          />
        ))}
        {/* Selection rect: chrome-owned, drawn over the frame at the captured
            rect. ~120ms ease-out; direct manipulation stays unanimated. */}
        {selection && selectionBoard ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 border-2 border-accent transition-all duration-[120ms] ease-out"
            style={{
              left: selectionBoard.x + selection.rect.x,
              top: selectionBoard.y + selection.rect.y,
              width: selection.rect.w,
              height: selection.rect.h,
              boxShadow: "0 0 0 1px rgba(255,255,255,0.35)",
            }}
          />
        ) : null}
        {/* Comment pins live in world space so pan/zoom carry them for free. */}
        {pins ? pins : null}
      </div>
    </div>
  )
})

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
  theme,
  picking,
  contentEpoch,
  boardEpoch,
  deviceIds,
  onReloadBoard,
  onOpenBoard,
  onDuplicateBoard,
  onRemoveBoard,
  sandboxToken,
  projectId,
  panMode,
}: {
  board: Artboard
  /** The page's resolved display name (see `labelFor`). */
  label: string
  theme: string
  picking: boolean
  contentEpoch: number
  /** This board's own reload counter (see `DesignCanvasProps.boardEpochs`). */
  boardEpoch: number
  deviceIds: string[]
  onReloadBoard: (key: string) => void
  onOpenBoard: (key: string) => void
  onDuplicateBoard: (key: string, deviceId: string) => void
  onRemoveBoard: (route: string) => void
  sandboxToken: string | null
  projectId: number | null
  /** Pan tool active or Space held: the iframe must not swallow the drag that
   * starts over it, so the surface below gets pointer events instead. */
  panMode: boolean
}) {
  const device = deviceById(board.deviceId)
  const src = sandboxToken ? sandboxUrl(sandboxToken, board.route) : null

  return (
    <div
      className="absolute"
      style={{ left: board.x, top: board.y }}
      data-artboard-key={board.key}
    >
      <ArtboardHeader
        boardKey={board.key}
        route={board.route}
        label={label}
        device={device}
        projectId={projectId}
        width={boardWidth(device)}
        deviceIds={deviceIds}
        onReloadBoard={onReloadBoard}
        onOpenBoard={onOpenBoard}
        onDuplicateBoard={onDuplicateBoard}
        onRemoveBoard={onRemoveBoard}
      />
      <div className="overflow-visible" style={panMode ? { pointerEvents: "none" } : undefined}>
        <DeviceChrome device={device}>
          {src ? (
            <LazyFrame
              src={src}
              width={device.width}
              height={device.height}
              name={board.key}
              theme={theme}
              picking={picking}
              epoch={contentEpoch + boardEpoch}
            />
          ) : (
            <FrameError width={device.width} height={device.height} reason="No sandbox token — reload the surface." />
          )}
        </DeviceChrome>
      </div>
    </div>
  )
})

function ArtboardHeader({
  boardKey,
  route,
  label,
  device,
  projectId,
  width,
  deviceIds,
  onReloadBoard,
  onOpenBoard,
  onDuplicateBoard,
  onRemoveBoard,
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
  device: DevicePreset
  projectId: number | null
  /** The board's rendered width. The header is clamped to it so a narrow
   *  device's label and actions can never spill into the neighbouring board —
   *  which is what the old unconstrained flex row did. */
  width: number
  /** Devices already on the canvas — the duplicate submenu omits them. */
  deviceIds: string[]
  onReloadBoard: (key: string) => void
  onOpenBoard: (key: string) => void
  onDuplicateBoard: (key: string, deviceId: string) => void
  onRemoveBoard: (route: string) => void
}) {
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
  // Null is "this device has no landscape form": laptops and breakpoints, and
  // equally a board that is ALREADY landscape (`landscapeVariant` is total, so
  // it never hands back an id no preset declares). Null disables the item.
  const rotateTo = landscapeVariant(device)

  return (
    <div
      className="mb-2 flex items-center gap-1.5 overflow-hidden text-xs text-zinc-400"
      style={{ width }}
    >
      <span className="truncate font-medium text-zinc-200">{label}</span>
      <span className="shrink-0 text-zinc-500">·</span>
      <span className="shrink-0">{device.label}</span>
      <button
        className="ml-auto shrink-0 rounded p-1 hover:bg-zinc-800 disabled:opacity-40"
        title="Copy HTML"
        disabled={projectId == null}
        onClick={copyHtml}
      >
        <ClipboardCopyIcon className="size-3.5" />
      </button>
      <button
        className="shrink-0 rounded p-1 hover:bg-zinc-800 disabled:opacity-40"
        title="Download"
        disabled={projectId == null}
        onClick={downloadHtml}
      >
        <DownloadIcon className="size-3.5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button className="shrink-0 rounded p-1 hover:bg-zinc-800" title="More actions" />
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
            disabled={!rotateTo}
            title={
              rotateTo
                ? `Add ${rotateTo.label} — ${rotateTo.width}×${rotateTo.height}`
                : undefined
            }
            onClick={() => rotateTo && onDuplicateBoard(boardKey, rotateTo.id)}
          >
            <RotateCwIcon className="size-3.5" />
            <span className="flex-1">Rotate</span>
            {rotateTo ? null : (
              <span className="text-[10px] text-muted-foreground">
                no landscape form
              </span>
            )}
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
          <DropdownMenuItem onClick={() => onReloadBoard(boardKey)}>
            <RefreshCwIcon className="size-3.5" />
            Reload
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onRemoveBoard(route)}>
            <XIcon className="size-3.5" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/// Physical device chrome, per group (`chromeStyleForGroup`, pure + tested):
/// phones get a notch/home-indicator inset, tablets a thinner bezel + camera
/// dot, laptops a light browser-chrome top bar, breakpoints stay a plain
/// rectangle. All of it is decorative padding/border around the true-size
/// iframe — nothing here resizes the iframe or touches canvas zoom. Phones
/// additionally expose --safe-top/--safe-bottom into the document.
function DeviceChrome({
  device,
  children,
}: {
  device: DevicePreset
  children: React.ReactNode
}) {
  const chrome = chromeStyleForGroup(device.group)
  const { padding, safeArea } = chrome
  return (
    <div
      className="relative border border-zinc-700/80 bg-black shadow-[0_18px_50px_-12px_rgba(0,0,0,0.9)]"
      style={
        {
          borderRadius: chrome.outerRadius,
          paddingTop: padding.top,
          paddingRight: padding.right,
          paddingBottom: padding.bottom,
          paddingLeft: padding.left,
          ...(safeArea
            ? { "--safe-top": `${safeArea.top}px`, "--safe-bottom": `${safeArea.bottom}px` }
            : {}),
        } as React.CSSProperties
      }
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
          className="absolute top-0 left-0 right-0 flex h-[22px] items-center gap-1.5 bg-zinc-900 px-3"
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

/// Mount an iframe once it comes near the viewport (§9.2): within ~1.5 viewports
/// (IntersectionObserver margin) → mount, and it stays mounted. A static
/// placeholder keeps the canvas free of holes while unmounted. Frames are never
/// released, so a long session on a large canvas costs one live document per
/// board seen: that is the accepted price of keeping pages comparable side by
/// side, not an oversight.
/// Memoised for the same reason as `ArtboardCard` above, one level down: a
/// board that re-renders for its own reasons (the header's menus, `panMode`)
/// must not drag a live iframe's element tree with it. Every prop is a
/// primitive or a string here, so a shallow compare is exact — and the one prop
/// that MUST re-render it, `epoch`, is the whole inventory of "this frame's
/// document has changed".
const LazyFrame = memo(function LazyFrame({
  src,
  width,
  height,
  name,
  theme,
  picking,
  epoch,
}: {
  src: string
  width: number
  height: number
  name: string
  theme: string
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

  // Push mode/theme into the frame when it announces readiness, and whenever
  // the state changes for frames already up.
  const pushRef = useRef<() => void>(() => {})
  useEffect(() => {
    pushRef.current = () => {
      const win = hostRef.current?.querySelector("iframe")?.contentWindow
      win?.postMessage({ type: "design:mode", picking }, "*")
      win?.postMessage({ type: "design:theme", theme }, "*")
    }
    pushRef.current()
  }, [picking, theme, epoch])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type?: string } | undefined
      if (m?.type === "design:ready") pushRef.current()
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
