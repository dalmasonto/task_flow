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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
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
  type Artboard,
  type DevicePreset,
  boardWidth,
  chromeStyleForGroup,
  deviceById,
} from "@/lib/design-devices"
import { sandboxUrl, downloadPageHtml, fetchPageHtmlFragment } from "@/lib/design-api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { type CanvasTool } from "./canvas-tools"

export type CanvasTransform = { x: number; y: number; scale: number }

export const MIN_SCALE = 0.25
export const MAX_SCALE = 2

export const ZOOM_STEP = 1.1

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
  /** Current chrome-side selection (world-space overlay). */
  selection?: {
    rect: { x: number; y: number; w: number; h: number }
    boardKey: string
  } | null
  /** Rendered comment pins, positioned in world space. */
  pins?: React.ReactNode
}

export function DesignCanvas({
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
  selection,
  pins,
}: DesignCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const panningRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const selectionBoard = selection
    ? artboards.find((b) => b.key === selection.boardKey)
    : undefined

  // --- pan + zoom ----------------------------------------------------------
  const clampScale = useCallback((s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)), [])

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
    panningRef.current = { x: e.clientX, y: e.clientY, ox: transform.x, oy: transform.y }
    setIsPanning(true)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = panningRef.current
    if (!p) return
    onTransformChange({
      ...transform,
      x: p.ox + (e.clientX - p.x),
      y: p.oy + (e.clientY - p.y),
    })
  }
  const onPointerUp = () => {
    panningRef.current = null
    setIsPanning(false)
  }

  // Cmd/Ctrl+scroll zooms toward the cursor; plain two-finger scroll pans
  // (trackpad). Zoom range 25%–200%.
  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const next = clampScale(transform.scale * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
        // Keep the point under the cursor fixed while scaling.
        const ratio = next / transform.scale
        onTransformChange({
          scale: next,
          x: cx - (cx - transform.x) * ratio,
          y: cy - (cy - transform.y) * ratio,
        })
      } else if (!e.shiftKey && Math.abs(e.deltaX) + Math.abs(e.deltaY) > 0) {
        // Two-finger pan (trackpad). Shift+scroll leaves vertical scrolling to
        // the browser for mouse users.
        e.preventDefault()
        onTransformChange({ ...transform, x: transform.x - e.deltaX, y: transform.y - e.deltaY })
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [transform, clampScale, onTransformChange])

  // --- messages from frames -------------------------------------------------
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data as FrameMessage | undefined
      if (!m || typeof m !== "object" || typeof m.type !== "string") return
      if (m.type === "design:select" && onSelect) {
        // Hostile-input rule: validate shape, clamp lengths before use.
        const board = artboards.find(
          (b) => b.key === (event.source as Window | null)?.name
        )
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
      {/* Dot grid fades out below 50% zoom — a plotting surface, not a page. */}
      <div
        aria-hidden
        className="absolute inset-0 transition-opacity duration-200"
        style={{
          backgroundImage: "radial-gradient(circle, #27272a 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          opacity: transform.scale >= 0.5 ? 0.55 : Math.max(0, (transform.scale - 0.3) * 1.8),
        }}
      />
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
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
}

// ---------------------------------------------------------------------------
// Artboards
// ---------------------------------------------------------------------------

function mountedFrames(): HTMLIFrameElement[] {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[data-design-frame]"))
}

function ArtboardCard({
  board,
  label,
  theme,
  picking,
  contentEpoch,
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
        route={board.route}
        label={label}
        device={device}
        projectId={projectId}
        width={boardWidth(device)}
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
              epoch={contentEpoch}
            />
          ) : (
            <FrameError width={device.width} height={device.height} reason="No sandbox token — reload the surface." />
          )}
        </DeviceChrome>
      </div>
    </div>
  )
}

function ArtboardHeader({
  route,
  label,
  device,
  projectId,
  width,
}: {
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
          <DropdownMenuItem>
            <RotateCwIcon className="size-3.5" />
            Rotate
          </DropdownMenuItem>
          <DropdownMenuItem>
            <CopyIcon className="size-3.5" />
            Duplicate at another device
          </DropdownMenuItem>
          <DropdownMenuItem>
            <ExternalLinkIcon className="size-3.5" />
            Open in new tab
          </DropdownMenuItem>
          <DropdownMenuItem>
            <RefreshCwIcon className="size-3.5" />
            Reload
          </DropdownMenuItem>
          <DropdownMenuItem>
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
function LazyFrame({
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
  const [failed, setFailed] = useState<string | null>(null)

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

  if (failed) {
    return <FrameError width={width} height={height} reason={failed} />
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
          onError={() => setFailed("The sandbox refused this frame.")}
        />
      ) : (
        <PlaceholderSkeleton width={width} height={height} label={name} />
      )}
    </div>
  )
}

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
