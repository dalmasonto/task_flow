/// The Design Surface (§9.1): toolbar, left panel, infinite canvas, right
/// panel. The canvas is the hero — everything else stays quiet and collapsible.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  CrosshairIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  SunIcon,
  LayersIcon,
  PaletteIcon,
  FileCodeIcon,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

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
  artboardKey,
  deviceById,
  makeArtboard,
  type Artboard,
  type DeviceGroup,
} from "@/lib/design-devices"
import {
  DesignCanvas,
  ZOOM_STEP,
  type CanvasTransform,
} from "./design-canvas"
import { CommentPins, DesignInspector } from "./design-inspector"
import { sanitizeSelection, type SelectionState } from "./design-selection"
import { CommandPalette, type PaletteItem } from "./design-palette"

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
  const [theme, setTheme] = useState("light")
  /** Bumped on server-side file changes so iframes remount with fresh content. */
  const [contentEpoch, setContentEpoch] = useState(0)
  const [comments, setComments] = useState<DesignComment[]>([])
  const [selection, setSelection] = useState<(SelectionState & { boardKey: string }) | null>(null)
  // Persisted per project so canvas layout survives reloads.
  const boardsByProject = useRef<Map<number, Artboard[]>>(new Map())
  const [artboards, setArtboards] = useState<Artboard[]>([])

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
        // Seed one board per route at the default device when arriving empty.
        setArtboards((current) => {
          if (current.length) return current
          const saved = boardsByProject.current.get(projectId)
          if (saved?.length) return saved
          let cursorX = 0
          return m.routes.map((route) => {
            const board = makeArtboard(route.path, DEFAULT_DEVICE_ID, cursorX, 0)
            cursorX += deviceById(DEFAULT_DEVICE_ID).width + 80
            return board
          })
        })
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    if (projectId != null && artboards.length) boardsByProject.current.set(projectId, artboards)
  }, [projectId, artboards])

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [leftSection, setLeftSection] = useState<"pages" | "components" | "tokens">("pages")

  // --- keyboard shortcuts (§9.7) --------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      if (!typing) {
        if (e.key.toLowerCase() === "c") setPicking((p) => !p)
        if (e.key === "Escape") setPicking(false)
        if (e.key === "+" || e.key === "=")
          setTransform((t) => ({ ...t, scale: Math.min(2, t.scale * ZOOM_STEP) }))
        if (e.key === "-")
          setTransform((t) => ({ ...t, scale: Math.max(0.25, t.scale / ZOOM_STEP) }))
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const addArtboard = useCallback(
    (route: string, deviceId: string) => {
      setArtboards((current) => {
        const key = artboardKey(route, deviceId)
        if (current.some((b) => b.key === key)) return current
        const maxX = Math.max(0, ...current.map((b) => b.x + deviceById(b.deviceId).width))
        return [...current, makeArtboard(route, deviceId, maxX + 80, 0)]
      })
    },
    []
  )

  const responsiveReview = useCallback(() => {
    if (!manifest?.routes.length) return
    const route = manifest.routes[0].path
    const ids = ["iphone-16-pro", "ipad-mini", "laptop"]
    for (const id of ids) addArtboard(route, id)
    setDeviceIds((prev) => [...new Set([...prev, ...ids])])
    setTransform({ x: 60, y: 80, scale: 0.5 })
  }, [manifest, addArtboard])

  // Keep the canvas in sync with the toolbar device multi-select: one artboard
  // per selected device for every route already on the canvas. Previously the
  // picker only called setDeviceIds, so selecting a device flipped the "+N"
  // label but never created (or removed) a screen.
  const handleDevicesChange = useCallback((nextIds: string[]) => {
    setArtboards((current) => {
      const routes = [...new Set(current.map((b) => b.route))]
      // Drop boards whose device was deselected.
      let next = current.filter((b) => nextIds.includes(b.deviceId))
      // Add a board per route for each newly selected device.
      for (const id of nextIds) {
        for (const route of routes) {
          if (next.some((b) => b.key === artboardKey(route, id))) continue
          const maxX = next.length
            ? Math.max(...next.map((b) => b.x + deviceById(b.deviceId).width))
            : 0
          next = [...next, makeArtboard(route, id, maxX + 80, 0)]
        }
      }
      return next
    })
    setDeviceIds(nextIds)
  }, [])

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

  const paletteItems: PaletteItem[] = useMemo(() => {
    if (!manifest) return []
    const routeItems: PaletteItem[] = manifest.routes.map((r) => ({
      key: `route:${r.path}`,
      label: r.title,
      hint: r.path,
      group: "Routes",
      run: () => {
        addArtboard(r.path, deviceIds[0] ?? DEFAULT_DEVICE_ID)
      },
    }))
    const componentItems: PaletteItem[] = manifest.components.map((c) => ({
      key: `comp:${c.name}`,
      label: c.name,
      hint: `${c.usageCount} use(s)`,
      group: "Components",
      run: () => {
        setLeftSection("components")
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
  }, [manifest, comments, artboards, transform, deviceIds, addArtboard])

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
          onOpen={(route) => {
            addArtboard(route, deviceIds[0] ?? DEFAULT_DEVICE_ID)
            focusBoard(artboardKey(route, deviceIds[0] ?? DEFAULT_DEVICE_ID), transform)
          }}
        />

        <DevicePicker deviceIds={deviceIds} onChange={handleDevicesChange} />

        <ZoomControl transform={transform} onChange={setTransform} />

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
        <main className="relative min-w-0 flex-1">
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
              theme={theme}
              sandboxToken={sandboxToken}
              contentEpoch={contentEpoch}
              selection={selectionOverlay}
              pins={pins}
              onSelect={handleSelect}
            />
          )}
        </main>

        {/* RIGHT: interim — inspector + the pages/components/tokens panel that
            used to sit on the left. Phase 2 turns this into proper tabs. */}
        <aside className="hidden w-[340px] shrink-0 flex-col overflow-y-auto border-l lg:flex">
          <DesignInspector
            selection={selection}
            manifest={manifest}
            projectId={projectId}
            onDeselect={() => setSelection(null)}
            onCommentCreated={() => refreshComments()}
          />
          <LeftPanel
            manifest={manifest}
            sandboxToken={sandboxToken}
            section={leftSection}
            onSection={setLeftSection}
            projectId={projectId}
            onFilesChanged={() => setContentEpoch((e) => e + 1)}
            onOpenRoute={(route) => addArtboard(route, deviceIds[0] ?? DEFAULT_DEVICE_ID)}
          />
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

function PagePicker({
  routes,
  onOpen,
}: {
  routes: { path: string; title: string }[]
  onOpen: (route: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="gap-1" />}>
        Open
        <ChevronDownIcon className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {/* GroupLabel requires Menu.Group context — keep the label INSIDE the
            group or Base UI throws "MenuGroupContext is missing" on open. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Pages</DropdownMenuLabel>
          {routes.map((r) => (
            <DropdownMenuItem key={r.path} onClick={() => onOpen(r.path)}>
              <span>{r.title}</span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">{r.path}</span>
            </DropdownMenuItem>
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
}: {
  transform: CanvasTransform
  onChange: (t: CanvasTransform) => void
}) {
  return (
    <div className="flex items-center gap-1 rounded border px-1">
      <button
        className="px-2 py-0.5 text-sm hover:bg-muted"
        title="Zoom out (-)"
        onClick={() => onChange({ ...transform, scale: Math.max(0.25, transform.scale / ZOOM_STEP) })}
      >
        −
      </button>
      <span className="w-12 text-center font-mono text-xs">
        {Math.round(transform.scale * 100)}%
      </span>
      <button
        className="px-2 py-0.5 text-sm hover:bg-muted"
        title="Zoom in (+)"
        onClick={() => onChange({ ...transform, scale: Math.min(2, transform.scale * ZOOM_STEP) })}
      >
        +
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function LeftPanel({
  manifest,
  sandboxToken,
  section,
  onSection,
  projectId,
  onFilesChanged,
  onOpenRoute,
}: {
  manifest: DesignManifest | null
  sandboxToken: string | null
  section: "pages" | "components" | "tokens"
  onSection: (s: "pages" | "components" | "tokens") => void
  projectId: number
  onFilesChanged: () => void
  onOpenRoute: (route: string) => void
}) {
  return (
    <aside className="hidden w-[260px] shrink-0 flex-col overflow-y-auto border-r md:flex">
      <PanelSection
        icon={<FileCodeIcon className="size-3.5" />}
        title="Pages"
        open={section === "pages"}
        onToggle={() => onSection("pages")}
      >
        {(manifest?.routes ?? []).map((route) => (
          <button
            key={route.path}
            className="flex w-full items-center justify-between rounded px-3 py-1.5 text-left text-sm hover:bg-muted"
            onClick={() => onOpenRoute(route.path)}
          >
            <span>{route.title}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{route.path}</span>
          </button>
        ))}
        {!manifest?.routes.length && <p className="px-3 py-2 text-xs text-muted-foreground">No pages yet.</p>}
      </PanelSection>

      <PanelSection
        icon={<LayersIcon className="size-3.5" />}
        title={`Components${manifest ? ` (${manifest.components.length})` : ""}`}
        open={section === "components"}
        onToggle={() => onSection("components")}
      >
        {(manifest?.components ?? []).map((c: ComponentEntry) => (
          <div key={c.name} className="px-3 py-1.5">
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
                the project's tokens — not a mock rendering. */}
            {sandboxToken ? (
              <div className="mt-1 overflow-hidden rounded border bg-zinc-50">
                <iframe
                  src={`${sandboxUrl(sandboxToken, `/preview/${c.name}`)}?preview=1`}
                  title={`Preview of ${c.name}`}
                  sandbox="allow-scripts allow-same-origin"
                  className="h-14 w-[452px] origin-top-left scale-50 border-0"
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
      </PanelSection>

      <PanelSection
        icon={<PaletteIcon className="size-3.5" />}
        title={`Tokens${manifest ? ` (${manifest.tokens.reduce((n, g) => n + g.variables.length, 0)})` : ""}`}
        open={section === "tokens"}
        onToggle={() => onSection("tokens")}
      >
        {/* Inline token editor (§6b): an edit is a design_write_tokens
            equivalent — same validator, every artboard reloads via SSE. */}
        {projectId ? (
          <TokenEditor projectId={projectId} onSaved={onFilesChanged} />
        ) : null}
      </PanelSection>
    </aside>
  )
}

function PanelSection({
  icon,
  title,
  open,
  onToggle,
  children,
}: {
  icon: React.ReactNode
  title: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border-b">
      <button
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        onClick={onToggle}
      >
        {icon}
        {title}
      </button>
      {open ? <div className="pb-2">{children}</div> : null}
    </div>
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
