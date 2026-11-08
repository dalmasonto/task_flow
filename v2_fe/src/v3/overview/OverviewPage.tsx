/// Overview (design: overview.html, overview--empty): the project at a glance.
/// What needs you, who's working, the board's shape, throughput, today's
/// update, the getting-started checklist, spend and recent activity.
///
/// Every card reads a real source and hides or says so when it has nothing:
/// the inbox (needs you), App's live agents/sessions/board (working now,
/// tasks), project stats (throughput), the daily-update, usage and activity
/// services. No card invents a number.
import { useState } from "react"
import { Link } from "react-router-dom"
import { CalendarClockIcon, CircleCheckIcon, CircleIcon, ChevronRightIcon, EyeIcon, HelpCircleIcon, MessageSquareIcon, PlusIcon, ScaleIcon, ShieldAlertIcon, XIcon } from "lucide-react"

import type { TaskflowAgentMessage, TaskflowTaskActivity } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { fetchProjectStats, taskflowApi, taskflowTables } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { STATUS_LABEL } from "../components/status-tones"
import { useStatusCounts } from "../board/use-status-counts"
import { guessModel } from "../components/actor-models"
import { agentRows } from "../agents/agents-logic"
import { useAgentSlices } from "../agents/use-agent-slices"
import { verbOf } from "../activity/activity-logic"
import { listDailyUpdates } from "../daily/daily-api"
import { todayIn } from "../daily/daily-logic"
import { fetchInbox, type InboxItem } from "../inbox/inbox-api"
import { timeAgo } from "../lib/time"
import { useLoad } from "../lib/use-load"
import { V3Shell } from "../shell/V3Shell"
import { fetchUsage, money, tokens, totalTokens } from "../usage/usage-api"
import { useWorkspace } from "../workspace"
import { checklist, lastDays, summaryLine } from "./overview-logic"
import { NewTaskLink, TaskLink } from "../components/task-link"

const DISMISS_KEY = "taskflow.v3.checklistDismissed"
// #5933: one segment per flat status (archived is left out of the bar).
const BAR_STATUSES = ["not_started", "in_progress", "paused", "blocked", "partial_done", "done"] as const
const BAR: Record<(typeof BAR_STATUSES)[number], string> = { not_started: "bg-idle", in_progress: "bg-running", paused: "bg-muted-foreground/40", blocked: "bg-blocked", partial_done: "bg-review", done: "bg-done" }

function Card({ title, action, children, className }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-border bg-card p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function CardLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
      {children}
    </Link>
  )
}

function needRow(i: InboxItem): { icon: React.ReactNode; title: string; meta: string; to: string; cta: string } {
  switch (i.kind) {
    case "prompt":
    case "prompt_withdrawn":
      return { icon: <ShieldAlertIcon />, title: i.question.split("\n")[0], meta: `${i.agent_label ?? `Agent ${i.agent}`} needs your permission`, to: "/v3/inbox", cta: "Answer" }
    case "decision":
      return { icon: <ScaleIcon />, title: i.question, meta: `${i.asked_by_label} asks for a ruling`, to: `/v3/decisions?key=${encodeURIComponent(i.key)}`, cta: "Decide" }
    case "review_request":
      return { icon: <EyeIcon />, title: `Review #${i.task}`, meta: `${i.requester_label} asked you`, to: "/v3/reviews", cta: "Review" }
    case "daily_update":
      return { icon: <CalendarClockIcon />, title: `Daily update for ${i.date}`, meta: `Drafted by ${i.drafted_by_label}`, to: `/v3/daily-update/${i.date}`, cta: "Review" }
    case "question":
      return { icon: <HelpCircleIcon />, title: i.snippet, meta: `${i.sender_label} asked you`, to: `/v3/chat/channel-${i.channel}`, cta: "Answer" }
    case "mention":
      return { icon: <MessageSquareIcon />, title: i.snippet, meta: `${i.sender_label} mentioned you`, to: `/v3/chat/channel-${i.channel}`, cta: "Reply" }
  }
}

export function OverviewPage() {
  useAgentSlices()
  const { live, board } = useWorkspace()
  const now = useLivenessNow()
  const project = live?.project.id ?? null
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1"
    } catch {
      return false
    }
  })

  const inbox = useLoad(project ? `inbox-${project}` : null, (s) => fetchInbox("needs_you", project, s))
  // fetchProjectStats takes no signal; useLoad drops a stale result anyway.
  const stats = useLoad(project ? `stats-${project}` : null, () => fetchProjectStats(project!, "30d"))
  const daily = useLoad(project ? `daily-${project}` : null, (s) => listDailyUpdates(project!, s))
  // Local midnight; as a string it only changes once a day, so it's the key.
  const dayKey = new Date(now).toDateString()
  const spend = useLoad(project ? `spend-${project}-${dayKey}` : null, (s) => fetchUsage(project!, { from: new Date(dayKey), group: "agent" }, s))
  const recent = useLoad(project ? `recent-${project}` : null, () =>
    taskflowApi
      .from(taskflowTables.taskActivity)
      .filter({ project: project! })
      .orderBy("-created_at", "-id")
      .param("page_size", 6)
      .list()
      .then((r) => r.results as TaskflowTaskActivity[]),
  )
  const talkers = useLoad(project && !dismissed ? `talk-${project}` : null, () =>
    taskflowApi
      .from(taskflowTables.agentMessages)
      .filter({ project: project!, sender_kind: "agent" })
      .orderBy("-id")
      .param("page_size", 50)
      .list()
      .then((r) => r.results as TaskflowAgentMessage[]),
  )

  const rows = live ? agentRows(live.agents, live.agentSessions, live.tasks, now) : []
  const working = rows.filter((r) => r.state !== "offline")
  const totals = useStatusCounts()
  const open = (totals.not_started ?? 0) + (totals.in_progress ?? 0) + (totals.paused ?? 0) + (totals.blocked ?? 0) + (totals.partial_done ?? 0)
  const barTotal = open + (totals.done ?? 0)
  const needs = inbox.data?.items ?? []
  const steps = live ? checklist({ agents: live.agents, messages: talkers.data ?? [], taskCount: board.total, members: live.members }) : []
  const stepsDone = steps.filter((s) => s.done).length
  const showChecklist = !dismissed && steps.length > 0 && stepsDone < steps.length
  const days = stats.data ? lastDays(stats.data.tasks_closed_by_day, 14, new Date(now)) : []
  const finished = days.reduce((n, d) => n + d.count, 0)
  const peak = Math.max(1, ...days.map((d) => d.count))
  const today = todayIn(undefined, new Date(now))
  const todays = daily.data?.find((u) => u.date === today) ?? null
  const agentName = (id: string) => live?.agents.find((a) => String(a.id) === id)?.display_name ?? `Agent ${id}`
  const fresh = !live?.agents.length && board.total === 0

  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, "1")
    } catch {
      // private mode: dismissed for this visit only
    }
  }

  const checklistCard = showChecklist ? (
    <Card
      title="Get your agents talking"
      action={
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss checklist" onClick={dismiss}>
          <XIcon />
        </Button>
      }
    >
      <p className="mt-0.5 text-xs text-muted-foreground">
        {stepsDone} of {steps.length} done
      </p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={stepsDone} aria-label="Checklist progress">
        <div className="h-full rounded-full bg-primary" style={{ width: `${(stepsDone / steps.length) * 100}%` }} />
      </div>
      <ol className="mt-3 space-y-1">
        {steps.map((s) => (
          <li key={s.id}>
            {s.done ? (
              <span className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                <CircleCheckIcon className="size-4 text-done" />
                <span className="line-through">{s.label}</span>
              </span>
            ) : (
              <Link to={s.href} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                <CircleIcon className="size-4 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block">{s.label}</span>
                  {fresh ? <span className="block text-xs text-muted-foreground">{s.hint}</span> : null}
                </span>
                <ChevronRightIcon className="ml-auto size-4 text-muted-foreground" />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  ) : null

  return (
    <V3Shell
      title="Overview"
      actions={
        <Button size="sm" render={<NewTaskLink />} nativeButton={false}>
          <PlusIcon />
          <span className="hidden sm:inline">New task</span>
        </Button>
      }
    >
      {fresh ? (
        <div className="mx-auto max-w-xl space-y-5 py-6">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Welcome to {live?.project.name ?? "TaskFlow"}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Connect two agents from different models and watch them work together. It takes about five minutes.</p>
          </div>
          {checklistCard}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          <div className="min-w-0 space-y-5 xl:col-span-2">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">{new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{summaryLine(rows.filter((r) => r.state === "live").length, inbox.data?.counts.needs_you ?? 0, open)}</p>
            </div>

            <section className="rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold">Needs you</h3>
                {inbox.data?.counts.needs_you ? <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums">{inbox.data.counts.needs_you}</span> : null}
                <span className="ml-auto">
                  <CardLink to="/v3/inbox">Inbox</CardLink>
                </span>
              </div>
              {inbox.loading ? (
                <Skeleton className="m-4 h-12" />
              ) : inbox.error ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">Couldn&apos;t load what needs you.</p>
              ) : needs.length ? (
                <ul className="divide-y divide-border">
                  {needs.slice(0, 5).map((i, k) => {
                    const n = needRow(i)
                    return (
                      <li key={k} className="flex items-center gap-3 px-4 py-3">
                        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{n.icon}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{n.title}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {n.meta}, {timeAgo(i.at, now) ?? ""}
                          </p>
                        </div>
                        <Button size="sm" variant="outline" render={<Link to={n.to} />} nativeButton={false}>
                          {n.cta}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="px-4 py-3 text-sm text-muted-foreground">Nothing is waiting on you.</p>
              )}
            </section>

            <Card title="Working now" action={<CardLink to="/v3/agents">All agents</CardLink>}>
              {working.length ? (
                <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {working.slice(0, 6).map((r) => (
                    <li key={r.id}>
                      <Link to={`/v3/agents/${r.id}`} className="block rounded-lg border border-border p-3 hover:border-ring">
                        <span className="flex items-center gap-2">
                          <ActorAvatar model={r.model} name={r.name} status={r.state === "live" ? "running" : "idle"} size="md" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{r.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">{r.task ? `#${r.task.id} ${r.task.title}` : "Online, idle"}</span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No agent is online right now.</p>
              )}
            </Card>

            <Card title="Tasks" action={<CardLink to="/v3/board">Open board</CardLink>}>
              <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={BAR_STATUSES.map((c) => `${totals[c] ?? 0} ${STATUS_LABEL[c]}`).join(", ")}>
                {barTotal
                  ? BAR_STATUSES.map((c) => (totals[c] ? <span key={c} className={cn("h-full", BAR[c])} style={{ width: `${((totals[c] ?? 0) / barTotal) * 100}%` }} /> : null))
                  : null}
              </div>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {BAR_STATUSES.map((c) => (
                  <li key={c} className="flex items-center gap-1.5">
                    <span className={cn("size-2 rounded-full", BAR[c])} />
                    {STATUS_LABEL[c]} <span className="text-muted-foreground tabular-nums">{totals[c] ?? "…"}</span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Finished, last 14 days">
              {stats.loading ? (
                <Skeleton className="mt-3 h-40" />
              ) : stats.error ? (
                <p className="mt-2 text-sm text-muted-foreground">Couldn&apos;t load throughput.</p>
              ) : finished === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No tasks were closed in the last 14 days.</p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground tabular-nums">{finished}</span> tasks closed
                  </p>
                  <figure className="mt-3">
                    <div className="flex h-36 items-end gap-1" role="img" aria-label={`Tasks closed per day: ${days.map((d) => `${d.label} ${d.count}`).join(", ")}`}>
                      {days.map((d) => (
                        <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end">
                          <div className="min-h-px rounded-t bg-chart-1" style={{ height: `${(d.count / peak) * 100}%` }} title={`${d.label}: ${d.count}`} />
                        </div>
                      ))}
                    </div>
                    <figcaption className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                      <span>{days[0]?.label}</span>
                      <span>{days[days.length - 1]?.label}</span>
                    </figcaption>
                  </figure>
                </>
              )}
            </Card>

            {todays ? (
              <Card title="Today's update" action={<CardLink to={`/v3/daily-update/${todays.date}`}>{todays.status === "draft" ? "Review and post" : "Open"}</CardLink>}>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{todays.excerpt}</p>
              </Card>
            ) : null}
          </div>

          <div className="min-w-0 space-y-5">
            {checklistCard}

            <Card title="Agent spend today" action={<CardLink to="/v3/usage">Usage</CardLink>}>
              {spend.loading ? (
                <Skeleton className="mt-3 h-24" />
              ) : spend.error ? (
                <p className="mt-2 text-sm text-muted-foreground">Couldn&apos;t load usage.</p>
              ) : spend.data && spend.data.groups.length ? (
                <>
                  <table className="mt-3 w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-2 font-medium">Agent</th>
                        <th className="pb-2 text-right font-medium">Tokens</th>
                        <th className="pb-2 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {[...spend.data.groups]
                        .sort((a, b) => b.usage.cost_micros - a.usage.cost_micros)
                        .map((g) => (
                          <tr key={g.key}>
                            <td className="py-2">
                              <span className="flex min-w-0 items-center gap-2">
                                <ActorAvatar model={guessModel(agentName(g.key))} name={agentName(g.key)} size="xs" />
                                <span className="truncate">{agentName(g.key)}</span>
                              </span>
                            </td>
                            <td className="py-2 text-right tabular-nums">{tokens(totalTokens(g.usage))}</td>
                            <td className="py-2 text-right tabular-nums">{money(g.usage.cost_micros)}</td>
                          </tr>
                        ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border font-medium">
                        <td className="pt-2">Total</td>
                        <td className="pt-2 text-right tabular-nums">{tokens(totalTokens(spend.data.total))}</td>
                        <td className="pt-2 text-right tabular-nums">{money(spend.data.total.cost_micros)}</td>
                      </tr>
                    </tfoot>
                  </table>
                  {spend.data.total.unpriced_reports ? <p className="mt-2 text-xs text-muted-foreground">{spend.data.total.unpriced_reports} reports have no price for their model, so they aren&apos;t in the cost.</p> : null}
                </>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No usage reported today. Agents report it through their MCP.</p>
              )}
              {spend.data?.month.budget_micros ? (
                <div className="mt-3 border-t border-border pt-3">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{new Date(now).toLocaleDateString(undefined, { month: "long" })} budget</span>
                    <span className="tabular-nums">
                      <span className="font-medium">{money(spend.data.month.spend_micros)}</span> of {money(spend.data.month.budget_micros)}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={spend.data.month.budget_micros} aria-valuenow={spend.data.month.spend_micros} aria-label="Budget used">
                    <div className={cn("h-full rounded-full", spend.data.month.spend_micros > spend.data.month.budget_micros ? "bg-failed" : "bg-primary")} style={{ width: `${Math.min(100, (spend.data.month.spend_micros / spend.data.month.budget_micros) * 100)}%` }} />
                  </div>
                </div>
              ) : null}
            </Card>

            <Card title="Recent activity" action={<CardLink to="/v3/activity">All activity</CardLink>}>
              {recent.loading ? (
                <Skeleton className="mt-3 h-24" />
              ) : recent.data?.length ? (
                <ul className="mt-3 space-y-3 text-sm">
                  {recent.data.map((r) => {
                    const { verb, tool } = verbOf(r.action)
                    const body = r.body_markdown?.trim().split("\n")[0]
                    return (
                      <li key={r.id} className="flex gap-2.5">
                        <ActorAvatar model={r.actor_kind === "agent" ? guessModel(r.actor_label) : null} name={r.actor_label || "Someone"} size="sm" />
                        <p className="min-w-0 leading-5">
                          <span className="font-medium">{r.actor_label || "Someone"}</span> {tool ? (body ?? `ran ${verb}`) : verb}
                          {r.task != null ? (
                            <>
                              {" "}
                              <TaskLink task={r.task} className="hover:underline">
                                #{r.task}
                              </TaskLink>
                            </>
                          ) : null}
                          <span className="block text-xs text-muted-foreground">{timeAgo(r.created_at, now) ?? ""}</span>
                        </p>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">Nothing yet.</p>
              )}
            </Card>
          </div>
        </div>
      )}
    </V3Shell>
  )
}
