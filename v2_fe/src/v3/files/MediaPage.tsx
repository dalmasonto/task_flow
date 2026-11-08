/// Media (design: media.html, media-empty): every file shared in the
/// project's rooms and on its tasks, in one table with type tabs and search.
/// A row opens the same preview chat uses.
///
/// Attachments aren't a live slice, so this reads them once per project (the
/// newest page of each table, as v2 does) and offers Refresh. The design's
/// "By" column has no backend: attachment rows don't record who uploaded
/// them, so it's left out rather than guessed.
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { FileIcon, ImagesIcon, RefreshCwIcon, SearchIcon } from "lucide-react"

import { AttachmentPreviewDialog } from "@/components/message-attachments"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { formatBytes, getAttachmentKind } from "@/lib/attachment-kind"
import { messageRowToMediaItem, taskRowToMediaItem, type MediaItem } from "@/lib/media-items"
import { fetchProjectMedia } from "@/lib/taskflow-api"

import { useLoad } from "../lib/use-load"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { countTabs, filterMedia, sortNewest, type MediaTab } from "./media-logic"

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

export function MediaPage() {
  const { live, projectTasks } = useWorkspace()
  const now = useLivenessNow()
  const projectId = live?.project.id ?? null
  const media = useLoad(projectId == null ? null : `media:${projectId}`, () => fetchProjectMedia(projectId!))
  const [tab, setTab] = useState<MediaTab>("all")
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState<number | null>(null)

  const channelTitles = useMemo(() => new Map((live?.agentChannels ?? []).map((c) => [c.id, c.title])), [live?.agentChannels])
  const taskTitles = useMemo(() => new Map(projectTasks.map((t) => [t.id, t.title])), [projectTasks])

  const items = useMemo(() => {
    if (!media.data) return null
    const chat = media.data.chat.map((row) => {
      const title = row.channel != null ? channelTitles.get(row.channel) : null
      return messageRowToMediaItem(row, title ? title : row.channel != null ? `Room ${row.channel}` : "Chat", row.channel != null ? `/v3/chat/channel-${row.channel}` : "/v3/chat")
    })
    const task = media.data.task.map((row) => {
      const title = taskTitles.get(String(row.task))
      return taskRowToMediaItem(row, title ? `#${row.task} ${title}` : `#${row.task}`, `/v3/tasks/${row.task}`)
    })
    return sortNewest([...chat, ...task])
  }, [media.data, channelTitles, taskTitles])

  const counts = useMemo(() => countTabs(items ?? []), [items])
  const visible = useMemo(() => filterMedia(items ?? [], tab, query), [items, tab, query])
  // Close the preview if what it points at is filtered away.
  const activeIndex = open != null && open < visible.length ? open : null

  return (
    <V3Shell
      title="Media"
      actions={
        <Button size="sm" variant="outline" onClick={media.reload} disabled={media.loading}>
          <RefreshCwIcon className={media.loading ? "animate-spin" : undefined} />
          Refresh
        </Button>
      }
    >
      <div className="mx-auto grid max-w-5xl gap-4">
        <p className="text-sm text-muted-foreground">Files shared in rooms and on tasks. Up to 25 MB each.</p>

        {media.error && !items ? (
          <div className="rounded-xl border p-6 text-sm">
            <p className="text-destructive">{media.error}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={media.reload}>
              Try again
            </Button>
          </div>
        ) : !items ? (
          <div className="grid gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : !items.length ? (
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
                      {t.label} <span className="text-muted-foreground">{counts[t.id]}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <InputGroup className="ml-auto w-full sm:w-64">
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput placeholder="Search files" aria-label="Search files" value={query} onChange={(e) => setQuery(e.target.value)} />
              </InputGroup>
            </div>

            {visible.length ? (
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
            ) : (
              <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No files match.</p>
            )}
          </>
        )}
      </div>
      {activeIndex != null ? (
        <AttachmentPreviewDialog attachments={visible} activeIndex={activeIndex} open onIndexChange={setOpen} onOpenChange={(o) => !o && setOpen(null)} />
      ) : null}
    </V3Shell>
  )
}
