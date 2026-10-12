import * as React from "react"
import {
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  ImageIcon,
  Loader2Icon,
  LocateIcon,
} from "lucide-react"

import { AttachmentPreviewDialog, type MessageAttachmentItem } from "@/components/message-attachments"
import { Button } from "@/components/ui/button"
import { formatBytes, getAttachmentKind, type AttachmentKind } from "@/lib/attachment-kind"
import {
  channelFileFromRow,
  chatFilesFromMessages,
  groupChatFiles,
  mergeChatFiles,
  type ChatFile,
  type ChatFileGroupMode,
} from "@/lib/chat-files"
import { fetchChannelAttachments } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"
import type { AgentMessage } from "@/lib/workspace-view"

/// #660: a conversation's files, newest first, with "Load more" walking back
/// through the channel's history a page at a time.
///
/// ONE component for all three chat surfaces: it lives inside
/// `AgentsConversationView`, so the Agents page, the design rail and the dock
/// cannot drift. Page 1 is fetched when the tab is FIRST opened (the surface
/// mounts it lazily), never on chat mount — the app deliberately keeps the
/// core load minimal.
///
/// Realtime needs no new source: the thread already receives attachment rows
/// over the app's single SSE stream and merges them into the messages' own
/// `attachments`, so files that arrive while the tab is open are derived from
/// the `messages` prop and prepended. Dedupe by attachment id makes the two
/// sources (endpoint pages and the thread) safe to combine in either order.
export function ChatFilesTab({
  channelId,
  messages,
  currentUserId,
  dense = false,
  onJumpToMessage,
}: {
  channelId: number
  messages: AgentMessage[]
  currentUserId?: number | null
  dense?: boolean
  /// Reveal a message in the thread and flash it. Returns false when the
  /// message is older than everything loaded — the tab then says so rather
  /// than silently doing nothing.
  onJumpToMessage: (messageId: number) => boolean
}) {
  const [pages, setPages] = React.useState<ChatFile[]>([])
  const [nextCursor, setNextCursor] = React.useState<number | null>(null)
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
  const [error, setError] = React.useState<string | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [mode, setMode] = React.useState<ChatFileGroupMode>("date")
  const [previewIndex, setPreviewIndex] = React.useState<number | null>(null)
  /// The message a jump could not reach, with what to do about it.
  const [unreachable, setUnreachable] = React.useState<number | null>(null)
  /// Bumped by Retry — the effect below refetches page 1 for it.
  const [reloads, setReloads] = React.useState(0)

  // Page 1, on first open. The caller keys this component by conversation, so
  // a chat switch remounts and refetches — no state has to be reset by hand.
  React.useEffect(() => {
    let cancelled = false
    void fetchChannelAttachments(channelId)
      .then(({ rows, nextCursor }) => {
        if (cancelled) return
        setPages(rows.map(channelFileFromRow))
        setNextCursor(nextCursor)
        setStatus("ready")
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : "Could not load this conversation's files.")
        setStatus("error")
      })
    return () => {
      cancelled = true
    }
  }, [channelId, reloads])

  // Realtime needs no state of its own: files that arrive while the tab is
  // open are already in the thread's messages (the app's ONE SSE stream put
  // them there), so the list is DERIVED from the two sources on every render.
  // Dedupe by attachment id makes the order they were seen in irrelevant.
  const files = React.useMemo(
    () => mergeChatFiles(pages, chatFilesFromMessages(messages, { currentUserId })),
    [pages, messages, currentUserId]
  )

  const loadMore = async () => {
    if (nextCursor == null || loadingMore) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await fetchChannelAttachments(channelId, nextCursor)
      setPages((current) => mergeChatFiles(current, page.rows.map(channelFileFromRow)))
      setNextCursor(page.nextCursor)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not load more files.")
    } finally {
      setLoadingMore(false)
    }
  }

  const jump = (file: ChatFile) => {
    if (onJumpToMessage(file.messageId)) {
      setUnreachable(null)
    } else {
      setUnreachable(file.messageId)
    }
  }

  const groups = React.useMemo(() => groupChatFiles(files, mode), [files, mode])
  // The preview pages across the WHOLE loaded list, in the order the tab shows
  // it, so paging inside the preview matches paging in the tab.
  const previewItems: MessageAttachmentItem[] = React.useMemo(
    () =>
      files.map((file) => ({
        id: String(file.id),
        name: file.name,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        url: file.url,
      })),
    [files]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex shrink-0 items-center justify-between gap-2 px-4", dense ? "py-2" : "py-3")}>
        <p className="text-xs text-muted-foreground">
          {status === "ready" ? (files.length === 1 ? "1 file" : `${files.length} file${files.length === 1 ? "" : "s"}`) : "Files"}
          {nextCursor != null ? "+" : ""}
        </p>
        <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Group files">
          {(
            [
              ["date", "By date"],
              ["sender", "By sender"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                mode === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {status === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading files…
          </div>
        ) : status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-xs text-muted-foreground">{error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setStatus("loading")
                setError(null)
                setReloads((count) => count + 1)
              }}
            >
              Retry
            </Button>
          </div>
        ) : files.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm font-medium text-muted-foreground">No files here yet</p>
            <p className="text-xs text-muted-foreground/70">Anything shared in this conversation shows up here.</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {groups.map((group) => (
              <div key={group.key} className="grid gap-1">
                <div className="sticky top-0 z-10 -mx-3 bg-gradient-to-b from-background via-background/90 to-transparent px-3 py-1">
                  <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    {group.label}
                  </span>
                </div>
                {group.files.map((file) => {
                  const index = files.indexOf(file)
                  return (
                    <div key={file.id} className="grid gap-0.5">
                      <div
                        className={cn(
                          "group flex items-center gap-2 rounded-lg px-2 hover:bg-accent/60",
                          dense ? "py-1" : "py-1.5"
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setPreviewIndex(index)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          aria-label={`Preview ${file.name}`}
                        >
                          <FileKindIcon contentType={file.contentType} name={file.name} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{file.name}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {mode === "sender" ? `${formatFileDay(file.createdAt)} · ` : ""}
                              {mode === "date" ? `${file.senderName} · ` : ""}
                              {formatFileTime(file.createdAt)} · {formatBytes(file.sizeBytes)}
                            </span>
                          </span>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label={`Jump to the message that shared ${file.name}`}
                          title="Jump to message"
                          onClick={() => jump(file)}
                        >
                          <LocateIcon />
                        </Button>
                      </div>
                      {unreachable === file.messageId ? (
                        <p className="px-2 pb-1 text-[11px] text-muted-foreground">
                          That message is older than this thread has loaded — scroll up in Messages to fetch it.
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ))}

            {nextCursor != null ? (
              <div className="flex justify-center pt-1">
                <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? <Loader2Icon className="animate-spin" /> : null}
                  Load more
                </Button>
              </div>
            ) : (
              <p className="pt-1 text-center text-[11px] text-muted-foreground/60">That's everything.</p>
            )}
            {status === "ready" && error ? (
              <p className="text-center text-[11px] text-destructive">{error}</p>
            ) : null}
          </div>
        )}
      </div>

      <AttachmentPreviewDialog
        attachments={previewItems}
        activeIndex={previewIndex ?? 0}
        open={previewIndex !== null}
        onIndexChange={setPreviewIndex}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null)
        }}
      />
    </div>
  )
}

function FileKindIcon({ contentType, name }: { contentType: string; name: string }) {
  const kind: AttachmentKind = getAttachmentKind(contentType, name)
  const className = "size-4 shrink-0 text-muted-foreground"
  switch (kind) {
    case "image":
      return <ImageIcon className={className} />
    case "pdf":
    case "markdown":
    case "text":
      return <FileTextIcon className={className} />
    case "spreadsheet":
      return <FileSpreadsheetIcon className={className} />
    case "video":
      return <FileVideoIcon className={className} />
    case "audio":
      return <FileAudioIcon className={className} />
    case "code":
      return <FileCodeIcon className={className} />
    default:
      return <FileIcon className={className} />
  }
}

/// Local time of day — the group heading above already carries the date.
function formatFileTime(value: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/// Used in sender grouping, where the date is not in the heading.
function formatFileDay(value: string | null): string {
  if (!value) return "Today"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Today"
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) return "Today"
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
