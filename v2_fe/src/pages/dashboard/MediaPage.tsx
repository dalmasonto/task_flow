import * as React from "react"
import {
  AlertCircleIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  ImageIcon,
  ImagesIcon,
  RefreshCwIcon,
} from "lucide-react"

import { AttachmentPreviewDialog } from "@/components/message-attachments"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, getAttachmentKind, getFileExtension, type AttachmentKind } from "@/lib/attachment-kind"
import {
  matchesMediaFilter,
  messageRowToMediaItem,
  taskRowToMediaItem,
  type MediaFilter,
  type MediaItem,
  type MediaSource,
} from "@/lib/media-items"
import { fetchProjectMedia } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

const FILTERS: { value: MediaFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "images", label: "Images" },
  { value: "files", label: "Files" },
  { value: "chat", label: "Chat" },
  { value: "tasks", label: "Tasks" },
]

/// Every chat + task attachment in the active project, in one filterable
/// gallery, opening the exact chat lightbox (`AttachmentPreviewDialog`) so a
/// click here behaves identically to clicking the same file inline in a
/// message thread.
export function MediaPage({
  projectId,
  channelName,
  onOpenTask,
  onOpenChannel,
}: {
  projectId: number | null
  channelName: (id: number | null) => string
  onOpenTask: (taskId: number) => void
  onOpenChannel: (channelId: number | null) => void
}) {
  const [filter, setFilter] = React.useState<MediaFilter>("all")
  const [data, setData] = React.useState<MediaItem[] | null>(null)
  // The projectId `data` was fetched for. Used to derive `displayData` below so
  // a project switch can never render the previous project's attachments under
  // the new header — same stale-guard as OverviewPage.
  const [dataProjectId, setDataProjectId] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Bumped by "Try again" to re-run the fetch effect without touching `filter`.
  const [retryToken, setRetryToken] = React.useState(0)
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null)

  React.useEffect(() => {
    // Nothing to fetch, and the "no project" branch below never reads
    // data/error/loading — bail without touching state.
    if (projectId == null) return
    let active = true
    // Every setState call lives inside the async body, not the effect's
    // synchronous top level — same shape as OverviewPage's load effect.
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const { chat, task } = await fetchProjectMedia(projectId)
        if (!active) return
        const chatItems = chat.map((row) =>
          messageRowToMediaItem(row, channelName(row.channel), "/dashboard/agents")
        )
        const taskItems = task.map((row) => taskRowToMediaItem(row, `task #${row.task}`, "/dashboard/board"))
        const merged = [...chatItems, ...taskItems].sort((a, b) => {
          const at = a.createdAt ? Date.parse(a.createdAt) : 0
          const bt = b.createdAt ? Date.parse(b.createdAt) : 0
          return bt - at
        })
        setData(merged)
        setDataProjectId(projectId)
      } catch (err) {
        if (!active) return
        setError(err instanceof Error ? err.message : "Could not load media.")
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [projectId, retryToken, channelName])

  if (projectId == null) {
    return (
      <section className="grid place-items-center p-4 sm:p-8">
        <div className="w-full max-w-xl rounded-xl border bg-card p-8 text-center shadow-sm">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
            <ImagesIcon className="size-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold">No project selected</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            Select a project to browse the images and files shared across its chat and tasks.
          </p>
        </div>
      </section>
    )
  }

  // Only trust `data` when it was fetched for the project currently on screen
  // — otherwise a project switch would briefly render the previous project's
  // attachments under the new header.
  const displayData = data && dataProjectId === projectId ? data : null
  const visible = displayData ? displayData.filter((item) => matchesMediaFilter(item, filter)) : []

  return (
    <section className="grid gap-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 shadow-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Gallery</p>
          <h1 className="mt-1 text-2xl font-semibold">Media</h1>
        </div>
        <div
          className="flex flex-wrap items-center gap-1 rounded-full border bg-background p-1"
          role="group"
          aria-label="Filter media"
        >
          {FILTERS.map((option) => {
            const count = displayData
              ? displayData.filter((item) => matchesMediaFilter(item, option.value)).length
              : 0
            const active = filter === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(option.value)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {option.label}
                <span
                  className={cn(
                    "ml-1 tabular-nums",
                    active ? "text-primary-foreground/80" : "text-muted-foreground/70"
                  )}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/40 p-8 text-center">
          <AlertCircleIcon className="size-6 text-destructive" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={() => setRetryToken((n) => n + 1)}>
            <RefreshCwIcon />
            Try again
          </Button>
        </div>
      ) : loading && !displayData ? (
        <MediaSkeleton />
      ) : displayData && displayData.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-muted/40 p-10 text-center">
          <ImagesIcon className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No media in this project yet.</p>
        </div>
      ) : displayData && visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-muted/40 p-10 text-center">
          <ImagesIcon className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No items match this filter.</p>
        </div>
      ) : displayData ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
          {visible.map((item, index) => (
            <MediaTile
              key={`${item.source.kind}-${item.id}`}
              item={item}
              onOpen={() => setActiveIndex(index)}
              onOpenTask={onOpenTask}
              onOpenChannel={onOpenChannel}
            />
          ))}
        </div>
      ) : null}

      <AttachmentPreviewDialog
        attachments={visible}
        activeIndex={activeIndex ?? 0}
        open={activeIndex !== null}
        onIndexChange={setActiveIndex}
        onOpenChange={(open) => {
          if (!open) setActiveIndex(null)
        }}
      />
    </section>
  )
}

function MediaTile({
  item,
  onOpen,
  onOpenTask,
  onOpenChannel,
}: {
  item: MediaItem
  onOpen: () => void
  onOpenTask: (taskId: number) => void
  onOpenChannel: (channelId: number | null) => void
}) {
  const kind = getAttachmentKind(item.contentType, item.name)
  // A single broken/missing file falls back to the file-card layout rather
  // than blanking the tile or the whole grid.
  const [imageFailed, setImageFailed] = React.useState(false)
  const showImage = kind === "image" && !imageFailed

  return (
    <div className="group relative overflow-hidden rounded-lg border bg-background shadow-sm">
      <button
        type="button"
        onClick={onOpen}
        className="block aspect-square w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {showImage ? (
          <img
            src={item.url}
            alt={item.name}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <FileTile item={item} kind={kind} />
        )}
      </button>
      <SourceChip source={item.source} onOpenTask={onOpenTask} onOpenChannel={onOpenChannel} />
    </div>
  )
}

function FileTile({ item, kind }: { item: MediaItem; kind: AttachmentKind }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/40 p-3 text-center">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
        <KindIcon kind={kind} />
      </span>
      <span className="line-clamp-2 w-full break-words text-xs font-medium">{item.name}</span>
      <span className="text-[11px] text-muted-foreground">
        {getFileExtension(item.name).toUpperCase() || "FILE"}
        {item.sizeBytes ? ` · ${formatBytes(item.sizeBytes)}` : ""}
      </span>
    </div>
  )
}

/// Small overlay pill naming the item's source channel/task. Clicking it (not
/// the tile body) deep-links there instead of opening the lightbox.
function SourceChip({
  source,
  onOpenTask,
  onOpenChannel,
}: {
  source: MediaSource
  onOpenTask: (taskId: number) => void
  onOpenChannel: (channelId: number | null) => void
}) {
  return (
    <button
      type="button"
      title={source.label}
      onClick={(event) => {
        event.stopPropagation()
        if (source.kind === "task") onOpenTask(source.taskId)
        else onOpenChannel(source.channelId)
      }}
      className="absolute inset-x-1.5 bottom-1.5 truncate rounded-md bg-background/90 px-1.5 py-0.5 text-left text-[10px] font-medium text-foreground shadow-sm ring-1 ring-border/70 backdrop-blur-sm transition hover:bg-background"
    >
      {source.label}
    </button>
  )
}

function KindIcon({ kind }: { kind: AttachmentKind }) {
  const className = "size-4"
  if (kind === "image") return <ImageIcon className={className} />
  if (kind === "pdf") return <FileTextIcon className={className} />
  if (kind === "spreadsheet") return <FileSpreadsheetIcon className={className} />
  if (kind === "video") return <FileVideoIcon className={className} />
  if (kind === "audio") return <FileAudioIcon className={className} />
  if (kind === "code") return <FileCodeIcon className={className} />
  if (kind === "markdown" || kind === "text") return <FileTextIcon className={className} />
  return <FileIcon className={className} />
}

function MediaSkeleton() {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
      {Array.from({ length: 12 }).map((_, index) => (
        <Skeleton key={index} className="aspect-square w-full rounded-lg" />
      ))}
    </div>
  )
}
