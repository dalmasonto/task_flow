import { type TaskRefState } from "@/lib/task-ref-state"
import { Loader2 as LoaderIcon } from "lucide-react"
import { ArrowLeftIcon, ArrowRightIcon, GripVerticalIcon } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { priorityClass, type Task } from "@/lib/workspace-view"
import { useEffect, useRef, useState, type DragEvent } from "react"


export function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="text-2xl font-semibold">{value}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      </div>
    </div>
  )
}


export function TaskCard({
  task,
  selected,
  dragging,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMoveNext,
  onMovePrevious,
}: {
  task: Task
  selected: boolean
  dragging: boolean
  onSelect: () => void
  onDragStart: () => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onMoveNext: () => void
  onMovePrevious: () => void
}) {
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      className={cn(
        "group rounded-lg border bg-background p-3 shadow-sm transition-colors hover:border-primary/35 hover:shadow-md",
        selected && "border-primary/60 ring-2 ring-primary/15",
        dragging && "opacity-55"
      )}
    >
      <div className="flex items-start gap-2">
        <GripVerticalIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("rounded-full px-2 py-0.5 text-[0.68rem] font-semibold capitalize ring-1", priorityClass(task.priority))}>
              {task.priority}
            </span>
            {/* The task # so a card can be identified at a glance / referenced. */}
            <span className="shrink-0 font-mono text-[0.68rem] font-medium text-muted-foreground">#{task.id}</span>
            <span className="truncate text-xs text-muted-foreground">{task.updated}</span>
          </div>
          <h4 className="mt-2 text-sm font-semibold leading-5">{task.title}</h4>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {task.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="rounded-md bg-muted px-1.5 py-1 text-[0.68rem] font-medium text-muted-foreground">
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar size="sm">
            <AvatarFallback>{task.ownerInitials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{task.owner}</p>
            <p className="truncate text-[0.68rem] text-muted-foreground">{task.operatorName}</p>
          </div>
        </div>
        <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(event) => {
              event.stopPropagation()
              onMovePrevious()
            }}
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(event) => {
              event.stopPropagation()
              onMoveNext()
            }}
          >
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </article>
  )
}


export function DropIndicator({ label, position }: { label: string; position: "before" | "after" }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-0 right-0 z-20 flex h-0 items-center",
        position === "before" ? "-top-1" : "-bottom-1"
      )}
      aria-label={label}
    >
      <div className="h-0.5 flex-1 rounded-full bg-primary shadow-[0_0_0_3px_oklch(0.54_0.16_238_/_0.14)]" />
      <span className="mx-2 rounded-full bg-primary px-2 py-0.5 text-[0.65rem] font-semibold text-primary-foreground shadow-sm">
        Drop here
      </span>
      <div className="h-0.5 flex-1 rounded-full bg-primary shadow-[0_0_0_3px_oklch(0.54_0.16_238_/_0.14)]" />
    </div>
  )
}


export function EndDropIndicator({ label }: { label: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-2 bottom-2 z-20 flex h-10 items-center justify-center rounded-lg border border-dashed border-primary/60 bg-primary/10 px-3 text-xs font-medium text-primary"
      aria-label={label}
    >
      Drop at end
    </div>
  )
}


/// #26: a foot-of-column sentinel that asks for the next page when it scrolls
/// into view. The observer is created ONCE (empty deps) and reads the latest
/// callback via a ref — recreating it on each render would fire immediately
/// while still intersecting and load every page in a runaway loop (the same
/// trap that bit the #38 activity auto-loader). `remaining` only labels it.
export function BoardLoadMoreSentinel({ onLoadMore, remaining }: { onLoadMore: () => void; remaining: number }) {
  const ref = useRef<HTMLButtonElement>(null)
  const callback = useRef(onLoadMore)
  callback.current = onLoadMore
  // Whether the foot is in (or near) the visible scroll area — drives the
  // spinner so the user sees loading feedback as they reach the bottom.
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    // Observe against the column's OWN scroll container, not the viewport: the
    // cards scroll inside `[data-board-scroll]`, so a viewport root measures the
    // wrong box — its rootMargin never preloads and it only fires once the foot
    // is dragged fully on-screen. Fall back to the viewport if not found.
    const root = node.closest("[data-board-scroll]")
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries[0]?.isIntersecting ?? false
        setPending(hit)
        // One page per not-intersecting→intersecting transition: a full page of
        // cards overflows the column, pushing the foot back below the fold so the
        // next scroll re-fires. No transition → no re-fire, so this can't loop.
        if (hit) callback.current()
      },
      { root, rootMargin: "240px" }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Click is the always-works fallback: if a page ever fails to overflow (very
  // tall viewport, short cards) the observer won't re-fire, so let the user pull
  // the next page by hand.
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => callback.current()}
      className="flex items-center justify-center gap-2 rounded-md py-2 text-[11px] text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
    >
      <LoaderIcon className={cn("size-3.5", pending && "animate-spin")} />
      {pending ? "Loading" : "Load"} more… ({remaining} left)
    </button>
  )
}


/// #49: shown when a TASK#<n> chip resolves to anything other than an open-able
/// task in the active project. Previously all of these rendered `null`, so a
/// typo'd id looked identical to a broken button.
export function TaskRefNotice({
  state,
  onClose,
  onSwitchProject,
}: {
  state: Extract<TaskRefState, { kind: "loading" | "other_project" | "unavailable" }>
  onClose: () => void
  onSwitchProject: (projectId: string) => void
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-40 bg-foreground/10"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Task reference"
        className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-5 shadow-2xl"
      >
        {state.kind === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" />
            Loading task…
          </div>
        ) : (
          <>
            <h2 className="text-sm font-semibold">
              {state.kind === "other_project"
                ? `Task #${state.taskId} is in another project`
                : `Can't open task #${state.taskId}`}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {state.kind === "other_project"
                ? `It belongs to ${state.projectName}. Switch to that project to open it.`
                : state.reason}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>
                {state.kind === "other_project" ? "Cancel" : "Close"}
              </Button>
              {state.kind === "other_project" ? (
                <Button size="sm" onClick={() => onSwitchProject(state.projectId)}>
                  Switch to {state.projectName}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </section>
    </>
  )
}
