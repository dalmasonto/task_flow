import { reviewDecisionClass, reviewDecisionLabel } from "@/lib/workspace-view"
import { Button } from "@/components/ui/button"
import { ArrowUpRightIcon, BanIcon, CheckCircle2Icon, ChevronRightIcon, ClipboardCheckIcon, MessageSquareIcon, RotateCcwIcon, XIcon } from "lucide-react"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { PageShell } from "@/components/layout"
import { cn } from "@/lib/utils"
import { priorityClass, statusLabel, type Task } from "@/lib/workspace-view"
import { type ReviewFeedItem } from "@/lib/live-mappers"
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"

/// A human's decision on a task under review. `approve` and `changes` are
/// recorded as reviews; `blocked` only moves the task.
export type ReviewChoice = "approve" | "changes" | "blocked"

const CHOICES: { value: ReviewChoice; label: string; detail: string; icon: typeof CheckCircle2Icon }[] = [
  { value: "approve", label: "Approve", detail: "Marks the task done", icon: CheckCircle2Icon },
  { value: "changes", label: "Request changes", detail: "Back to in progress, with your note", icon: RotateCcwIcon },
  { value: "blocked", label: "Block", detail: "Parks it until clarified", icon: BanIcon },
]

export function ReviewsPage({
  tasks,
  allTasks,
  reviews,
  onDecide,
  onOpenTask,
}: {
  /// The tasks waiting for a decision.
  tasks: Task[]
  /// Every task in the project, so a recent review can open a task that is no
  /// longer waiting.
  allTasks: Task[]
  /// Every review in the project, newest first.
  reviews: ReviewFeedItem[]
  onDecide: (taskId: string, decision: ReviewChoice, note: string) => Promise<void>
  onOpenTask: (taskId: string) => void
}) {
  const reviewsByTask = useMemo(() => {
    const byTask = new Map<string, ReviewFeedItem[]>()
    for (const review of reviews) byTask.set(review.taskId, [...(byTask.get(review.taskId) ?? []), review])
    return byTask
  }, [reviews])

  // The task whose reviews are open in the sheet. Kept as the Task itself, not
  // an id into `tasks`: deciding moves the task out of the queue, and the sheet
  // should stay open to show the decision land.
  const [openTask, setOpenTask] = useState<Task | null>(null)
  const openById = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId) ?? allTasks.find((t) => t.id === taskId)
    if (task) setOpenTask(task)
  }

  return (
    <PageShell
      eyebrow="Human in the loop"
      title="Review Queue"
      description="Tasks agents have finished and handed to you. Open one to read its review history and decide."
    >
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Waiting for you</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {tasks.length === 1 ? "1 task needs" : `${tasks.length} tasks need`} a decision.
            </p>
          </div>
          {tasks.length ? (
            <ul className="divide-y">
              {tasks.map((task) => {
                const history = reviewsByTask.get(task.id) ?? []
                const latest = history[0]
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => setOpenTask(task)}
                      className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{task.title}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span className={cn("rounded-full px-2 py-0.5 font-semibold capitalize ring-1", priorityClass(task.priority))}>
                            {task.priority}
                          </span>
                          <span>{task.owner}</span>
                          {task.due && task.due !== "Unscheduled" ? <span>· due {task.due}</span> : null}
                        </div>
                      </div>
                      <div className="hidden shrink-0 text-right sm:block">
                        {latest ? (
                          <>
                            <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1", reviewDecisionClass(latest.decision))}>
                              {reviewDecisionLabel(latest.decision)}
                            </span>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {history.length === 1 ? "1 review" : `${history.length} reviews`} · {latest.time}
                            </p>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">First review</span>
                        )}
                      </div>
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">Nothing is waiting for review.</div>
          )}
        </section>

        <aside>
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ClipboardCheckIcon className="size-4 text-primary" />
              Recent reviews
            </div>
            {reviews.length ? (
              <ul className="mt-3 space-y-1">
                {reviews.slice(0, 10).map((review) => (
                  <li key={review.id}>
                    <button
                      type="button"
                      onClick={() => openById(review.taskId)}
                      className="w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1", reviewDecisionClass(review.decision))}>
                          {reviewDecisionLabel(review.decision)}
                        </span>
                        <span className="text-xs text-muted-foreground">{review.time}</span>
                      </div>
                      <p className="mt-1.5 truncate text-sm font-medium">{review.taskTitle}</p>
                      <p className="text-xs text-muted-foreground">{review.reviewerLabel}</p>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No review decisions recorded yet.</p>
            )}
          </section>
        </aside>
      </div>

      {openTask ? (
        <ReviewThreadSheet
          // A fresh sheet per task: the draft note and the decision state
          // belong to the task they were written for.
          key={openTask.id}
          task={openTask}
          reviews={reviewsByTask.get(openTask.id) ?? []}
          waiting={tasks.some((t) => t.id === openTask.id)}
          onClose={() => setOpenTask(null)}
          onDecide={onDecide}
          onOpenTask={onOpenTask}
        />
      ) : null}
    </PageShell>
  )
}

/// Every review on one task, oldest at the top, opened scrolled to the latest —
/// then the decision form under it, so you read the history before deciding.
/// Shaped like the app's other detail sheets (task, activity): an inset card
/// on the right with its own scroll region.
export function ReviewThreadSheet({
  task,
  reviews,
  waiting,
  onClose,
  onDecide,
  onOpenTask,
}: {
  task: Task
  /// This task's reviews, newest first (the feed's order).
  reviews: ReviewFeedItem[]
  /// Whether the task is still in the review queue. Once it is not, the form
  /// gives way to a note saying so.
  waiting: boolean
  onClose: () => void
  onDecide: (taskId: string, decision: ReviewChoice, note: string) => Promise<void>
  onOpenTask: (taskId: string) => void
}) {
  const thread = useMemo(() => [...reviews].reverse(), [reviews])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [choice, setChoice] = useState<ReviewChoice>("approve")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [decided, setDecided] = useState<ReviewChoice | null>(null)

  // Open at the latest review, and follow a new one in (including the one
  // this sheet just recorded).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (choice === "changes" && !note.trim()) {
      setError("Say what needs to change — the agent works from this note.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onDecide(task.id, choice, note)
      setDecided(choice)
      setNote("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the decision.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" aria-label="Close reviews" className="fixed inset-0 z-40 bg-foreground/10" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Reviews for ${task.title}`}
        className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-[1.35rem] border bg-card shadow-2xl sm:inset-auto sm:top-4 sm:right-4 sm:bottom-4 sm:w-[min(44rem,calc(100vw-2rem))]"
      >
        <header
          className="relative shrink-0 overflow-hidden px-5 pt-5 pb-5"
          style={{
            background:
              "radial-gradient(circle at 18% 0%, color-mix(in oklab, var(--primary) 30%, transparent), transparent 34%), linear-gradient(180deg, color-mix(in oklab, var(--primary) 16%, transparent), transparent 74%)",
          }}
        >
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={cn("rounded-full px-2 py-0.5 font-semibold capitalize ring-1", priorityClass(task.priority))}>
                  {task.priority}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">{statusLabel(task.status)}</span>
                <span className="text-muted-foreground">{task.owner}</span>
              </div>
              <h2 className="mt-2 text-lg leading-snug font-semibold">{task.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {reviews.length === 0 ? "No reviews yet" : reviews.length === 1 ? "1 review" : `${reviews.length} reviews`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => onOpenTask(task.id)}>
                <ArrowUpRightIcon />
                Open task
              </Button>
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close reviews">
                <XIcon />
              </Button>
            </div>
          </div>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {task.description?.trim() ? (
            <details className="group mb-4 rounded-lg border bg-background">
              <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Task description
                <span className="ml-1 normal-case group-open:hidden">— show</span>
              </summary>
              <div className="border-t px-4 py-3">
                <MarkdownRenderer content={task.description} className="text-sm" />
              </div>
            </details>
          ) : null}

          {thread.length ? (
            <ol className="relative space-y-4 border-l pl-5">
              {thread.map((review, index) => {
                const latest = index === thread.length - 1
                return (
                  <li key={review.id} className="relative">
                    <span
                      className={cn(
                        "absolute top-4 -left-[1.6rem] size-2.5 rounded-full ring-4 ring-card",
                        review.decision === "approved" ? "bg-emerald-500" : "bg-amber-500",
                      )}
                    />
                    <article className={cn("rounded-lg border bg-background p-4", latest && "border-primary/40 shadow-sm")}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1", reviewDecisionClass(review.decision))}>
                            {reviewDecisionLabel(review.decision)}
                          </span>
                          {latest ? (
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">Latest</span>
                          ) : null}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {review.reviewerLabel} · {review.time}
                        </span>
                      </div>
                      {review.body ? (
                        <MarkdownRenderer content={review.body} className="mt-3 text-sm" />
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground italic">No note.</p>
                      )}
                    </article>
                  </li>
                )
              })}
            </ol>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              <MessageSquareIcon className="size-5" />
              This is the task's first review.
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t bg-card px-5 py-4">
          {decided ? (
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2Icon className="size-4 text-emerald-600" />
              {decided === "approve" ? "Approved — the task is done." : decided === "changes" ? "Changes requested — the task is back in progress." : "Blocked until clarified."}
            </p>
          ) : !waiting ? (
            <p className="text-sm text-muted-foreground">This task is not waiting for review ({statusLabel(task.status).toLowerCase()}).</p>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Decision">
                {CHOICES.map(({ value, label, detail, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={choice === value}
                    onClick={() => setChoice(value)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors",
                      choice === value ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/60",
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <Icon className="size-3.5" />
                      {label}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
                  </button>
                ))}
              </div>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder={choice === "changes" ? "What needs to change? (required)" : "Add a note (optional, markdown)"}
                className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
              {/* Left-aligned: the app's floating chat and session buttons sit
                  over every sheet's bottom-right corner. */}
              <div className="flex">
                <Button type="submit" size="sm" disabled={busy}>
                  <ClipboardCheckIcon />
                  {busy ? "Saving…" : "Submit decision"}
                </Button>
              </div>
            </form>
          )}
        </footer>
      </section>
    </>
  )
}
