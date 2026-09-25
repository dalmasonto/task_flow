/// The Design Surface (§9.1): toolbar, left panel, infinite canvas, right
/// panel. The canvas is the hero — everything else stays quiet and collapsible.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ColumnsIcon,
  CrosshairIcon,
  HandIcon,
  LayoutGridIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  MousePointer2Icon,
  RowsIcon,
  ScanIcon,
  SunIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { Button } from "@/components/ui/button"
import {
  fetchDesignComments,
  fetchDesignManifest,
  fetchLayout,
  fetchSandboxToken,
  saveLayout,
  type ComponentEntry,
  type DesignComment,
  type DesignManifest,
  sandboxUrl,
} from "@/lib/design-api"
import { ResourceEditor } from "@/pages/design/resource-editor"
import { TokenEditor } from "@/pages/design/token-editor"
import { taskflowTables, type TaskflowWorkspace } from "@/lib/taskflow-api"
import { onDesignRealtimeEvent } from "@/lib/design-realtime"
import { useAgentChat } from "@/components/chat/use-agent-chat"
import { AgentsConversationView } from "@/components/chat/conversation-view"
import { mapLiveChannelChats } from "@/lib/live-mappers"
import { PROJECT_ROOM_TITLE, type Project } from "@/lib/workspace-view"
import { type AuthUser } from "@/lib/auth-api"
import { type DesignRef } from "@/lib/design-ref"
import {
  DEFAULT_DEVICE_ID,
  DEVICE_PRESETS,
  DEVICE_GROUP_LABELS,
  HEADER_H,
  RESPONSIVE_REVIEW_DEVICES,
  artboardKey,
  boardsForView,
  deviceById,
  type Artboard,
  type DeviceGroup,
} from "@/lib/design-devices"
import {
  CANVAS_VIEWS,
  DEFAULT_LAYOUT,
  pageLabel,
  type CanvasView,
  type LayoutDoc,
} from "@/lib/design-layout"
import {
  DesignCanvas,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  type CanvasTransform,
} from "./design-canvas"
import { fitTransform } from "./canvas-view"
import { toolForKey, type CanvasTool } from "./canvas-tools"
import { CommentPins, DesignInspector } from "./design-inspector"
import { boardForComment, commentRoute } from "./design-comments"
import { sanitizeSelection, widenSelection, pinNumber, type SelectionState } from "./design-selection"
import {
  addSelection,
  removeSelection,
  replaceSelection,
  type SelectionList,
} from "./selection-list"
import { CommandPalette, type PaletteItem } from "./design-palette"
import { nextDesignTab, type DesignTab } from "./design-tabs"
import { readUIState, writeUIState } from "./design-ui-state"
import { shouldSeedRoutes } from "./design-view"
import { ComponentDialog } from "./component-dialog"
import { PagesPanel } from "./pages-panel"

/** A selection plus the board it was captured on — the key the canvas overlay
 *  draws its rect against and the frame `design:flash` posts into. */
type PickedSelection = SelectionState & { boardKey: string }

export function DesignSurfacePage({
  projectId,
  project,
  liveWorkspace,
  currentUser,
  onWorkspaceUpdate,
  onRefreshWorkspace,
  onComposeTask,
}: {
  projectId: number | null
  project: Project | null
  liveWorkspace: TaskflowWorkspace | null
  currentUser: AuthUser | null
  onWorkspaceUpdate: (updater: (workspace: TaskflowWorkspace) => TaskflowWorkspace) => void
  onRefreshWorkspace: () => Promise<void>
  onComposeTask: (body: string) => void
}) {
  const navigate = useNavigate()
  const [manifest, setManifest] = useState<DesignManifest | null>(null)
  const [sandboxToken, setSandboxToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transform, setTransform] = useState<CanvasTransform>({ x: 40, y: 40, scale: 0.6 })
  const [deviceIds, setDeviceIds] = useState<string[]>([DEFAULT_DEVICE_ID])
  const [picking, setPicking] = useState(false)
  const [canvasTool, setCanvasTool] = useState<CanvasTool>("select")
  const [theme, setTheme] = useState("light")
  /** Bumped on server-side file changes so iframes remount with fresh content. */
  const [contentEpoch, setContentEpoch] = useState(0)
  /** One counter per board, layered ON TOP of the global `contentEpoch` above.
   *  A server-side file change remounts everything (that epoch), while a single
   *  board's Reload must remount only that board — without this overlay, one
   *  click would reload every frame on the canvas. The state lives HERE, on the
   *  surface, because the surface owns the actions. */
  const [boardEpochs, setBoardEpochs] = useState<Map<string, number>>(new Map())
  const [comments, setComments] = useState<DesignComment[]>([])
  /** Every selection on the canvas, plus which row of them is active. The
   *  ACTIVE one is "the selection" for every other surface in this file — the
   *  canvas overlay, the chat rail's context chip, the Inspector's breadcrumb
   *  and its comment form — and the list operations that maintain it (the
   *  dedupe, a removal, and the active index after either) live in
   *  `selection-list`, where they are unit-tested.
   *
   *  A selection can be captured on ANY page open on the canvas, so the board it
   *  came from travels with it: the overlay rect is drawn in that board's
   *  coordinates, and `design:flash` resolves the path inside that frame. It is
   *  not re-derivable from the route, which is open on several devices at once. */
  const [selections, setSelections] = useState<SelectionList<PickedSelection>>({
    list: [],
    active: -1,
  })
  // The active row, or nothing to inspect. `-1` is the empty list's active
  // index (see `selection-list`), and this line is the only place it is read.
  const selection = selections.active >= 0 ? (selections.list[selections.active] ?? null) : null
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  // Which pages are open on the canvas — one ROW per open route. Seeded to
  // every route once per project (see the hydration effect below); after that,
  // purely user-driven (PagePicker / PagesPanel / row close button).
  const [openRoutes, setOpenRoutes] = useState<string[]>([])
  const seededProjectRef = useRef<number | null>(null)
  /** The SHARED arrangement (view + groups + page labels). Server-owned; see
   *  `design-layout`. */
  const [layout, setLayout] = useState<LayoutDoc>(DEFAULT_LAYOUT)
  /** False until the per-user viewport has been read from Dexie. Writes are
   *  suppressed until then so a blank first render cannot overwrite it. */
  const hydratedRef = useRef(false)
  /** Which project that read was for. The id survives a manifest refetch (so
   *  hydration stays once-per-project) while `hydratedRef` only flips once the
   *  read FINISHED — together they are the hydration guard and the write gate,
   *  and both are cleared on a project change (see the manifest-load effect). */
  const hydratedProjectRef = useRef<number | null>(null)
  // Artboards are DERIVED, never stored: `boardsForView` is pure, so the same
  // (layout, openRoutes, deviceIds) always produces the same boards in the same
  // `route@device`-keyed shape DesignCanvas/selection/pins already expect.
  const artboards = useMemo(
    () => boardsForView(layout, openRoutes, deviceIds),
    [layout, openRoutes, deviceIds],
  )

  const refreshComments = useCallback(() => {
    if (!projectId) return
    fetchDesignComments(projectId).then(setComments).catch(() => null)
  }, [projectId])

  useEffect(() => {
    refreshComments()
  }, [refreshComments])

  // Design realtime: file writes remount artboards; comment updates refresh
  // pins; a layout change means another viewer re-arranged the canvas. These
  // ride the ONE app-level SSE stream (App.tsx) and are fanned out here via the
  // design-realtime bus. Opening a second EventSource for this page would hold
  // an HTTP/1.1 slot for its whole life and wedge realtime app-wide (see
  // ProfilePage.tsx) — which is exactly why chat stopped autoloading here.
  useEffect(() => {
    if (!projectId) return
    return onDesignRealtimeEvent((event) => {
      if (event.table === taskflowTables.designFiles) {
        setContentEpoch((e) => e + 1)
      } else if (event.table === taskflowTables.designComments) {
        refreshComments()
      } else if (event.table === taskflowTables.designLayout) {
        // The arrangement is SHARED (view + groups), so adopt the other
        // viewer's copy. Only `layout` is replaced: the viewport half of the
        // state — open pages, devices, transform, tool, tab, theme — is
        // per-user and deliberately left alone. Last write wins, matching
        // `PUT .../layout`; a failed read leaves the current arrangement up
        // rather than blanking the canvas.
        void fetchLayout(projectId).then(setLayout).catch(() => null)
      }
    })
  }, [projectId, refreshComments])

  // --- load manifest + token + shared layout --------------------------------
  useEffect(() => {
    if (!projectId) return
    // Nothing has been read or seeded for a freshly-loaded project, and the
    // write gate starts shut. Clearing that state HERE — this effect is
    // declared above the hydration and persistence effects, so the clears land
    // before either of them runs in this same commit — is what keeps an A→B
    // switch from writing A's viewport into B's record.
    hydratedRef.current = false
    hydratedProjectRef.current = null
    let cancelled = false
    Promise.all([
      fetchDesignManifest(projectId),
      fetchSandboxToken(projectId),
      fetchLayout(projectId),
    ])
      .then(([m, token, doc]) => {
        if (cancelled) return
        setManifest(m)
        setSandboxToken(token)
        setLayout(doc)
        setError(null)
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [projectId])

  const [paletteOpen, setPaletteOpen] = useState(false)

  // Right panel tab: defaults to Pages, and auto-switches to Inspect the
  // moment an element is picked on the canvas (a newly-appeared selection) —
  // see `nextDesignTab`. `hadSelectionRef` tracks the previous render's
  // selection presence so the effect can tell "just appeared" apart from
  // "already there" without re-running on every unrelated selection field.
  const [rightTab, setRightTab] = useState<DesignTab>(() => nextDesignTab(false, "", false) as DesignTab)
  const hadSelectionRef = useRef(false)
  useEffect(() => {
    const hasSelection = selection != null
    setRightTab((current) => nextDesignTab(hadSelectionRef.current, current, hasSelection) as DesignTab)
    hadSelectionRef.current = hasSelection
  }, [selection])

  // --- hydrate the per-user viewport, then seed if nothing was stored -------
  // Runs at most ONCE per project. Without the guard the effect would re-run
  // whenever `manifest` changes identity and overwrite the user's live edits
  // with the (debounced, therefore stale) stored copy.
  useEffect(() => {
    if (!projectId || !currentUser || !manifest) return
    // The manifest can be one project behind: a switch renders once with the
    // previous project's manifest still in state, and seeding from THAT would
    // open the wrong project's pages under the new project's id.
    if (manifest.project !== projectId) return
    if (hydratedProjectRef.current === projectId) return
    hydratedProjectRef.current = projectId
    let cancelled = false
    ;(async () => {
      const stored = await readUIState(currentUser.id, projectId)
      if (cancelled) return

      if (stored) {
        setOpenRoutes(stored.openRoutes)
        setDeviceIds(stored.deviceIds)
        setTransform(stored.transform)
        setCanvasTool(stored.canvasTool)
        setRightTab(stored.rightTab)
        setTheme(stored.theme)
      }
      // "Already seeded" is per PROJECT, not a global flag — switching projects
      // must seed the new project's manifest rather than read the old one's.
      const alreadySeeded = seededProjectRef.current === projectId
      if (shouldSeedRoutes(stored, alreadySeeded)) {
        setOpenRoutes(manifest.routes.map((r) => r.path))
      }
      seededProjectRef.current = projectId
      hydratedRef.current = true
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, currentUser, manifest])

  // --- persist the viewport (debounced: panning fires on every pointermove) --
  useEffect(() => {
    if (!projectId || !currentUser || !hydratedRef.current) return
    const timer = window.setTimeout(() => {
      void writeUIState({
        userId: currentUser.id,
        projectId,
        openRoutes,
        deviceIds,
        transform,
        canvasTool,
        rightTab,
        theme,
        updatedAt: Date.now(),
      })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [projectId, currentUser, openRoutes, deviceIds, transform, canvasTool, rightTab, theme])

  // The server decides validity, so a rejected save is surfaced rather than
  // swallowed — otherwise the toolbar would show a view the project does not
  // actually have.
  const updateLayout = useCallback(
    (next: LayoutDoc) => {
      const previous = layout
      setLayout(next)
      if (!projectId) return
      saveLayout(projectId, next).catch((err: Error) => {
        setLayout(previous)
        setError(err.message)
      })
    },
    [layout, projectId],
  )

  // --- keyboard shortcuts (§9.7) --------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      if (!typing) {
        if (e.key.toLowerCase() === "c") setPicking((p) => !p)
        if (e.key === "Escape") setPicking(false)
        const tool = toolForKey(e.key)
        if (tool) setCanvasTool(tool)
        if (e.key === "+" || e.key === "=")
          setTransform((t) => ({ ...t, scale: Math.min(MAX_SCALE, t.scale * ZOOM_STEP) }))
        if (e.key === "-")
          setTransform((t) => ({ ...t, scale: Math.max(MIN_SCALE, t.scale / ZOOM_STEP) }))
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Open a route (idempotent) preserving the manifest's route order, so a
  // freshly-opened row's position is deterministic regardless of click order.
  const openRoute = useCallback(
    (route: string) => {
      setOpenRoutes((current) => {
        if (current.includes(route)) return current
        const set = new Set([...current, route])
        return (manifest?.routes ?? [])
          .map((r) => r.path)
          .filter((path) => set.has(path))
      })
    },
    [manifest],
  )

  // Toggle a route open/closed from the Pages panel, focusing the row when it
  // just opened (closing needs no focus — there's nothing left to look at).
  const toggleRouteFromPanel = useCallback(
    (route: string) => {
      const willOpen = !openRoutes.includes(route)
      if (willOpen) openRoute(route)
      else setOpenRoutes((current) => current.filter((r) => r !== route))
      if (willOpen) focusBoard(artboardKey(route, deviceIds[0] ?? DEFAULT_DEVICE_ID), transform)
    },
    [openRoutes, openRoute, deviceIds, transform],
  )

  const closeRoute = useCallback((route: string) => {
    setOpenRoutes((current) => current.filter((r) => r !== route))
  }, [])

  // --- per-board actions (the ⋯ menu on every artboard header) ---------------
  const handleReloadBoard = useCallback((key: string) => {
    setBoardEpochs((current) => new Map(current).set(key, (current.get(key) ?? 0) + 1))
  }, [])

  const handleOpenBoard = useCallback(
    (key: string) => {
      if (!sandboxToken) return
      const board = artboards.find((b) => b.key === key)
      if (!board) return
      // The sandbox URL is the same origin-isolated render the frame shows.
      window.open(sandboxUrl(sandboxToken, board.route), "_blank", "noopener")
    },
    [sandboxToken, artboards],
  )

  const handleDuplicateBoard = useCallback(
    (key: string, deviceId: string) => {
      const board = artboards.find((b) => b.key === key)
      if (!board) return
      setDeviceIds((current) =>
        current.includes(deviceId) ? current : [...current, deviceId],
      )
    },
    [artboards],
  )

  const handleRemoveBoard = useCallback((route: string) => closeRoute(route), [closeRoute])

  // Swap in the three review devices for whatever pages are already open, and
  // fit the new (wider) grid into view. Fits the arrangement actually on
  // screen — fitting a rows-shaped box while the canvas shows bands or groups
  // would frame the wrong thing.
  const responsiveReview = useCallback(() => {
    if (!openRoutes.length) return
    const nextDeviceIds = [...RESPONSIVE_REVIEW_DEVICES]
    setDeviceIds(nextDeviceIds)
    const el = canvasContainerRef.current
    const viewport = el ? { w: el.clientWidth, h: el.clientHeight } : { w: 1200, h: 800 }
    setTransform(fitTransform(boardsForView(layout, openRoutes, nextDeviceIds), viewport))
  }, [openRoutes, layout])

  const handleSelect = useCallback(
    (raw: Record<string, unknown>, board: Artboard) => {
      const clean = sanitizeSelection(raw, board.route, deviceById(board.deviceId).id)
      if (!clean) return
      // A second click on an element that is already selected re-activates its
      // row instead of adding a twin (`addSelection` decides which).
      setSelections((current) => addSelection(current.list, { ...clean, boardKey: board.key }))
      setPicking(false)
    },
    [],
  )

  const selectionOverlay = useMemo(() => {
    if (!selection) return null
    return { rect: selection.rect, boardKey: selection.boardKey }
  }, [selection])

  // Re-anchor the ACTIVE selection to a breadcrumb crumb (`widenSelection`
  // decides what that means; index 0 is the outermost ancestor). The board is
  // kept deliberately: the crumb's path is only resolvable inside the frame it
  // was captured in — it is the selector `design:flash` queries and the anchor
  // the comment saves — so widening must not move the comment to another board.
  // `replaceSelection` keeps the row where it is in the list, and drops the row
  // it now duplicates rather than leaving two rows for one element.
  const handleWiden = useCallback((crumb: number) => {
    setSelections((current) => {
      const row = current.list[current.active]
      if (!row) return current
      const widened = widenSelection(row, crumb)
      if (!widened) return current
      return replaceSelection(current.list, current.active, { ...widened, boardKey: row.boardKey })
    })
  }, [])

  // Make a row from the Inspector's list the active one. This is the same
  // operation a canvas click is — an equivalent row is re-activated, never
  // duplicated — and the canvas follows it: the overlay rect is drawn from the
  // ACTIVE selection, so switching to a row captured on another page without
  // going there would put the mark where the human cannot see it.
  const handleActivateSelection = useCallback(
    (index: number) => {
      setSelections((current) => {
        const row = current.list[index]
        return row ? addSelection(current.list, row) : current
      })
      const row = selections.list[index]
      if (row) focusBoard(row.boardKey, transform)
    },
    [selections, transform],
  )

  const handleRemoveSelection = useCallback((index: number) => {
    setSelections((current) => removeSelection(current, index))
  }, [])

  const handleClearSelections = useCallback(() => setSelections({ list: [], active: -1 }), [])

  // "Take me there" for a comment row or a palette entry: one function, so the
  // two surfaces cannot drift into focusing different boards. (The pin has its
  // own handler because it also flashes the element inside the frame.)
  const focusComment = useCallback(
    (comment: DesignComment) => {
      const board = boardForComment(artboards, comment)
      if (board) focusBoard(board.key, transform)
    },
    [artboards, transform],
  )

  // The inspected element rides into the design rail's composer as a context
  // chip; the conversation view encodes it as a design-ref block on send. Map
  // the sandbox SelectionState fields onto the DesignRef shape (nulls → absent).
  const contextChip = useMemo<{ label: string; ref: DesignRef } | null>(() => {
    if (!selection) return null
    return {
      label: selection.component ?? selection.route ?? "Selected element",
      ref: {
        pagePath: selection.route,
        componentName: selection.component ?? undefined,
        elementPath: selection.elementPath,
        srcRef: selection.srcRef ?? undefined,
        viewport: selection.viewport,
      },
    }
  }, [selection])

  const pins = useMemo(
    () => (
      <CommentPins
        comments={comments}
        boards={artboards}
        selectedPinId={null}
        onSelectPin={(comment) => {
          // Zoom to the pin's artboard and flash the element inside the frame.
          const board = boardForComment(artboards, comment)
          if (board) {
            focusBoard(board.key, transform)
            const frame = document.querySelector<HTMLIFrameElement>(
              `iframe[data-board-key="${CSS.escape(board.key)}"]`,
            )
            frame?.contentWindow?.postMessage({ type: "design:flash", selector: comment.element_path }, "*")
          }
        }}
      />
    ),
    [comments, artboards, transform],
  )

  // The display name for a page, resolved ONCE for both places this file draws
  // one: the row-header overlay below, and the per-board header inside
  // DesignCanvas (handed over as `labelFor`). `pageLabel` is the single
  // resolver — a label if the document has one, else the manifest's own title,
  // else the raw route — so a renamed page cannot show one name in the row
  // header and another on the artboard.
  const labelFor = useMemo(() => {
    const titles = new Map((manifest?.routes ?? []).map((r) => [r.path, r.title]))
    return (route: string) => pageLabel(layout, route, titles.get(route) ?? route)
  }, [layout, manifest])

  // A small header per ROW (not per artboard — `ArtboardHeader` inside
  // DesignCanvas already labels each device column): the page's name plus a
  // close button, sitting at the row's origin. Row `y` comes straight out of
  // `artboards` (every board in a row shares it) rather than recomputing the
  // gutter math here, so it can never drift from what actually rendered.
  //
  // ROWS ONLY. The overlay anchors at the arrangement's origin (`left: 0`) and
  // puts each page at its row's `y` — a thing that only exists in `rows`, where
  // every page is a row of its own. In `bands`/`groups` every page's first
  // board shares the FIRST band's `y`, so the whole set would land on one point
  // and draw on top of itself, leaving only the topmost close button hittable.
  // Nothing is lost by hiding it: `ArtboardHeader` already labels each board
  // with its route, and the Pages panel carries the same close affordance.
  const rowHeaders = useMemo(() => {
    if (layout.view !== "rows") return null
    const rowY = new Map<string, number>()
    for (const b of artboards) if (!rowY.has(b.route)) rowY.set(b.route, b.y)
    return (
      <>
        {openRoutes.map((route) => {
          const y = rowY.get(route)
          if (y == null) return null
          return (
            <div
              key={`row-header:${route}`}
              className="absolute flex items-center gap-2 text-xs text-zinc-300"
              style={{ left: 0, top: y - HEADER_H }}
            >
              <span className="font-semibold text-zinc-100">{labelFor(route)}</span>
              <span className="font-mono text-[11px] text-zinc-500">{route}</span>
              <button
                type="button"
                className="rounded p-0.5 hover:bg-zinc-800"
                title={`Close ${route}`}
                onClick={() => closeRoute(route)}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          )
        })}
      </>
    )
  }, [artboards, openRoutes, labelFor, closeRoute, layout.view])

  const paletteItems: PaletteItem[] = useMemo(() => {
    if (!manifest) return []
    const routeItems: PaletteItem[] = manifest.routes.map((r) => ({
      key: `route:${r.path}`,
      // The palette renders this as the item's text, so it shows the page's
      // display name — and searches it too: matching on a name that appears
      // nowhere else on screen would hide a renamed page from its own name.
      // The route itself stays visible in the hint.
      label: labelFor(r.path),
      hint: r.path,
      group: "Routes",
      run: () => {
        openRoute(r.path)
        focusBoard(artboardKey(r.path, deviceIds[0] ?? DEFAULT_DEVICE_ID), transform)
      },
    }))
    const componentItems: PaletteItem[] = manifest.components.map((c) => ({
      key: `comp:${c.name}`,
      label: c.name,
      hint: `${c.usageCount} use(s)`,
      group: "Components",
      run: () => {
        setRightTab("components")
      },
    }))
    const commentItems: PaletteItem[] = comments.map((c) => ({
      key: `comment:${c.id}`,
      label: c.body.slice(0, 60),
      // The pin letter is the ONLY thing tying a palette entry to the badge on
      // the canvas — without it the two lists are unrelatable.
      hint: `${pinNumber(c.id)} · ${commentRoute(c)}`,
      group: "Comments",
      run: () => focusComment(c),
    }))
    return [...routeItems, ...componentItems, ...commentItems]
  }, [manifest, comments, transform, deviceIds, openRoute, labelFor, focusComment])

  if (!projectId) {
    return (
      <EmptyCanvas message="Pick a project first — the design surface hangs off a project workspace." />
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      {/* Toolbar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/board")}>
          <ChevronLeftIcon className="size-4" />
          Back
        </Button>
        <span className="text-sm font-semibold">Design</span>

        <PagePicker
          routes={manifest?.routes ?? []}
          openRoutes={openRoutes}
          nameFor={labelFor}
          onChange={setOpenRoutes}
        />

        <DevicePicker deviceIds={deviceIds} onChange={setDeviceIds} />

        <ViewPicker view={layout.view} onChange={(view) => updateLayout({ ...layout, view })} />

        <ZoomControl
          transform={transform}
          onChange={setTransform}
          boards={artboards}
          viewportRef={canvasContainerRef}
        />

        <div className="flex items-center gap-1 rounded-md border p-0.5">
          <Button
            variant={canvasTool === "select" ? "default" : "ghost"}
            size="icon"
            title="Select (V)"
            onClick={() => setCanvasTool("select")}
          >
            <MousePointer2Icon className="size-4" />
          </Button>
          <Button
            variant={canvasTool === "pan" ? "default" : "ghost"}
            size="icon"
            title="Pan (H)"
            onClick={() => setCanvasTool("pan")}
          >
            <HandIcon className="size-4" />
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={responsiveReview}>
            Responsive review
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Toggle theme"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
          </Button>
          <Button
            variant={picking ? "default" : "outline"}
            size="sm"
            onClick={() => setPicking((p) => !p)}
          >
            <CrosshairIcon className="size-4" />
            {picking ? "Picking…" : "Pick"}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* LEFT: the design chat rail — the reusable chat, filtered to design. */}
        <aside className="flex w-[380px] shrink-0 flex-col border-r">
          {project ? (
            <DesignChatRail
              project={project}
              liveWorkspace={liveWorkspace}
              currentUser={currentUser}
              onWorkspaceUpdate={onWorkspaceUpdate}
              onRefreshWorkspace={onRefreshWorkspace}
              onComposeTask={onComposeTask}
              contextChip={contextChip}
              // The chip carries the ACTIVE selection, so its ✕ drops that one
              // row and leaves the rest of the list standing — clearing every
              // selection from a control that names one would lose picks the
              // human never asked to lose.
              onClearContextChip={() => handleRemoveSelection(selections.active)}
            />
          ) : (
            <EmptyCanvas message={"Loading design conversation…"} />
          )}
        </aside>

        {/* MIDDLE: the canvas (unchanged). */}
        <main ref={canvasContainerRef} className="relative min-w-0 flex-1">
          {error ? (
            <EmptyCanvas message={error} />
          ) : manifest && manifest.routes.length === 0 ? (
            <EmptyCanvas
              message={
                "No pages yet.\nPrompt an agent: “design_get_tokens, then design_write_page('/')" +
                " — or write styles/tokens.css and pages/index.html by hand."
              }
            />
          ) : (
            <DesignCanvas
              artboards={artboards}
              transform={transform}
              onTransformChange={setTransform}
              picking={picking}
              canvasTool={canvasTool}
              theme={theme}
              projectId={projectId}
              labelFor={labelFor}
              sandboxToken={sandboxToken}
              contentEpoch={contentEpoch}
              boardEpochs={boardEpochs}
              deviceIds={deviceIds}
              onReloadBoard={handleReloadBoard}
              onOpenBoard={handleOpenBoard}
              onDuplicateBoard={handleDuplicateBoard}
              onRemoveBoard={handleRemoveBoard}
              selection={selectionOverlay}
              pins={
                <>
                  {rowHeaders}
                  {pins}
                </>
              }
              onSelect={handleSelect}
            />
          )}
        </main>

        {/* RIGHT: Inspect / Components / Tokens / Pages — one panel, four
            tabs. Auto-switches to Inspect when an element is picked on the
            canvas (see the `rightTab` effect above); otherwise the human's
            chosen tab is never fought over. */}
        <aside className="hidden min-h-0 w-[380px] shrink-0 flex-col border-l lg:flex">
          <Tabs
            value={rightTab}
            onValueChange={(value) => setRightTab(value as DesignTab)}
            className="h-full min-h-0"
          >
            <TabsList>
              <TabsTrigger value="inspect">Inspect</TabsTrigger>
              <TabsTrigger value="components">
                Components{manifest ? ` (${manifest.components.length})` : ""}
              </TabsTrigger>
              <TabsTrigger value="tokens">Tokens</TabsTrigger>
              <TabsTrigger value="pages">Pages</TabsTrigger>
            </TabsList>

            <TabsContent value="inspect">
              <DesignInspector
                selections={selections.list}
                activeIndex={selections.active}
                manifest={manifest}
                projectId={projectId}
                labelFor={labelFor}
                // The live list (SSE + a refetch on create). ONE list for the
                // panel: the per-row "already commented" badges are counted from
                // it, and the Comments section below them is drawn from it —
                // which is why the section takes it as a prop rather than
                // fetching its own copy that would go stale on the next comment.
                comments={comments}
                onActivate={handleActivateSelection}
                onRemove={handleRemoveSelection}
                onClear={handleClearSelections}
                onCommentsChanged={refreshComments}
                onWiden={handleWiden}
                onFocusComment={focusComment}
              />
            </TabsContent>

            <TabsContent value="components">
              <ComponentsPanel manifest={manifest} sandboxToken={sandboxToken} />
            </TabsContent>

            <TabsContent value="tokens">
              {/* Give the token editor room — it was cramped in the old
                  260px left-panel slot. The resource editor sits below it,
                  not in a tab of its own: both answer "how does this project
                  look", and a font is only useful next to the colors it
                  renders in. */}
              {projectId ? (
                <>
                  <TokenEditor projectId={projectId} onSaved={() => setContentEpoch((e) => e + 1)} />
                  <ResourceEditor projectId={projectId} onSaved={() => setContentEpoch((e) => e + 1)} />
                </>
              ) : null}
            </TabsContent>

            <TabsContent value="pages">
              <PagesPanel
                manifest={manifest}
                openRoutes={openRoutes}
                onToggleRoute={toggleRouteFromPanel}
                layout={layout}
                onLayoutChange={updateLayout}
              />
            </TabsContent>
          </Tabs>
        </aside>
      </div>

      {paletteOpen ? (
        <CommandPalette onClose={() => setPaletteOpen(false)} items={paletteItems} />
      ) : null}
    </section>
  )
}

function focusBoard(key: string, transform: CanvasTransform) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-artboard-key="${CSS.escape(key)}"]`)
    el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" })
    void transform
  })
}

// ---------------------------------------------------------------------------
// The design chat rail
// ---------------------------------------------------------------------------

/// The left rail is the SAME `useAgentChat` + `AgentsConversationView` the
/// Agents page and the dock use, so @mentions, attachments, prompt cards and the
/// media lightbox all work here for free. Two things make it design-specific:
///   1. This instance is `isDesign`-scoped, so its first-page + older fetches
///      are `is_design`-scoped and its sends carry `is_design: true` (the hook's
///      shared `handleSendMessage` does NOT forward the flag, so we rely on the
///      scoped instance rather than the shared one).
///   2. The rail reads the shared Project-room channel but DISPLAYS only design
///      messages — the shared workspace still holds the whole channel.
/// It opens no SSE of its own: realtime feeds the shared `liveWorkspace` at the
/// app level, and this instance only reads it and fetches scoped pages.
function DesignChatRail({
  project,
  liveWorkspace,
  currentUser,
  onWorkspaceUpdate,
  onRefreshWorkspace,
  onComposeTask,
  contextChip,
  onClearContextChip,
}: {
  project: Project
  liveWorkspace: TaskflowWorkspace | null
  currentUser: AuthUser | null
  onWorkspaceUpdate: (updater: (workspace: TaskflowWorkspace) => TaskflowWorkspace) => void
  onRefreshWorkspace: () => Promise<void>
  onComposeTask: (body: string) => void
  contextChip: { label: string; ref: DesignRef } | null
  onClearContextChip: () => void
}) {
  // Point the shared hook at the Project-room chat so its is_design-scoped
  // loaders fire for the right channel. Derived from the same mapper + title the
  // Agents page uses; falls back to the first channel, then null (placeholder).
  const projectRoomChatId = useMemo(() => {
    if (!liveWorkspace) return null
    const chats = mapLiveChannelChats(liveWorkspace, currentUser)
    return (chats.find((chat) => chat.title === PROJECT_ROOM_TITLE) ?? chats[0])?.id ?? null
  }, [liveWorkspace, currentUser])

  const { outletContext } = useAgentChat({
    project,
    liveWorkspace,
    currentUser,
    onWorkspaceUpdate,
    onRefreshWorkspace,
    selectedChatId: projectRoomChatId,
    onComposeTask,
    isDesign: true,
  })

  // Only design messages render in the rail even though the shared workspace
  // holds the whole channel; the is_design-scoped fetches keep "newest 20 design
  // first, older on scroll" correct.
  const designChat = useMemo(() => {
    const chat = outletContext.selectedChat
    return chat ? { ...chat, messages: chat.messages.filter((message) => message.isDesign) } : null
  }, [outletContext.selectedChat])

  if (!designChat) {
    return <EmptyCanvas message={"Loading design conversation…"} />
  }

  return (
    <AgentsConversationView
      {...outletContext}
      selectedChat={designChat}
      variant="design"
      showDesignBadge={false}
      contextChip={contextChip}
      onClearContextChip={onClearContextChip}
      // Render only design messages, but advance the read cursor over the WHOLE
      // channel (like the Agents page) — the watermark must not lag on the last
      // design message.
      readCursorMessages={outletContext.selectedChat?.messages}
    />
  )
}

// ---------------------------------------------------------------------------
// Toolbar pieces
// ---------------------------------------------------------------------------

/// Multi-select: every checked route gets its own ROW on the canvas (mirrors
/// `DevicePicker`'s checkbox-list idiom below). Unlike devices, zero open
/// pages is a valid (if empty) canvas, so nothing here forces one to stay
/// checked.
function PagePicker({
  routes,
  openRoutes,
  nameFor,
  onChange,
}: {
  routes: { path: string; title: string }[]
  openRoutes: string[]
  /** The display name for a route, resolved by the caller through `pageLabel`
   *  — the same string the canvas headers and the Pages panel show. This picker
   *  renders a page's name in three places (the trigger, its multi-route
   *  variant, and every row of the menu), so it takes the resolver rather than
   *  reaching for `title` itself. */
  nameFor: (route: string) => string
  onChange: (routes: string[]) => void
}) {
  const toggle = (path: string, next: boolean) => {
    const set = new Set(openRoutes)
    if (next) set.add(path)
    else set.delete(path)
    // Preserve the manifest's route order for stable row order.
    onChange(routes.filter((r) => set.has(r.path)).map((r) => r.path))
  }

  const triggerLabel =
    openRoutes.length === 0
      ? "Open"
      : openRoutes.length === 1
        ? nameFor(openRoutes[0])
        : `${nameFor(openRoutes[0])} +${openRoutes.length - 1}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="max-w-44 gap-1 font-normal" />}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDownIcon className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-56 overflow-y-auto">
        {/* GroupLabel requires Menu.Group context — keep the label INSIDE the
            group or Base UI throws "MenuGroupContext is missing" on open. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Pages</DropdownMenuLabel>
          {routes.map((r) => (
            <DropdownMenuCheckboxItem
              key={r.path}
              checked={openRoutes.includes(r.path)}
              onCheckedChange={(checked) => toggle(r.path, checked === true)}
              closeOnClick={false}
            >
              <span className="flex-1">{nameFor(r.path)}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{r.path}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {!routes.length ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">No pages yet.</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DevicePicker({
  deviceIds,
  onChange,
}: {
  deviceIds: string[]
  onChange: (ids: string[]) => void
}) {
  const grouped = useMemo(() => {
    const groups = new Map<DeviceGroup, typeof DEVICE_PRESETS>()
    for (const d of DEVICE_PRESETS) {
      const list = groups.get(d.group) ?? []
      list.push(d)
      groups.set(d.group, list)
    }
    return groups
  }, [])

  // Multi-select via checkbox items; the last remaining device can never be
  // unchecked — a canvas with zero artboard sizes has nothing to render.
  const toggle = (id: string, next: boolean) => {
    if (!next && deviceIds.length === 1) return
    const set = new Set(deviceIds)
    if (next) set.add(id)
    else set.delete(id)
    // Preserve the preset table's order for stable layout math.
    onChange(DEVICE_PRESETS.filter((d) => set.has(d.id)).map((d) => d.id))
  }

  const triggerLabel =
    deviceIds.length === 1
      ? deviceById(deviceIds[0]).label
      : `${deviceById(deviceIds[0]).label} +${deviceIds.length - 1}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="max-w-44 gap-1 font-normal" />}
      >
        <MonitorSmartphoneIcon className="size-3.5 opacity-70" />
        <span className="truncate">{triggerLabel}</span>
        <ChevronDownIcon className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-56 overflow-y-auto">
        {[...grouped.entries()].map(([group, presets]) => (
          <DropdownMenuGroup key={group}>
            <DropdownMenuLabel>{DEVICE_GROUP_LABELS[group]}</DropdownMenuLabel>
            {presets.map((d) => (
              <DropdownMenuCheckboxItem
                key={d.id}
                checked={deviceIds.includes(d.id)}
                onCheckedChange={(checked) => toggle(d.id, checked === true)}
                closeOnClick={false}
              >
                <span className="flex-1">{d.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {d.width}×{d.height}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/// Which arrangement the canvas renders. The pick is SHARED (it is a fact about
/// the project, not about this browser), so it goes through `updateLayout` and
/// the server rather than the per-user viewport record.
function ViewPicker({ view, onChange }: { view: CanvasView; onChange: (v: CanvasView) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      {CANVAS_VIEWS.map((v) => (
        <Button
          key={v.id}
          variant={view === v.id ? "default" : "ghost"}
          size="icon-sm"
          title={`${v.label} — ${v.hint}`}
          aria-label={v.label}
          aria-pressed={view === v.id}
          onClick={() => onChange(v.id)}
        >
          {v.id === "rows" ? (
            <RowsIcon className="size-3.5" />
          ) : v.id === "bands" ? (
            <ColumnsIcon className="size-3.5" />
          ) : (
            <LayoutGridIcon className="size-3.5" />
          )}
        </Button>
      ))}
    </div>
  )
}

function ZoomControl({
  transform,
  onChange,
  boards,
  viewportRef,
}: {
  transform: CanvasTransform
  onChange: (t: CanvasTransform) => void
  boards: Artboard[]
  /** The canvas container to measure for the Fit button's viewport. */
  viewportRef: React.RefObject<HTMLElement | null>
}) {
  const handleFit = () => {
    const el = viewportRef.current
    const viewport = el
      ? { w: el.clientWidth, h: el.clientHeight }
      : { w: 1200, h: 800 }
    onChange(fitTransform(boards, viewport))
  }

  return (
    <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        title="Zoom out (-)"
        onClick={() =>
          onChange({ ...transform, scale: Math.max(MIN_SCALE, transform.scale / ZOOM_STEP) })
        }
      >
        <ZoomOutIcon className="size-3.5" />
      </Button>
      <span className="w-11 text-center font-mono text-xs text-muted-foreground">
        {Math.round(transform.scale * 100)}%
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Zoom in (+)"
        onClick={() =>
          onChange({ ...transform, scale: Math.min(MAX_SCALE, transform.scale * ZOOM_STEP) })
        }
      >
        <ZoomInIcon className="size-3.5" />
      </Button>
      <div className="mx-0.5 h-4 w-px bg-border" aria-hidden />
      <Button
        variant="ghost"
        size="icon-sm"
        title="Fit to view"
        onClick={handleFit}
      >
        <ScanIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        title="Reset to 100%"
        onClick={() => onChange({ ...transform, scale: 1 })}
      >
        100%
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Right-panel tabs: Components (Pages lives in pages-panel.tsx, Inspect in
// design-inspector.tsx, Tokens is the standalone TokenEditor mounted above).
// ---------------------------------------------------------------------------

/// The component registry list with a per-component live sandbox preview —
/// the real component rendered against the project's real tokens, not a mock.
/// Clicking a row opens `ComponentDialog`, the same sandbox render at a usable
/// size (§Task 9). Dialog/selected-component state lives HERE rather than on
/// the page: `TabsContent` is not `keepMounted`, so this state only needs to
/// survive while the Components tab itself is mounted, which it does either
/// way.
function ComponentsPanel({
  manifest,
  sandboxToken,
}: {
  manifest: DesignManifest | null
  sandboxToken: string | null
}) {
  const [selected, setSelected] = useState<ComponentEntry | null>(null)

  return (
    <>
      <div className="flex flex-col py-1">
        {(manifest?.components ?? []).map((c: ComponentEntry) => (
          <div
            key={c.name}
            role="button"
            tabIndex={0}
            className="cursor-pointer border-b px-3 py-2 outline-none last:border-b-0 hover:bg-muted/60 focus-visible:bg-muted/60"
            onClick={() => setSelected(c)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                setSelected(c)
              }
            }}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs">{c.name}</span>
              <span
                className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                title={`Used on ${c.usedOn.length} route(s)`}
              >
                ×{c.usageCount}
              </span>
            </div>
            {/* Live preview: the real component in the real sandbox against
                the project's tokens — not a mock rendering. Pointer events are
                dropped so a click anywhere on the row — thumbnail included —
                opens the dialog instead of reaching into the iframe. */}
            {sandboxToken ? (
              <div className="mt-1 overflow-hidden rounded border bg-zinc-50">
                <iframe
                  src={`${sandboxUrl(sandboxToken, `/preview/${c.name}`)}?preview=1`}
                  title={`Preview of ${c.name}`}
                  sandbox="allow-scripts allow-same-origin"
                  tabIndex={-1}
                  className="pointer-events-none h-14 w-[452px] origin-top-left scale-50 border-0"
                  loading="lazy"
                />
              </div>
            ) : null}
            {c.attrs.length ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {c.attrs.map((a) => (
                  <span key={a} className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                    {a}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {!manifest?.components.length && (
          <p className="px-3 py-2 text-xs text-muted-foreground">Registry is empty.</p>
        )}
      </div>

      <ComponentDialog
        component={selected}
        sandboxToken={sandboxToken}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
    </>
  )
}

function EmptyCanvas({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-md text-center">
        <p className="whitespace-pre-line text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}
