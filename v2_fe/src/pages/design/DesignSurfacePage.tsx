/// The Design Surface (§9.1): toolbar, left panel, infinite canvas, right
/// panel. The canvas is the hero — everything else stays quiet and collapsible.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  CrosshairIcon,
  HandIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  MousePointer2Icon,
  ScanIcon,
  SunIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

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
  fetchSandboxToken,
  type ComponentEntry,
  type DesignComment,
  type DesignManifest,
  sandboxUrl,
} from "@/lib/design-api"
import { TokenEditor } from "@/pages/design/token-editor"
import { openTaskflowRealtimeStream, taskflowTables, type TaskflowWorkspace } from "@/lib/taskflow-api"
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
  RESPONSIVE_REVIEW_DEVICES,
  artboardKey,
  deviceById,
  layoutRows,
  type Artboard,
  type DeviceGroup,
} from "@/lib/design-devices"
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
import { sanitizeSelection, type SelectionState } from "./design-selection"
import { CommandPalette, type PaletteItem } from "./design-palette"
import { nextDesignTab, type DesignTab } from "./design-tabs"
import { ComponentDialog } from "./component-dialog"

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
  const [comments, setComments] = useState<DesignComment[]>([])
  const [selection, setSelection] = useState<(SelectionState & { boardKey: string }) | null>(null)
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  // Which pages are open on the canvas — one ROW per open route. Seeded to
  // every route once per project (see the manifest-load effect below); after
  // that, purely user-driven (PagePicker / PagesPanel / row close button).
  const [openRoutes, setOpenRoutes] = useState<string[]>([])
  const seededProjectRef = useRef<number | null>(null)
  // Artboards are DERIVED, never stored: `layoutRows` is pure, so the same
  // (openRoutes, deviceIds) always produces the same boards in the same
  // `route@device`-keyed shape DesignCanvas/selection/pins already expect.
  const artboards = useMemo(() => layoutRows(openRoutes, deviceIds), [openRoutes, deviceIds])

  const refreshComments = useCallback(() => {
    if (!projectId) return
    fetchDesignComments(projectId).then(setComments).catch(() => null)
  }, [projectId])

  useEffect(() => {
    refreshComments()
  }, [refreshComments])

  // Design realtime: file writes remount artboards; comment updates refresh
  // pins. One small dedicated SSE connection over the same hub — the groups
  // are derived server-side from the caller's membership.
  useEffect(() => {
    if (!projectId) return
    return openTaskflowRealtimeStream({
      groups: [
        `project:${projectId}:design_files`,
        `project:${projectId}:design_comments`,
      ],
      onEvent: (event) => {
        if (event.table === taskflowTables.designFiles) {
          setContentEpoch((e) => e + 1)
        } else if (event.table === taskflowTables.designComments) {
          refreshComments()
        }
      },
    })
  }, [projectId, refreshComments])

  // --- load manifest + token ------------------------------------------------
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    Promise.all([fetchDesignManifest(projectId), fetchSandboxToken(projectId)])
      .then(([m, token]) => {
        if (cancelled) return
        setManifest(m)
        setSandboxToken(token)
        setError(null)
        // Open every route once per project. After that, openRoutes is
        // purely user-driven, so re-fetching the same project's manifest
        // (e.g. on a file-change refresh) never fights the human's picks.
        if (seededProjectRef.current !== projectId) {
          seededProjectRef.current = projectId
          setOpenRoutes(m.routes.map((route) => route.path))
        }
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

  // Swap in the three review devices for whatever pages are already open, and
  // fit the new (wider) grid into view.
  const responsiveReview = useCallback(() => {
    if (!openRoutes.length) return
    const nextDeviceIds = [...RESPONSIVE_REVIEW_DEVICES]
    setDeviceIds(nextDeviceIds)
    const el = canvasContainerRef.current
    const viewport = el ? { w: el.clientWidth, h: el.clientHeight } : { w: 1200, h: 800 }
    setTransform(fitTransform(layoutRows(openRoutes, nextDeviceIds), viewport))
  }, [openRoutes])

  const handleSelect = useCallback(
    (raw: Record<string, unknown>, board: Artboard) => {
      const clean = sanitizeSelection(raw, board.route, deviceById(board.deviceId).id)
      if (!clean) return
      setSelection({ ...clean, boardKey: board.key })
      setPicking(false)
    },
    [],
  )

  const selectionOverlay = useMemo(() => {
    if (!selection) return null
    return { rect: selection.rect, boardKey: selection.boardKey }
  }, [selection])

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
          const board = artboards.find((b) => b.route === comment.pagePath)
          if (board) {
            focusBoard(board.key, transform)
            const frame = document.querySelector<HTMLIFrameElement>(
              `iframe[data-board-key="${CSS.escape(board.key)}"]`,
            )
            frame?.contentWindow?.postMessage({ type: "design:flash", selector: comment.elementPath }, "*")
          }
        }}
      />
    ),
    [comments, artboards, transform],
  )

  // A small header per ROW (not per artboard — `ArtboardHeader` inside
  // DesignCanvas already labels each device column): the page's name plus a
  // close button, sitting at the row's origin. Row `y` comes straight out of
  // `artboards` (every board in a row shares it) rather than recomputing the
  // gutter math here, so it can never drift from what actually rendered.
  const rowHeaders = useMemo(() => {
    const rowY = new Map<string, number>()
    for (const b of artboards) if (!rowY.has(b.route)) rowY.set(b.route, b.y)
    return (
      <>
        {openRoutes.map((route) => {
          const y = rowY.get(route)
          if (y == null) return null
          const title = manifest?.routes.find((r) => r.path === route)?.title ?? route
          return (
            <div
              key={`row-header:${route}`}
              className="absolute flex items-center gap-2 text-xs text-zinc-300"
              style={{ left: 0, top: y - 28 }}
            >
              <span className="font-semibold text-zinc-100">{title}</span>
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
  }, [artboards, openRoutes, manifest, closeRoute])

  const paletteItems: PaletteItem[] = useMemo(() => {
    if (!manifest) return []
    const routeItems: PaletteItem[] = manifest.routes.map((r) => ({
      key: `route:${r.path}`,
      label: r.title,
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
      hint: c.pagePath,
      group: "Comments",
      run: () => {
        const board = artboards.find((b) => b.route === c.pagePath)
        if (board) focusBoard(board.key, transform)
      },
    }))
    return [...routeItems, ...componentItems, ...commentItems]
  }, [manifest, comments, artboards, transform, deviceIds, openRoute])

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
          onChange={setOpenRoutes}
        />

        <DevicePicker deviceIds={deviceIds} onChange={setDeviceIds} />

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
              onClearContextChip={() => setSelection(null)}
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
              sandboxToken={sandboxToken}
              contentEpoch={contentEpoch}
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
                selection={selection}
                manifest={manifest}
                projectId={projectId}
                onDeselect={() => setSelection(null)}
                onCommentCreated={() => refreshComments()}
              />
            </TabsContent>

            <TabsContent value="components">
              <ComponentsPanel manifest={manifest} sandboxToken={sandboxToken} />
            </TabsContent>

            <TabsContent value="tokens">
              {/* Give the token editor room — it was cramped in the old
                  260px left-panel slot. */}
              {projectId ? (
                <TokenEditor projectId={projectId} onSaved={() => setContentEpoch((e) => e + 1)} />
              ) : null}
            </TabsContent>

            <TabsContent value="pages">
              <PagesPanel
                manifest={manifest}
                openRoutes={openRoutes}
                onToggleRoute={toggleRouteFromPanel}
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
  onChange,
}: {
  routes: { path: string; title: string }[]
  openRoutes: string[]
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
        ? (routes.find((r) => r.path === openRoutes[0])?.title ?? openRoutes[0])
        : `${routes.find((r) => r.path === openRoutes[0])?.title ?? openRoutes[0]} +${openRoutes.length - 1}`

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
              <span className="flex-1">{r.title}</span>
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
// Right-panel tabs: Pages + Components (Inspect lives in design-inspector.tsx,
// Tokens is the standalone TokenEditor mounted directly above).
// ---------------------------------------------------------------------------

function PagesPanel({
  manifest,
  openRoutes,
  onToggleRoute,
}: {
  manifest: DesignManifest | null
  openRoutes: string[]
  onToggleRoute: (route: string) => void
}) {
  return (
    <div className="flex flex-col py-1">
      {(manifest?.routes ?? []).map((route) => {
        const open = openRoutes.includes(route.path)
        return (
          <button
            key={route.path}
            className={cn(
              "flex w-full items-center justify-between rounded px-3 py-1.5 text-left text-sm hover:bg-muted",
              open && "bg-muted/60 font-medium",
            )}
            onClick={() => onToggleRoute(route.path)}
          >
            <span>{route.title}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{route.path}</span>
          </button>
        )
      })}
      {!manifest?.routes.length && <p className="px-3 py-2 text-xs text-muted-foreground">No pages yet.</p>}
    </div>
  )
}

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
