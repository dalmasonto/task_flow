import { MessageAttachments } from "@/components/message-attachments"
import { Button } from "@/components/ui/button"
import { CheckCheckIcon, CheckIcon, CopyIcon, FileIcon, ImageIcon, PencilIcon, RotateCcwIcon, XIcon } from "lucide-react"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/attachment-kind"
import { formatMessageTime } from "@/lib/live-mappers"
import { messagePriorityOptions, type AgentMessage, type MessagePriority, type StagedFile } from "@/lib/workspace-view"
import { useEffect, useRef, useState, type ReactNode } from "react"


function messagePriorityLabel(priority: MessagePriority) {
  return messagePriorityOptions.find((option) => option.value === priority)?.label ?? "Normal"
}


function messagePriorityBadgeClass(priority: MessagePriority) {
  if (priority === "blocking") {
    return "bg-rose-100 text-rose-800 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900/60"
  }

  if (priority === "needs-response") {
    return "bg-amber-100 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60"
  }

  return "bg-muted text-muted-foreground ring-border"
}




/// Removable chips/thumbnails for files staged in the composer before send.
/// Images preview from their local object URL; other files show an icon + size.
export function StagedFileList({
  files,
  onRemove,
  onReference,
}: {
  files: StagedFile[]
  onRemove: (id: string) => void
  /** Drop [filename] at the composer caret so a message can point at this file. */
  onReference?: (staged: StagedFile) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((staged) => {
        const isImage = staged.file.type.startsWith("image/")
        return (
          <div
            key={staged.id}
            className="flex items-center gap-2 rounded-lg border bg-background/90 py-1 pl-1 pr-1.5"
          >
            {/* The icon + name is the reference trigger; the X (below) removes.
                Clicking here inserts [name] at the composer caret. mousedown is
                prevented so the textarea keeps its selection instead of blurring
                to this button first. */}
            <button
              type="button"
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md text-left",
                onReference && "cursor-pointer hover:opacity-80",
              )}
              disabled={!onReference}
              title={onReference ? "Insert reference into the message" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onReference?.(staged)}
            >
              {isImage && staged.previewUrl ? (
                <img
                  src={staged.previewUrl}
                  alt={staged.file.name}
                  className="size-9 shrink-0 rounded-md object-cover"
                />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
                  {isImage ? <ImageIcon className="size-4" /> : <FileIcon className="size-4" />}
                </span>
              )}
              <div className="min-w-0">
                <p className="max-w-[10rem] truncate text-xs font-medium">{staged.file.name}</p>
                <p className="text-[0.7rem] text-muted-foreground">{formatBytes(staged.file.size)}</p>
              </div>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${staged.file.name}`}
              onClick={() => onRemove(staged.id)}
            >
              <XIcon />
            </Button>
          </div>
        )
      })}
    </div>
  )
}


/// #107: one icon-sized bubble action with transient "done" feedback. `run`
/// does the work (usually a clipboard write); the icon flips to a check for a
/// moment so the click visibly landed.
export function BubbleAction({
  title,
  icon,
  run,
}: {
  title: string
  icon: ReactNode
  run: () => void | Promise<void>
}) {
  const [done, setDone] = useState(false)
  const resetTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
  }, [])
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className="cursor-pointer rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      onClick={async () => {
        try {
          await run()
          setDone(true)
          if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
          resetTimer.current = window.setTimeout(() => setDone(false), 1400)
        } catch {
          // A clipboard denial has no better surface than staying quiet.
        }
      }}
    >
      {done ? <CheckIcon className="size-3.5 text-emerald-600" /> : icon}
    </button>
  )
}


export function AgentChatBubble({
  message,
  onRetry,
  onCancel,
  onCreateTask,
  onEdit,
}: {
  message: AgentMessage
  onRetry?: (nonce: string) => void
  onCancel?: (nonce: string) => void
  onCreateTask?: (body: string) => void
  onEdit?: (messageId: number, body: string) => Promise<void>
}) {
  const fromUser = message.from === "user"
  const alignRight = fromUser
  // #107: the rendered-markdown container, so "Copy" can take the text AS
  // DISPLAYED (headings without #, list bullets, link text) rather than
  // re-deriving plain text from markdown a second way.
  const renderedRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.body)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const canEdit = Boolean(onEdit && message.canEdit && message.status === "posted")
  const saveEdit = async () => {
    const body = draft.trim()
    if (!body || body === message.body || saving) {
      if (body === message.body || !body) setEditing(false)
      return
    }
    setSaving(true)
    setEditError(null)
    try {
      await onEdit!(Number(message.id), body)
      setEditing(false)
    } catch (error) {
      // Keep the editor open with the draft intact — closing would throw the
      // user's revision away on a transient failure.
      setEditError(error instanceof Error ? error.message : "Could not edit the message.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <article className={cn("flex", alignRight ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] rounded-lg border p-3 shadow-sm sm:max-w-[82%]",
          fromUser ? "agent-sent-bubble" : alignRight ? "bg-accent/75" : "bg-background/95"
        )}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold">{fromUser ? "You" : message.from}</span>
          <span className={cn("text-muted-foreground", message.status === "failed" && "text-rose-600 dark:text-rose-300")}>
            {message.time}
          </span>
          {message.editedAt ? (
            <span
              className="text-[0.65rem] italic text-muted-foreground/80"
              title={`Edited ${formatMessageTime(message.editedAt, "just now")}`}
            >
              (edited)
            </span>
          ) : null}
          {message.priority && message.priority !== "normal" ? (
            <span className={cn("rounded-full px-2 py-0.5 font-medium ring-1", messagePriorityBadgeClass(message.priority))}>
              {messagePriorityLabel(message.priority)}
            </span>
          ) : null}
          {/* Capture a spoken commitment as a task without leaving the thread —
              the whole point is that it costs one click, not a form. Hidden for
              a message still in flight: there is nothing durable to capture yet. */}
          {/* `!message.status` was always false: a SAVED message carries
              status "posted", only in-flight ones are "sending"/"failed". Test
              the states that actually mean "not durable yet". */}
          {message.body.trim() && message.status !== "sending" && message.status !== "failed" ? (
            <span className="ml-auto flex items-center gap-0.5">
              {/* #107: copy AS RENDERED (what selecting the bubble would give)
                  vs copy the raw markdown source — both one click. */}
              <BubbleAction
                title="Copy text"
                icon={<CopyIcon className="size-3.5" />}
                run={() =>
                  navigator.clipboard.writeText(renderedRef.current?.innerText ?? message.body)
                }
              />
              <BubbleAction
                title="Copy markdown"
                icon={<span className="block px-0.5 font-mono text-[9px] font-bold leading-[0.875rem]">MD</span>}
                run={() => navigator.clipboard.writeText(message.body)}
              />
              {canEdit && !editing ? (
                <BubbleAction
                  title="Edit message"
                  icon={<PencilIcon className="size-3.5" />}
                  run={() => {
                    setDraft(message.body)
                    setEditError(null)
                    setEditing(true)
                  }}
                />
              ) : null}
              {onCreateTask ? (
                <button
                  type="button"
                  className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  title="Create a task from this message — first line becomes the title"
                  onClick={() => onCreateTask(message.body)}
                >
                  + Task
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={Math.min(12, Math.max(3, draft.split("\n").length))}
              autoFocus
              className="w-full min-w-56 resize-y rounded-md border bg-background p-2 font-mono text-xs leading-5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              onKeyDown={(event) => {
                // Enter inserts newlines as usual — markdown is multi-line.
                // Cmd/Ctrl+Enter saves, Escape cancels.
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void saveEdit()
                if (event.key === "Escape") setEditing(false)
              }}
            />
            {editError ? <p className="text-xs text-rose-600 dark:text-rose-300">{editError}</p> : null}
            <div className="flex items-center gap-2">
              <Button type="button" size="xs" disabled={saving} onClick={() => void saveEdit()}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button type="button" variant="ghost" size="xs" disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <span className="text-[0.65rem] text-muted-foreground">Ctrl+Enter to save · Esc to cancel</span>
            </div>
          </div>
        ) : (
          <div ref={renderedRef}>
            <MarkdownRenderer
              content={message.body}
              compact
            />
          </div>
        )}
        {message.attachments?.length ? (
          <div className="mt-3">
            <MessageAttachments attachments={message.attachments} />
          </div>
        ) : null}
        {message.choices ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.choices.map((choice) => (
              <Button key={choice} variant="outline" size="xs" className="bg-background/85">
                {choice}
              </Button>
            ))}
          </div>
        ) : null}
        {message.status === "failed" && message.nonce ? (
          <div className="mt-3 flex flex-col gap-2 text-xs text-rose-700 dark:text-rose-300">
            {/* Show the server's reason (e.g. a too-large-file message) so the
                user knows what to fix, falling back to a generic line. */}
            <span>{message.error ?? "Message failed to send."}</span>
            <div className="flex flex-wrap items-center gap-2">
              {onRetry ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="bg-background/85"
                  onClick={() => onRetry(message.nonce!)}
                >
                  <RotateCcwIcon />
                  Retry
                </Button>
              ) : null}
              {onCancel ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onCancel(message.nonce!)}
                >
                  <XIcon />
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {fromUser && message.seen ? (
          <div className="mt-1.5 flex items-center justify-end gap-1 text-[0.65rem] font-medium text-muted-foreground">
            <CheckCheckIcon className="size-3" />
            Seen
          </div>
        ) : null}
      </div>
    </article>
  )
}
