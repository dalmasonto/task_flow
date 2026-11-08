/// Reviews (design: reviews.html, reviews--empty): the review requests that
/// name you, the ones you made, and what was decided.
///
/// Requests are read over project-scoped, read-only REST (#1098; written only
/// by the request/cancel endpoints). A verdict goes through the trusted review
/// endpoint, which records the reviewer server-side and answers the request.
/// Requests aren't on the realtime stream, so the list reloads on focus, after
/// an action, and whenever a new verdict arrives on the stream.
/// Not built: the design's inline diff panel. There is no diff backend; a
/// request's link opens the diff or PR instead.
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { CheckCheckIcon, CircleCheckIcon, CircleXIcon, ExternalLinkIcon, FileTextIcon, GitPullRequestIcon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowReviewRequest, TaskflowTask } from "@/api/client"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { API_BASE_URL, withBearer } from "@/lib/auth-api"
import { fetchTaskTitles, reviewTask, taskflowApi } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { StatusChip } from "../components/status-chip"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { fetchTaskEvidence, type Evidence } from "../tasks/task-api"
import { useWorkspace } from "../workspace"
import { askedLine, recentVerdicts, reviewQueues, unnamedInReview, type ReviewTab } from "./reviews-logic"

async function fetchRequests(project: number): Promise<TaskflowReviewRequest[]> {
  const res = await taskflowApi.from("taskflow_review_request").filter({ project }).orderBy("-id").param("page_size", 100).list()
  return res.results as TaskflowReviewRequest[]
}

async function cancelRequest(id: number): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/taskflow/review-requests/${id}/cancel`, withBearer({ method: "POST" }))
  if (!res.ok) throw new Error(`Couldn't cancel the request (${res.status}).`)
}

function EvidenceChips({ task }: { task: number }) {
  const [items, setItems] = useState<Evidence[]>([])
  useEffect(() => {
    const ctl = new AbortController()
    fetchTaskEvidence(task, ctl.signal)
      .then(setItems)
      .catch(() => {})
    return () => ctl.abort()
  }, [task])
  if (!items.length) return null
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {items.slice(0, 4).map((e) => {
        const icon =
          e.passed === true ? <CircleCheckIcon className="size-3.5 text-done" /> : e.passed === false ? <CircleXIcon className="size-3.5 text-failed" /> : e.kind === "pull_request" ? <GitPullRequestIcon className="size-3.5 text-muted-foreground" /> : <FileTextIcon className="size-3.5 text-muted-foreground" />
        const chip = (
          <>
            {icon}
            <span className="truncate">{e.label}</span>
          </>
        )
        const cls = "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
        return e.url ? (
          <a key={e.id} href={e.url} target="_blank" rel="noreferrer noopener" className={cn(cls, "hover:bg-accent")}>
            {chip}
          </a>
        ) : (
          <span key={e.id} className={cls}>
            {chip}
          </span>
        )
      })}
      {items.length > 4 ? <span className="self-center text-xs text-muted-foreground">+{items.length - 4} more on the task</span> : null}
    </div>
  )
}

function Decide({ task, onDone }: { task: number; onDone: () => void }) {
  const [note, setNote] = useState("")
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<null | "approved" | "changes_requested">(null)
  const send = async (decision: "approved" | "changes_requested") => {
    if (decision === "changes_requested" && !note.trim()) {
      setOpen(true)
      return
    }
    setPending(decision)
    try {
      await reviewTask(task, decision, note.trim() || undefined)
      toast.success(decision === "approved" ? `Approved #${task}` : `Asked for changes on #${task}`)
      onDone()
    } catch (e) {
      toast.error("Couldn't send the review", { description: e instanceof Error ? e.message : undefined })
    } finally {
      setPending(null)
    }
  }
  return (
    <div className="mt-4 space-y-2">
      {open ? <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus placeholder="What did you verify? What should change?" aria-label={`Review note for #${task}`} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void send("approved")} disabled={pending !== null}>
          {pending === "approved" ? <Spinner /> : null}
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => void send("changes_requested")} disabled={pending !== null}>
          {pending === "changes_requested" ? <Spinner /> : null}
          Request changes
        </Button>
        {!open ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Add a note
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto" render={<Link to={`/v3/tasks/${task}`} />} nativeButton={false}>
          Open task
        </Button>
      </div>
    </div>
  )
}

export function ReviewsPage() {
  const { live, currentUser } = useWorkspace()
  const now = useLivenessNow()
  const project = live?.project.id ?? null
  const [tab, setTab] = useState<ReviewTab>("waiting")
  const [loaded, setLoaded] = useState<{ project: number; rows: TaskflowReviewRequest[]; error: string | null } | null>(null)
  const [titles, setTitles] = useState<Record<number, string>>({})
  const requests = loaded && loaded.project === project ? loaded.rows : null
  const error = loaded && loaded.project === project ? loaded.error : null

  const load = useCallback(() => {
    if (!project) return
    void fetchRequests(project)
      .then((rows) => {
        setLoaded({ project, rows, error: null })
        const missing = [...new Set(rows.map((r) => r.task))]
        void fetchTaskTitles(missing)
          .then((ts) => setTitles((cur) => ({ ...cur, ...Object.fromEntries(ts.map((t) => [t.id, t.title])) })))
          .catch(() => {})
      })
      .catch(() => setLoaded({ project, rows: [], error: "Couldn't load the review requests. Check your connection and try again." }))
  }, [project])

  const verdictCount = live?.taskReviews.length ?? 0
  useEffect(() => {
    load()
  }, [load, verdictCount])
  useEffect(() => {
    window.addEventListener("focus", load)
    return () => window.removeEventListener("focus", load)
  }, [load])

  const queues = useMemo(() => reviewQueues(requests ?? [], currentUser?.id ?? null), [requests, currentUser?.id])
  const unnamed = useMemo(() => unnamedInReview(live?.tasks ?? [], requests ?? []), [live?.tasks, requests])
  const verdicts = recentVerdicts(live?.taskReviews ?? [])
  const titleOf = (id: number) => (live?.tasks ?? []).find((t: TaskflowTask) => t.id === id)?.title ?? titles[id] ?? `Task #${id}`

  const card = (r: TaskflowReviewRequest, mode: ReviewTab) => {
    const who = mode === "mine" ? r.reviewer_label : r.requester_label
    const whoKind = mode === "mine" ? r.reviewer_kind : r.requester_kind
    return (
      <li key={r.id} className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <ActorAvatar model={whoKind === "agent" ? guessModel(who) : null} name={who} size="md" />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              {mode === "mine" ? (
                <>
                  You asked <span className="font-medium">{who}</span>
                </>
              ) : (
                <>
                  <span className="font-medium">{who}</span> {askedLine(r, requests ?? [])}
                </>
              )}
            </p>
            <Link to={`/v3/tasks/${r.task}`} className="mt-0.5 block truncate font-medium hover:underline">
              <span className="font-mono text-xs text-muted-foreground">#{r.task}</span> {titleOf(r.task)}
            </Link>
          </div>
          <StatusChip tone="review" label="In review" />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{timeAgo(r.created_at, now) ?? ""}</span>
          {r.link ? (
            <a href={r.link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-foreground">
              <ExternalLinkIcon className="size-3.5" />
              Diff
            </a>
          ) : null}
        </div>
        {r.focus_markdown ? (
          <div className="mt-3 rounded-md bg-muted/60 p-3 text-sm">
            <span className="font-medium">Focus: </span>
            <MarkdownRenderer content={r.focus_markdown} className="inline text-sm [&>p]:inline" />
          </div>
        ) : null}
        <EvidenceChips task={r.task} />
        {mode === "waiting" ? (
          <Decide task={r.task} onDone={load} />
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" render={<Link to={`/v3/tasks/${r.task}`} />} nativeButton={false}>
              Open task
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void cancelRequest(r.id)
                  .then(() => {
                    toast.success("Request cancelled")
                    load()
                  })
                  .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn't cancel the request"))
              }
            >
              Cancel request
            </Button>
          </div>
        )}
      </li>
    )
  }

  const TABS: { id: ReviewTab; label: string; n?: number }[] = [
    { id: "waiting", label: "Waiting", n: queues.waiting.length },
    { id: "mine", label: "Requested by me", n: queues.mine.length },
    { id: "done", label: "Done" },
  ]
  const list = tab === "waiting" ? queues.waiting : tab === "mine" ? queues.mine : []
  const nothingAtAll = requests && !queues.waiting.length && !queues.mine.length && !queues.done.length && !unnamed.length && !verdicts.length

  return (
    <V3Shell title="Reviews">
      <div className="mx-auto max-w-3xl">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
        {!requests && !error ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading reviews">
            {[0, 1].map((k) => (
              <Skeleton key={k} className="h-40 w-full rounded-xl" />
            ))}
          </div>
        ) : nothingAtAll ? (
          <Empty className="mt-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CheckCheckIcon />
              </EmptyMedia>
              <EmptyTitle>No reviews waiting on you</EmptyTitle>
              <EmptyDescription>When an agent moves a task to review and names you, it shows up here with its evidence.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" render={<Link to="/v3/board" />} nativeButton={false}>
                Go to the board
              </Button>
            </EmptyContent>
          </Empty>
        ) : requests ? (
          <>
            <div role="tablist" aria-label="Reviews" className="inline-flex rounded-md border border-border p-0.5 text-sm">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn("inline-flex h-7 items-center gap-1.5 rounded px-2.5", tab === t.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {t.label}
                  {t.n ? <span className="text-xs tabular-nums">{t.n}</span> : null}
                </button>
              ))}
            </div>

            {tab !== "done" ? (
              list.length ? (
                <ul className="mt-4 space-y-3">{list.map((r) => card(r, tab))}</ul>
              ) : (
                <p className="mt-6 text-sm text-muted-foreground">{tab === "waiting" ? "Nothing is waiting on you." : "You haven't asked anyone for a review that's still open."}</p>
              )
            ) : queues.done.length ? (
              <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {queues.done.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{r.requester_label}</span> asked <span className="font-medium">{r.reviewer_label}</span> about{" "}
                      <Link to={`/v3/tasks/${r.task}`} className="hover:underline">
                        #{r.task} {titleOf(r.task)}
                      </Link>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {r.status === "answered" ? "Answered" : "Cancelled"} {timeAgo(r.closed_at, now) ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-6 text-sm text-muted-foreground">No finished requests yet.</p>
            )}

            {tab === "waiting" && unnamed.length ? (
              <>
                <h2 className="mt-8 mb-2 text-sm font-semibold">In review, nobody named</h2>
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {unnamed.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                      <Link to={`/v3/tasks/${t.id}`} className="min-w-0 flex-1 truncate hover:underline">
                        <span className="font-mono text-xs text-muted-foreground">#{t.id}</span> {t.title}
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(t.updated_at, now) ?? ""}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {verdicts.length ? (
              <>
                <h2 className="mt-8 mb-2 text-sm font-semibold">Recently completed</h2>
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {verdicts.map((v) => (
                    <li key={v.id} className="flex items-center gap-3 px-4 py-3">
                      <ActorAvatar model={v.reviewer_kind === "agent" ? guessModel(v.reviewer_label) : null} name={v.reviewer_label} size="sm" />
                      <p className="min-w-0 flex-1 truncate text-sm">
                        <span className="font-medium">{v.reviewer_label}</span> {v.decision === "approved" ? "approved" : "requested changes on"}{" "}
                        <Link to={`/v3/tasks/${v.task}`} className="hover:underline">
                          #{v.task} {titleOf(v.task)}
                        </Link>
                      </p>
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(v.created_at, now) ?? ""}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </V3Shell>
  )
}
