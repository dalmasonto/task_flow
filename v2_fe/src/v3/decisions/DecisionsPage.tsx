/// Decisions (design: decisions.html): questions that block work, with
/// options, a recommendation and a ruling on record (#1094).
///
/// Reads the decisions service directly. Only a person rules (the service has
/// no agent route for it), and only the named ruler when one is named; the
/// form hides itself for anyone else, and the server enforces it anyway.
/// Decisions aren't on App's stream, so the list reloads on focus, every 30
/// seconds, and after an action.
import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CircleCheckIcon, PlusIcon, ScaleIcon } from "lucide-react"
import { toast } from "sonner"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { AskDecisionDialog } from "./AskDecisionDialog"
import { commentOnDecision, getDecision, listDecisions, ruleDecision, type Decision, type DecisionStatus } from "./decisions-api"
import { countByStatus, recommended, sortFor, waitingOnMe } from "./decisions-logic"
import { TaskLink } from "../components/task-link"

const TABS: { id: DecisionStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "ruled", label: "Ruled" },
  { id: "superseded", label: "Superseded" },
]

function TaskLinks({ ids }: { ids: number[] }) {
  if (!ids.length) return null
  return (
    <>
      {ids.slice(0, 3).map((t, i) => (
        <span key={t}>
          {i ? ", " : ""}
          <TaskLink task={t} className="underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
            #{t}
          </TaskLink>
        </span>
      ))}
      {ids.length > 3 ? ` +${ids.length - 3}` : ""}
    </>
  )
}

function Detail({ project, decisionKey, me, memberName, onChanged }: { project: number; decisionKey: string; me: number | null; memberName: (id: number | null) => string | null; onChanged: () => void }) {
  const now = useLivenessNow()
  const [loaded, setLoaded] = useState<{ key: string; d: Decision | null; error: string | null } | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [comment, setComment] = useState("")
  const [pending, setPending] = useState<null | "rule" | "comment">(null)
  const [tick, setTick] = useState(0)
  const d = loaded?.key === decisionKey ? loaded.d : null
  const error = loaded?.key === decisionKey ? loaded.error : null

  useEffect(() => {
    const ctl = new AbortController()
    getDecision(project, decisionKey, ctl.signal)
      .then((x) => setLoaded({ key: decisionKey, d: x, error: null }))
      .catch((e: unknown) => !ctl.signal.aborted && setLoaded({ key: decisionKey, d: null, error: e instanceof Error ? e.message : "Couldn't load the decision." }))
    return () => ctl.abort()
  }, [project, decisionKey, tick])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!d) return <Skeleton className="h-72 w-full rounded-xl" />

  const rec = recommended(d)
  const canRule = waitingOnMe(d, me)
  // Preselect the recommendation only for someone who can rule; for anyone
  // else a filled radio would read as a choice already made.
  const picked = choice ?? (canRule && rec ? String(rec.id) : null)
  const pickedLabel = d.options.find((o) => String(o.id) === picked)?.label
  const ruler = memberName(d.ruler_user)

  const rule = async () => {
    if (!picked) return
    setPending("rule")
    try {
      await ruleDecision(project, d.key, Number(picked), note)
      toast.success(`Ruled: ${pickedLabel}`, { description: d.task_ids.length ? `Unblocks ${d.task_ids.map((t) => `#${t}`).join(", ")}.` : undefined })
      setNote("")
      setChoice(null)
      setTick((t) => t + 1)
      onChanged()
    } catch (e) {
      toast.error("Couldn't record the ruling", { description: e instanceof Error ? e.message : undefined })
    } finally {
      setPending(null)
    }
  }

  const post = async () => {
    if (!comment.trim()) return
    setPending("comment")
    try {
      await commentOnDecision(project, d.key, comment.trim())
      setComment("")
      setTick((t) => t + 1)
    } catch (e) {
      toast.error("Couldn't post the comment", { description: e instanceof Error ? e.message : undefined })
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <p className="font-mono text-xs text-muted-foreground">{d.key}</p>
        <h3 className="mt-1 font-semibold">{d.question}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Asked by {d.asked_by_label} {timeAgo(d.created_at, now) ?? ""}
          {d.task_ids.length ? (
            <>
              . {d.status === "open" ? "Blocks" : "Was blocking"} <TaskLinks ids={d.task_ids} />
            </>
          ) : null}
          {d.status === "open" ? `. ${ruler ? `${ruler} rules.` : "Any member can rule."}` : "."}
        </p>
        {d.context_markdown ? <MarkdownRenderer content={d.context_markdown} className="mt-2 text-sm" /> : null}
      </div>

      {d.status === "open" ? (
        <RadioGroup value={picked ?? ""} onValueChange={(v) => setChoice(String(v))} className="space-y-2 p-4" aria-label="Options" disabled={!canRule}>
          {d.options.map((o) => (
            <Label key={o.id} className={cn("flex items-start gap-3 rounded-lg border border-border p-3 font-normal", canRule && "cursor-pointer hover:border-ring", picked === String(o.id) && "border-ring bg-accent/40")}>
              <RadioGroupItem value={String(o.id)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {o.label}
                  {o.recommended ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      {o.recommended_by_label ? <ActorAvatar model={o.recommended_by_agent ? guessModel(o.recommended_by_label) : null} name={o.recommended_by_label} size="xs" /> : null}
                      Recommended
                    </span>
                  ) : null}
                </span>
                {o.detail ? <span className="mt-1 block text-xs text-muted-foreground">{o.detail}</span> : null}
              </span>
            </Label>
          ))}
        </RadioGroup>
      ) : (
        <div className="space-y-1 p-4">
          {d.status === "ruled" ? (
            <>
              <p className="flex items-center gap-2 text-sm">
                <CircleCheckIcon className="size-4 text-done" /> Ruled <span className="font-medium">{d.ruled_option?.label}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {d.ruled_by_label}, {timeAgo(d.ruled_at, now) ?? ""}
              </p>
              {d.ruling_note ? <p className="mt-2 text-sm">{d.ruling_note}</p> : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Superseded{d.superseded_by_id ? ` by decision #${d.superseded_by_id}` : ""}. Its tasks moved to the replacement.</p>
          )}
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            {d.options.map((o) => (
              <li key={o.id} className={cn(d.ruled_option?.id === o.id && "font-medium text-foreground")}>
                {o.label}
                {o.recommended ? " (recommended)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-3 border-t border-border px-4 py-3">
        <h4 className="text-xs font-medium text-muted-foreground">Discussion</h4>
        {d.comments?.length ? (
          d.comments.map((c) => (
            <div key={c.id} className="flex gap-2 text-sm">
              <ActorAvatar model={c.author_agent ? guessModel(c.author_label) : null} name={c.author_label} size="sm" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{c.author_label}</span> {timeAgo(c.created_at, now) ?? ""}
                </p>
                <MarkdownRenderer content={c.body_markdown} className="text-sm" />
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        )}
        {d.status === "open" ? (
          <div className="flex items-end gap-2">
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={1} placeholder="Add to the discussion" aria-label="Comment" className="min-h-9" />
            <Button size="sm" variant="outline" onClick={() => void post()} disabled={!comment.trim() || pending !== null}>
              {pending === "comment" ? <Spinner /> : null}
              Post
            </Button>
          </div>
        ) : null}
      </div>

      {d.status === "open" && canRule ? (
        <form
          className="space-y-2 border-t border-border p-4"
          onSubmit={(e) => {
            e.preventDefault()
            void rule()
          }}
        >
          <Label htmlFor="d-note">Ruling note</Label>
          <Textarea id="d-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={4000} placeholder="Why this option, in one line" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              A ruling is permanent; it can only be superseded. Agents checking <code className="font-mono">{d.key}</code> get it at once.
            </span>
            <Button type="submit" size="sm" className="ml-auto" disabled={!picked || pending !== null}>
              {pending === "rule" ? <Spinner /> : null}
              {pickedLabel ? `Rule: ${pickedLabel}` : "Pick an option"}
            </Button>
          </div>
        </form>
      ) : d.status === "open" ? (
        <p className="border-t border-border p-4 text-xs text-muted-foreground">{ruler ?? "Someone else"} was named to rule on this.</p>
      ) : null}
    </div>
  )
}

export function DecisionsPage() {
  const { live, currentUser } = useWorkspace()
  const now = useLivenessNow()
  const project = live?.project.id ?? null
  const me = currentUser?.id ?? null
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<DecisionStatus>("open")
  const [mineOnly, setMineOnly] = useState(false)
  const [asking, setAsking] = useState(false)
  const [loaded, setLoaded] = useState<{ project: number; rows: Decision[]; error: string | null } | null>(null)
  const all = loaded?.project === project ? loaded.rows : null
  const error = loaded?.project === project ? loaded.error : null

  const members = useMemo(() => (live?.members ?? []).filter((m) => m.user != null && m.status === "active").map((m) => ({ user: m.user as number, name: m.display_name || m.email || `user ${m.user}` })), [live?.members])
  const memberName = (id: number | null) => (id == null ? null : (members.find((m) => m.user === id)?.name ?? `user ${id}`))

  const load = useCallback(() => {
    if (!project) return
    void listDecisions(project)
      .then((rows) => setLoaded({ project, rows, error: null }))
      .catch((e: unknown) => setLoaded({ project, rows: [], error: e instanceof Error ? e.message : "Couldn't load the decisions." }))
  }, [project])

  useEffect(() => {
    load()
    const t = window.setInterval(load, 30_000)
    window.addEventListener("focus", load)
    return () => {
      window.clearInterval(t)
      window.removeEventListener("focus", load)
    }
  }, [load])

  const counts = countByStatus(all ?? [])
  const list = sortFor(tab, all ?? []).filter((d) => !mineOnly || waitingOnMe(d, me))
  const recentlyRuled = tab === "open" ? sortFor("ruled", all ?? []).slice(0, 4) : []
  const selectedKey = params.get("key") ?? list[0]?.key ?? null
  const select = (key: string) => setParams((p) => ({ ...Object.fromEntries(p), key }), { replace: true })

  return (
    <V3Shell
      title="Decisions"
      actions={
        <Button size="sm" onClick={() => setAsking(true)} disabled={!project}>
          <PlusIcon />
          <span className="hidden sm:inline">Ask for a decision</span>
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="max-w-2xl">
          <h2 className="text-xl font-semibold tracking-tight">Decisions</h2>
          <p className="mt-1 text-sm text-muted-foreground">Questions that block work, with options, a recommendation and a ruling on record. Agents check a decision by its key before they act.</p>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!all && !error ? <Skeleton className="h-48 w-full rounded-xl" /> : null}

        {all && all.length === 0 ? (
          <Empty className="mt-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScaleIcon />
              </EmptyMedia>
              <EmptyTitle>No decisions yet</EmptyTitle>
              <EmptyDescription>When work hinges on a choice, ask for a ruling here. Agents can ask too, and they wait on the answer instead of guessing.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setAsking(true)}>
                <PlusIcon />
                Ask for a decision
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}

        {all && all.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div role="tablist" aria-label="Filter decisions" className="inline-flex rounded-md border border-border p-0.5 text-sm">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => {
                      setTab(t.id)
                      setParams({}, { replace: true })
                    }}
                    className={cn("inline-flex h-7 items-center gap-1.5 rounded px-2.5", tab === t.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {t.label}
                    {counts[t.id] ? <span className="text-xs tabular-nums">{counts[t.id]}</span> : null}
                  </button>
                ))}
              </div>
              {tab === "open" ? (
                <Button variant={mineOnly ? "secondary" : "ghost"} size="sm" aria-pressed={mineOnly} onClick={() => setMineOnly((v) => !v)}>
                  Waiting on me
                </Button>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
              <div className="min-w-0 space-y-4">
                {list.length ? (
                  <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    {list.map((d) => {
                      const rec = recommended(d)
                      return (
                        <li key={d.id} aria-current={d.key === selectedKey ? "true" : undefined} className={cn("cursor-pointer p-4 hover:bg-muted/40", d.key === selectedKey && "bg-accent/40")} onClick={() => select(d.key)}>
                          <div className="flex items-start gap-3">
                            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                              {d.status === "ruled" ? <CircleCheckIcon className="size-4 text-done" /> : <ScaleIcon className="size-4" />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <button type="button" className="text-left text-sm font-medium hover:underline" onClick={() => select(d.key)}>
                                {d.question}
                              </button>
                              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                {d.status === "ruled" ? (
                                  <span>
                                    Ruled <span className="font-medium text-foreground">{d.ruled_option?.label}</span> by {d.ruled_by_label}
                                  </span>
                                ) : (
                                  <span>{d.options.length} options</span>
                                )}
                                {d.status === "open" && rec ? <span>recommends {rec.label}</span> : null}
                                {d.status === "open" ? <span>{memberName(d.ruler_user) ? `${memberName(d.ruler_user)} to rule` : "anyone can rule"}</span> : null}
                                {d.task_ids.length ? (
                                  <span>
                                    {d.status === "open" ? "Blocks" : "Was blocking"} <TaskLinks ids={d.task_ids} />
                                  </span>
                                ) : null}
                                <span>{d.status === "open" ? `Asked ${timeAgo(d.created_at, now) ?? ""}` : (timeAgo(d.ruled_at ?? d.updated_at, now) ?? "")}</span>
                              </p>
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{tab === "open" ? (mineOnly ? "Nothing is waiting on you." : "No open decisions.") : tab === "ruled" ? "Nothing ruled yet." : "Nothing superseded."}</p>
                )}

                {recentlyRuled.length ? (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">Recently ruled</h3>
                    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                      {recentlyRuled.map((d) => (
                        <li key={d.id} className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm hover:bg-muted/40" onClick={() => select(d.key)}>
                          <CircleCheckIcon className="size-4 shrink-0 text-done" />
                          <span className="min-w-0 flex-1 truncate">
                            {d.question} <span className="font-medium">{d.ruled_option?.label}</span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {d.ruled_by_label}, {timeAgo(d.ruled_at, now) ?? ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="min-w-0 xl:sticky xl:top-0 xl:self-start">
                {project && selectedKey ? <Detail project={project} decisionKey={selectedKey} me={me} memberName={memberName} onChanged={load} /> : null}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {project ? (
        <AskDecisionDialog
          open={asking}
          onOpenChange={setAsking}
          project={project}
          members={members}
          onAsked={(d) => {
            setAsking(false)
            setTab("open")
            toast.success("Decision asked", { description: d.key })
            load()
            select(d.key)
          }}
        />
      ) : null}
    </V3Shell>
  )
}
