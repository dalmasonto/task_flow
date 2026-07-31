import { ALL_TOOLS, activityTools, filterActivityEvents } from "@/lib/activity-filter"
import { ActivityIcon, SearchIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { PageShell } from "@/components/layout"
import { cn } from "@/lib/utils"
import { formatFullDate } from "@/lib/live-mappers"
import { type ActivityEvent } from "@/lib/workspace-view"
import { useMemo, useState } from "react"


/// One line in the feed. Deliberately dense: the old card gave three lines and a
/// row of chips to something like "tool:Read — completed", so a screen held five
/// entries. Everything beyond the headline moves into the detail sheet.
export function ActivityRow({
  event,
  onOpen,
}: {
  event: ActivityEvent
  onOpen: (event: ActivityEvent) => void
}) {
  return (
    <div className="relative flex gap-3">
      <span className="relative z-10 mt-1.5 flex size-2 shrink-0 items-center justify-center rounded-full bg-border ring-4 ring-background" />
      <button
        type="button"
        onClick={() => onOpen(event)}
        className="group -my-0.5 flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-muted/60"
      >
        {/* min-w-0 lets the action shrink+ellipsize instead of forcing the row
            wide (a long tool name has no spaces to break on). The detail wraps
            rather than truncating, so nothing pushes a horizontal scroll. */}
        <span className="min-w-0 shrink-0 max-w-[45%] truncate font-mono text-xs text-muted-foreground group-hover:text-foreground">
          {event.action.replace(/_/g, " ")}
        </span>
        <span className="min-w-0 flex-1 break-words text-sm">{event.detail}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{event.actor}</span>
        <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
          {event.time}
        </span>
      </button>
    </div>
  )
}


/// One leaf of a tool payload, flattened to a dotted path.
export type MetadataField = { path: string; value: string }


/// Flatten a tool payload into readable fields.
///
/// The payload is nested JSON, and printing it as JSON made the reader do the
/// parsing: the useful part of `{"input":{"command":"…"}}` is the command, and it
/// arrives wrapped in braces, quotes and escaped newlines. Flattening to
/// `input.command` + the raw value lets each value render as markdown — so a
/// multi-line shell command reads as a block, not as one escaped string.
///
/// Arrays keep their index in the path (`edits.0.old_string`) because position
/// is meaningful in a tool call.
function flattenMetadata(value: unknown, prefix = ""): MetadataField[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenMetadata(item, prefix ? `${prefix}.${index}` : String(index)))
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
      flattenMetadata(inner, prefix ? `${prefix}.${key}` : key)
    )
  }
  const text = String(value)
  return text.trim() ? [{ path: prefix, value: text }] : []
}


/// Render a value the way its shape asks for: anything multi-line or shell-ish
/// as a fenced block (so it keeps its line breaks and monospacing), everything
/// else as prose.
function metadataValueMarkdown(value: string): string {
  const multiline = value.includes("\n")
  return multiline ? ["```", value, "```"].join("\n") : value
}


/// The detail panel. Shaped like the board's task sheet — an inset card with its
/// own scroll region — rather than a flush-edge drawer, so the two detail views
/// in the app read as the same thing.
export function ActivityDetailSheet({
  event,
  onClose,
}: {
  event: ActivityEvent | null
  onClose: () => void
}) {
  const fields = useMemo<MetadataField[]>(() => {
    if (!event?.metadata) return []
    try {
      return flattenMetadata(JSON.parse(event.metadata))
    } catch {
      // Not JSON (or truncated by the producer) — show it whole rather than
      // dropping it.
      return [{ path: "metadata", value: event.metadata }]
    }
  }, [event])

  if (!event) return null

  return (
    <>
      <button
        type="button"
        aria-label="Close activity details"
        className="fixed inset-0 z-40 bg-foreground/10"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${event.action} details`}
        // Same width as the board task sheet: a tool payload has long command
        // lines, and a narrower panel wraps them into noise.
        className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-[1.35rem] border bg-card shadow-2xl sm:inset-auto sm:bottom-4 sm:right-4 sm:top-4 sm:w-[min(54rem,calc(100vw-2rem))] sm:border-x sm:border-b"
      >
        <header
          className="relative shrink-0 overflow-hidden px-5 pb-7 pt-5"
          style={{
            background:
              "radial-gradient(circle at 18% 0%, color-mix(in oklab, var(--primary) 30%, transparent), transparent 34%), linear-gradient(180deg, color-mix(in oklab, var(--primary) 16%, transparent), transparent 74%)",
          }}
        >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-[linear-gradient(180deg,transparent,var(--card))]" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                {event.taskLabel ?? "Project"}
              </p>
              <h2 className="mt-1 truncate font-mono text-lg font-semibold">{event.action}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {event.actor} · {event.timestamp ? formatFullDate(event.timestamp) : event.time}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close activity details">
              <XIcon />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          <div className="space-y-4">
            {event.detail ? (
              <section className="rounded-lg border bg-background p-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Summary
                </p>
                <MarkdownRenderer content={event.detail} />
              </section>
            ) : null}

            {fields.length ? (
              <section className="rounded-lg border bg-background p-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Metadata
                </p>
                <div className="space-y-4">
                  {fields.map((field) => (
                    <div key={field.path} className="min-w-0">
                      <p className="mb-1 font-mono text-xs text-muted-foreground">{field.path}</p>
                      <MarkdownRenderer
                        content={metadataValueMarkdown(field.value)}
                        className="min-w-0 text-sm [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </section>
    </>
  )
}


export function ActivityLogPage({
  title,
  events,
  page,
  totalPages,
  totalCount,
  tool,
  tools,
  loading = false,
  onPageChange,
  onToolChange,
}: {
  title: string
  /// ONE page of rows. The component holds no history of its own — paging away
  /// replaces these, which is the point of the rework.
  events: ActivityEvent[]
  page: number
  totalPages: number
  totalCount: number
  /// Applied SERVER-side, so it filters the whole feed rather than this page.
  tool: string
  /// The COMPLETE option list, from an endpoint the filter does not affect.
  /// Deriving it from `events` made the dropdown narrow to its own selection
  /// and change contents page to page.
  tools: string[]
  loading?: boolean
  onPageChange: (page: number) => void
  onToolChange: (tool: string) => void
}) {
  const [selected, setSelected] = useState<ActivityEvent | null>(null)
  const [search, setSearch] = useState("")

  // `tools` is the complete list from the server and does not change with the
  // page. The fallback matters: if that request fails the list arrives empty,
  // and rendering nothing would remove the filter altogether — including the
  // way back to "All tools". Deriving from the page is worse than the endpoint
  // but far better than no filter at all.
  const options = tools.length ? tools : activityTools(events)

  // Search only — the TOOL filter was applied server-side across the whole feed.
  // Re-applying it here would be a no-op at best and could hide rows the server
  // already vouched for.
  const filtered = useMemo(() => filterActivityEvents(events, { search, tool: ALL_TOOLS }), [events, search])

  // New events arrive at the TOP (the feed is ordered newest-first and realtime
  // now carries the whole row inline, so a live event prepends without a fetch).
  // Growing the window with them keeps everything already on screen in place.
  const shown = filtered

  return (
    <PageShell
      eyebrow="Project log"
      title={title}
      description="A replayable record of task movement, agent work, human decisions, and project context."
    >
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b pb-3">
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Activity Feed</h2>
          </div>
          <span className="text-xs text-muted-foreground">
            {shown.length} of {filtered.length}
            {/* #38: a trailing "+" while older windows are still being pulled in,
                so the count doesn't read as a hard 1000-row cap. */}
            {loading ? " · loading…" : ""}
            {filtered.length !== events.length ? ` · ${events.length} total` : ""}
          </span>
        </div>

        {/* Filter + search: by tool (the action name) and free text over the
            visible fields — critical for analysing what each tool does. */}
        <div className="mt-3 space-y-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tools, actors, messages…"
              className="pl-8"
            />
          </div>
          {options.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {[ALL_TOOLS, ...options].map((option) => {
                const active = tool === option
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onToolChange(option)}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition",
                      active
                        ? "bg-primary/10 text-primary ring-primary/30"
                        : "bg-muted/60 text-muted-foreground ring-border hover:bg-muted"
                    )}
                  >
                    {option === ALL_TOOLS ? "All tools" : option}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>

        {events.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed bg-muted/40 p-8 text-center text-sm text-muted-foreground">
            No activity yet. Task moves, agent work, and review decisions will show up here.
          </div>
        ) : filtered.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed bg-muted/40 p-8 text-center text-sm text-muted-foreground">
            No activity matches these filters.{" "}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => {
                setSearch("")
                onToolChange(ALL_TOOLS)
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <>
            <div className="relative mt-4">
              <div className="absolute bottom-0 left-[3px] top-0 w-px bg-border" />
              <div className="space-y-0.5">
                {shown.map((event) => (
                  <ActivityRow key={event.id} event={event} onOpen={setSelected} />
                ))}
              </div>
            </div>

            {/* #56: a page LIST, not a load-more. Only this page's rows are
                held, so navigating replaces them rather than accumulating. */}
            {totalPages > 1 ? (
              <nav
                aria-label="Activity pages"
                className="mt-4 flex flex-wrap items-center justify-center gap-1 border-t pt-4"
              >
                <Button
                  variant="outline"
                  size="xs"
                  disabled={page <= 1 || loading}
                  onClick={() => onPageChange(page - 1)}
                >
                  Previous
                </Button>
                {Array.from({ length: totalPages }, (_, index) => index + 1)
                  // Windowed around the current page: a feed of 5000 rows is 200
                  // pages, and rendering every number is its own scrolling problem.
                  .filter(
                    (n) => n === 1 || n === totalPages || Math.abs(n - page) <= 2
                  )
                  .map((n, index, list) => (
                    <span key={n} className="flex items-center gap-1">
                      {index > 0 && n - list[index - 1] > 1 ? (
                        <span className="px-1 text-xs text-muted-foreground">…</span>
                      ) : null}
                      <Button
                        variant={n === page ? "default" : "outline"}
                        size="xs"
                        disabled={loading}
                        aria-current={n === page ? "page" : undefined}
                        onClick={() => onPageChange(n)}
                      >
                        {n}
                      </Button>
                    </span>
                  ))}
                <Button
                  variant="outline"
                  size="xs"
                  disabled={page >= totalPages || loading}
                  onClick={() => onPageChange(page + 1)}
                >
                  Next
                </Button>
                <span className="ml-2 text-[11px] text-muted-foreground">
                  Page {page} of {totalPages} · {totalCount} entries
                </span>
              </nav>
            ) : null}
          </>
        )}
      </section>

      <ActivityDetailSheet event={selected} onClose={() => setSelected(null)} />
    </PageShell>
  )
}
