/// Media (design: media.html, media-empty): every file shared in the
/// project's rooms and on its tasks, as a list or a grid, with type tabs and
/// search. A file opens the same preview chat uses.
///
/// #5907 item 5: both attachment tables page on the server (PAGE_SIZE at a
/// time) and merge newest first; see `mergeCutoff`. Search narrows by file
/// name on the server. The type tabs sort what's loaded, since the server
/// can't ask "not an image or a document". The design's "By" column has no
/// backend (attachment rows don't record who uploaded them), so it's left out.
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { FileIcon, ImagesIcon, LayoutGridIcon, ListIcon, RefreshCwIcon, SearchIcon } from "lucide-react"

import type { TaskflowMessageAttachment, TaskflowTaskAttachment } from "@/api/client"
import { AttachmentPreviewDialog } from "@/components/message-attachments"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { formatBytes, getAttachmentKind, getFileExtension } from "@/lib/attachment-kind"
import { messageRowToMediaItem, taskRowToMediaItem, type MediaItem } from "@/lib/media-items"
import { fetchMediaPage, type MediaSourceKind } from "@/lib/taskflow-api"

import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { countTabs, filterMedia, mergeCutoff, sortNewest, sourcesToLoad, withinCutoff, type MediaTab, type SourceState } from "./media-logic"

const PAGE_SIZE = 48
const VIEW_KEY = "v3.media.view"
type View = "list" | "grid"
type Row = TaskflowMessageAttachment | TaskflowTaskAttachment
type Source = { rows: Row[]; next: number | null; count: number }
type Feed = { key: string; chat: Source; task: Source; error: string | null }

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list"
  } catch {
    return "list"
  }
}

function sourceState(s: Source): SourceState {
  const last = s.rows[s.rows.length - 1]
  return { oldest: last?.created_at ?? null, hasMore: s.next != null }
}

const TABS: { id: MediaTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "images", label: "Images" },
  { id: "documents", label: "Documents" },
  { id: "other", label: "Other" },
]

function Thumb({ item }: { item: MediaItem }) {
  if (getAttachmentKind(item.contentType, item.name) === "image") {
    return <img src={item.url} alt="" loading="lazy" className="size-9 shrink-0 rounded-md border object-cover" />
  }
  return (
    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
      <FileIcon className="size-4" />
    </span>
  )
}

function GridCard({ item, now, onOpen }: { item: MediaItem; now: number; onOpen: () => void }) {
  const image = getAttachmentKind(item.contentType, item.name) === "image"
  const ext = getFileExtension(item.name)
  return (
    <div className="group flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
      <button type="button" onClick={onOpen} className="relative aspect-[4/3] w-full overflow-hidden bg-muted" aria-label={`Open ${item.name}`}>
        {image ? (
          <img src={item.url} alt="" loading="lazy" className="size-full object-cover transition-transform group-hover:scale-[1.02]" />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <FileIcon className="size-8" />
            {ext ? <span className="font-mono text-xs uppercase">{ext}</span> : null}
          </span>
        )}
      </button>
      <div className="grid gap-0.5 p-3">
        <button type="button" onClick={onOpen} className="truncate text-left text-sm font-medium hover:underline">
          {item.name}
        </button>
        <Link to={item.source.href} className="truncate text-xs text-muted-foreground hover:text-foreground hover:underline">
          {item.source.label}
        </Link>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatBytes(item.sizeBytes)} · {timeAgo(item.createdAt, now) ?? "—"}
        </span>
      </div>
    </div>
  )
}

export function MediaPage() {
  const { live, projectTasks } = useWorkspace()
  const now = useLivenessNow()
  const projectId = live?.project.id ?? null
  const [tab, setTab] = useState<MediaTab>("all")
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState("")
  const [view, setView] = useState<View>(readView)
  const [open, setOpen] = useState<number | null>(null)
  const [feed, setFeed] = useState<Feed | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  // Search the server a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const key = projectId == null ? null : `${projectId}|${search}|${reloadTick}`
  useEffect(() => {
    if (projectId == null || key == null) return
    let alive = true
    const opts = { pageSize: PAGE_SIZE, name: search || undefined }
    Promise.all([fetchMediaPage(projectId, "chat", 1, opts), fetchMediaPage(projectId, "task", 1, opts)])
      .then(([chat, task]) => alive && setFeed({ key, chat, task, error: null }))
      .catch((e: unknown) => {
        const empty = { rows: [], next: null, count: 0 }
        if (alive) setFeed({ key, chat: empty, task: empty, error: e instanceof Error ? e.message : "Couldn't load the files." })
      })
    return () => {
      alive = false
    }
  }, [projectId, search, key])

  const current = feed?.key === key ? feed : null
  const loading = current == null

  const channelTitles = useMemo(() => new Map((live?.agentChannels ?? []).map((c) => [c.id, c.title])), [live?.agentChannels])
  const taskTitles = useMemo(() => new Map(projectTasks.map((t) => [t.id, t.title])), [projectTasks])

  const items = useMemo(() => {
    if (!current || current.error) return null
    const chat = (current.chat.rows as TaskflowMessageAttachment[]).map((row) => {
      const title = row.channel != null ? channelTitles.get(row.channel) : null
      return messageRowToMediaItem(row, title ? title : row.channel != null ? `Room ${row.channel}` : "Chat", row.channel != null ? `/v3/chat/channel-${row.channel}` : "/v3/chat")
    })
    const task = (current.task.rows as TaskflowTaskAttachment[]).map((row) => {
      const title = taskTitles.get(String(row.task))
      return taskRowToMediaItem(row, title ? `#${row.task} ${title}` : `#${row.task}`, `/v3/tasks/${row.task}`)
    })
    const cutoff = mergeCutoff([sourceState(current.chat), sourceState(current.task)])
    return withinCutoff(sortNewest([...chat, ...task]), cutoff)
  }, [current, channelTitles, taskTitles])

  const total = current ? current.chat.count + current.task.count : 0
  const hasMore = !!current && (current.chat.next != null || current.task.next != null)
  const counts = useMemo(() => countTabs(items ?? []), [items])
  const visible = useMemo(() => filterMedia(items ?? [], tab, ""), [items, tab])
  // Close the preview if what it points at is filtered away.
  const activeIndex = open != null && open < visible.length ? open : null

  function chooseView(v: View) {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // Private window: the choice lasts this visit only.
    }
  }

  async function loadMore() {
    if (!current || projectId == null || loadingMore) return
    const want = sourcesToLoad<MediaSourceKind>({ chat: sourceState(current.chat), task: sourceState(current.task) })
    if (!want.length) return
    setLoadingMore(true)
    try {
      const opts = { pageSize: PAGE_SIZE, name: search || undefined }
      const pages = await Promise.all(want.map((k) => fetchMediaPage(projectId, k, current[k].next!, opts).then((p) => [k, p] as const)))
      setFeed((f) => {
        if (!f || f.key !== current.key) return f
        const next = { ...f }
        for (const [k, p] of pages) next[k] = { rows: [...f[k].rows, ...p.rows], next: p.next, count: p.count }
        return next
      })
    } catch {
      // The button stays, so trying again is one click.
    } finally {
      setLoadingMore(false)
    }
  }

  const searching = search !== ""
  const nothingAtAll = !!items && !items.length && !hasMore && !searching

  return (
    <V3Shell
      title="Media"
      actions={
        <Button size="sm" variant="outline" onClick={() => setReloadTick((n) => n + 1)} disabled={loading}>
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
          Refresh
        </Button>
      }
    >
      <div className="mx-auto grid max-w-6xl gap-4">
        <p className="text-sm text-muted-foreground">
          Files shared in rooms and on tasks. Up to 25 MB each.
          {current && !current.error && total ? ` ${total} ${total === 1 ? "file" : "files"}${searching ? " match" : ""}.` : ""}
        </p>

        {current?.error ? (
          <div className="rounded-xl border p-6 text-sm">
            <p className="text-destructive">{current.error}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setReloadTick((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : nothingAtAll ? (
          <Empty className="rounded-xl border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ImagesIcon />
              </EmptyMedia>
              <EmptyTitle>No files yet</EmptyTitle>
              <EmptyDescription>
                Files people and agents attach in <Link to="/v3/chat">chat</Link> or on a task land here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Tabs value={tab} onValueChange={(v) => setTab(v as MediaTab)}>
                <TabsList>
                  {TABS.map((t) => (
                    <TabsTrigger key={t.id} value={t.id}>
                      {t.label} {items ? <span className="text-muted-foreground">{counts[t.id]}{hasMore ? "+" : ""}</span> : null}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
                <InputGroup className="flex-1 sm:w-64">
                  <InputGroupAddon>
                    <SearchIcon />
                  </InputGroupAddon>
                  <InputGroupInput placeholder="Search file names" aria-label="Search file names" value={query} onChange={(e) => setQuery(e.target.value)} />
                </InputGroup>
                <ToggleGroup value={[view]} onValueChange={(v: string[]) => v[0] && chooseView(v[0] as View)} variant="outline" size="sm" aria-label="View">
                  <ToggleGroupItem value="list" aria-label="List view">
                    <ListIcon />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="grid" aria-label="Grid view">
                    <LayoutGridIcon />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>

            {!items ? (
              view === "grid" ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="aspect-[4/3] w-full rounded-xl" />
                  ))}
                </div>
              ) : (
                <div className="grid gap-2">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className="h-12 w-full rounded-lg" />
                  ))}
                </div>
              )
            ) : visible.length ? (
              view === "grid" ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {visible.map((it, i) => (
                    <GridCard key={`${it.source.kind}:${it.id}`} item={it} now={now} onOpen={() => setOpen(i)} />
                  ))}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>File</TableHead>
                        <TableHead className="hidden sm:table-cell">Shared in</TableHead>
                        <TableHead className="hidden text-right md:table-cell">Size</TableHead>
                        <TableHead className="text-right">Added</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visible.map((it, i) => (
                        <TableRow key={`${it.source.kind}:${it.id}`}>
                          <TableCell className="max-w-0 w-full">
                            <button type="button" className="flex w-full min-w-0 items-center gap-3 text-left" onClick={() => setOpen(i)}>
                              <Thumb item={it} />
                              <span className="min-w-0">
                                <span className="block truncate font-medium hover:underline">{it.name}</span>
                                <span className="block truncate text-xs text-muted-foreground sm:hidden">{it.source.label}</span>
                              </span>
                            </button>
                          </TableCell>
                          <TableCell className="hidden max-w-56 truncate sm:table-cell">
                            <Link to={it.source.href} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                              {it.source.label}
                            </Link>
                          </TableCell>
                          <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">{formatBytes(it.sizeBytes)}</TableCell>
                          <TableCell className="whitespace-nowrap text-right text-muted-foreground">{timeAgo(it.createdAt, now) ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )
            ) : (
              <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                {searching ? "No file names match." : hasMore ? "None of the files loaded so far are this type. Load more to look further back." : "No files of this type."}
              </p>
            )}

            {hasMore ? (
              <div className="flex justify-center">
                <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? <Spinner /> : null}
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      {activeIndex != null ? (
        <AttachmentPreviewDialog attachments={visible} activeIndex={activeIndex} open onIndexChange={setOpen} onOpenChange={(o) => !o && setOpen(null)} />
      ) : null}
    </V3Shell>
  )
}
