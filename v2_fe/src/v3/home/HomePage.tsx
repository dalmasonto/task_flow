/// Home (design: home.html): everything across your projects. What's waiting
/// on you, this week's spend, each project's board at a glance, tasks
/// assigned to you, and your agents.
///
/// Cross-project, so it reads its own sources (all scoped server-side to the
/// projects you belong to): the inbox, a page_size=1 count per board column
/// per project, the agent roster, your assigned tasks, and each project's
/// usage since Monday. Opening a project switches to it and goes to its
/// overview.
import { Link, useNavigate } from "react-router-dom"
import { AtSignIcon, CalendarClockIcon, EyeIcon, HelpCircleIcon, PlusIcon, ScaleIcon, ShieldAlertIcon } from "lucide-react"

import type { TaskflowAgent, TaskflowTask } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { columnStatuses, type BoardColumnId } from "@/lib/board-columns"
import { isAgentOnline } from "@/lib/live-mappers"
import { taskflowApi, taskflowTables } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { StatusChip } from "../components/status-chip"
import { COLUMN_LABEL } from "../components/status-tones"
import { fetchInbox, type InboxItem } from "../inbox/inbox-api"
import { timeAgo } from "../lib/time"
import { useLoad } from "../lib/use-load"
import { V3Shell } from "../shell/V3Shell"
import { fetchUsage, money, type UsageResponse } from "../usage/usage-api"
import { useWorkspace } from "../workspace"
import { firstName, greeting, homeLine, weekStart } from "./home-logic"

const COLUMNS: BoardColumnId[] = ["not_started", "in_progress", "review", "blocked", "done"]
const BAR: Record<BoardColumnId, string> = { not_started: "bg-idle/50", in_progress: "bg-running", review: "bg-review", blocked: "bg-blocked", done: "bg-done" }
const MAX_PROJECTS = 9

async function columnCounts(project: number): Promise<Record<BoardColumnId, number>> {
  const counts = await Promise.all(
    COLUMNS.map((c) =>
      taskflowApi
        .from(taskflowTables.tasks)
        .filter({ project })
        .param("status__in", columnStatuses(c).join(","))
        .param("page_size", 1)
        .param("fields", "id")
        .list()
        .then((r) => r.count),
    ),
  )
  return Object.fromEntries(COLUMNS.map((c, i) => [c, counts[i]])) as Record<BoardColumnId, number>
}

function waitingRow(i: InboxItem, projectName: (id: number) => string) {
  const where = ` in ${projectName(i.project)}`
  switch (i.kind) {
    case "prompt":
    case "prompt_withdrawn":
      return { icon: <ShieldAlertIcon />, title: i.question.split("\n")[0], meta: `${i.agent_label ?? `Agent ${i.agent}`}${where}`, cta: "Answer", to: "/v3/inbox" }
    case "decision":
      return { icon: <ScaleIcon />, title: i.question, meta: `${i.asked_by_label}${where}`, cta: "Decide", to: "/v3/inbox" }
    case "review_request":
      return { icon: <EyeIcon />, title: `Review #${i.task}`, meta: `${i.requester_label}${where}`, cta: "Open review", to: "/v3/inbox" }
    case "daily_update":
      return { icon: <CalendarClockIcon />, title: `Daily update for ${i.date}`, meta: `${i.drafted_by_label}${where}`, cta: "Review", to: "/v3/inbox" }
    case "question":
      return { icon: <HelpCircleIcon />, title: i.snippet, meta: `${i.sender_label}${where}`, cta: "Answer", to: "/v3/inbox" }
    case "mention":
      return { icon: <AtSignIcon />, title: i.snippet, meta: `${i.sender_label}${where}`, cta: "Open chat", to: "/v3/inbox" }
  }
}

export function HomePage() {
  const { projects, currentUser, chooseProject } = useWorkspace()
  const navigate = useNavigate()
  const now = useLivenessNow()
  const shown = projects.slice(0, MAX_PROJECTS)
  const ids = shown.map((p) => Number(p.id)).filter((n) => Number.isFinite(n))
  const idsKey = ids.join(",")
  const monday = weekStart(new Date(now))
  const projectName = (id: number) => projects.find((p) => p.id === String(id))?.name ?? `project ${id}`

  const inbox = useLoad("home-inbox", (s) => fetchInbox("needs_you", null, s))
  const counts = useLoad(idsKey ? `counts|${idsKey}` : null, async () => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await columnCounts(id)] as const))))
  const agents = useLoad("home-agents", () =>
    taskflowApi
      .from(taskflowTables.agents)
      .orderBy("project", "display_name")
      .param("page_size", 100)
      .list()
      .then((r) => (r.results as TaskflowAgent[]).filter((a) => a.status !== "revoked")),
  )
  const mine = useLoad(currentUser ? `mine|${currentUser.id}` : null, () =>
    taskflowApi
      .from(taskflowTables.tasks)
      .filter({ assigned_user: currentUser!.id })
      .param("status__in", "not_started,in_progress,partial_done,blocked,paused")
      .orderBy("-updated_at", "-id")
      .param("page_size", 12)
      .param("fields", "id,title,status,project,updated_at")
      .list()
      .then((r) => r.results as TaskflowTask[]),
  )
  const spend = useLoad(idsKey ? `spend|${idsKey}|${monday.toDateString()}` : null, async (s) => {
    const out = await Promise.all(ids.map((id) => fetchUsage(id, { from: monday, group: "agent" }, s).then((u) => [id, u] as const).catch(() => [id, null] as const)))
    return Object.fromEntries(out) as Record<number, UsageResponse | null>
  })

  const online = (agents.data ?? []).filter((a) => isAgentOnline(a.id, agents.data ?? [], [], now))
  const weekTotal = Object.values(spend.data ?? {}).reduce((n, u) => n + (u?.total.cost_micros ?? 0), 0)
  const agentSpend = (a: TaskflowAgent) => spend.data?.[a.project]?.groups.find((g) => g.key === String(a.id))?.usage.cost_micros ?? 0
  const name = firstName(currentUser?.username)
  const openProject = (id: string, to = "/v3/overview") => {
    chooseProject(id)
    navigate(to)
  }

  return (
    <V3Shell
      title="Home"
      actions={
        <Button size="sm" render={<Link to="/v3/projects/new" />} nativeButton={false}>
          <PlusIcon />
          <span className="hidden sm:inline">New project</span>
        </Button>
      }
    >
      <div className="space-y-6">
        <div>
          <p className="text-sm text-muted-foreground">{new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
          <h2 className="mt-0.5 text-2xl font-semibold tracking-tight">
            {greeting(new Date(now).getHours())}
            {name ? `, ${name}` : ""}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{homeLine(online.length, new Set(online.map((a) => a.project)).size || projects.length, inbox.data?.counts.needs_you ?? 0)}</p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="min-w-0 rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Waiting on you</h3>
              {inbox.data?.counts.needs_you ? <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums">{inbox.data.counts.needs_you}</span> : null}
              <Link to="/v3/inbox" className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                See all
              </Link>
            </div>
            {inbox.loading ? (
              <Skeleton className="m-4 h-16" />
            ) : inbox.data?.items.length ? (
              <ul className="divide-y divide-border">
                {inbox.data.items.slice(0, 5).map((i, k) => {
                  const r = waitingRow(i, projectName)
                  return (
                    <li key={k} className="flex items-center gap-3 px-4 py-3">
                      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{r.icon}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{r.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {r.meta}, {timeAgo(i.at, now) ?? ""}
                        </p>
                      </div>
                      <Button size="sm" variant="outline" render={<Link to={r.to} />} nativeButton={false}>
                        {r.cta}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">{inbox.error ? "Couldn't load what's waiting on you." : "Nothing is waiting on you."}</p>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold">Spend this week</h3>
            </div>
            {spend.loading ? (
              <Skeleton className="mt-3 h-24" />
            ) : (
              <>
                <p className="mt-2 text-sm">
                  <span className="text-xl font-semibold tabular-nums">{money(weekTotal)}</span> <span className="text-muted-foreground">since Monday</span>
                </p>
                <ul className="mt-3 space-y-2 text-sm">
                  {shown
                    .map((p) => ({ p, cost: spend.data?.[Number(p.id)]?.total.cost_micros ?? 0 }))
                    .filter((x) => x.cost > 0)
                    .sort((a, b) => b.cost - a.cost)
                    .map(({ p, cost }) => (
                      <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_5rem_4rem] items-center gap-2">
                        <span className="truncate">{p.name}</span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <span className="block h-full rounded-full bg-chart-1" style={{ width: `${(cost / (weekTotal || 1)) * 100}%` }} />
                        </span>
                        <span className="text-right tabular-nums">{money(cost)}</span>
                      </li>
                    ))}
                </ul>
                {weekTotal === 0 ? <p className="mt-1 text-xs text-muted-foreground">No usage reported this week.</p> : null}
                <p className="mt-3 text-xs text-muted-foreground">Self-reported by agents, for awareness.</p>
              </>
            )}
          </section>
        </div>

        <section>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <h3 className="text-sm font-semibold">Your projects</h3>
            <span className="text-xs text-muted-foreground">{projects.length}</span>
            <ul className="ml-auto flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Progress bar key">
              {COLUMNS.map((c) => (
                <li key={c} className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", BAR[c])} />
                  {COLUMN_LABEL[c]}
                </li>
              ))}
            </ul>
          </div>
          {projects.length ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((p) => {
                const c = counts.data?.[Number(p.id)]
                const all = c ? COLUMNS.reduce((n, k) => n + c[k], 0) : 0
                const open = c ? c.not_started + c.in_progress + c.review + c.blocked : null
                const team = (agents.data ?? []).filter((a) => a.project === Number(p.id)).slice(0, 4)
                return (
                  <button key={p.id} type="button" onClick={() => openProject(p.id)} className="rounded-xl border border-border bg-card p-4 text-left hover:border-ring">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold uppercase">{p.name.slice(0, 2)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{p.name}</p>
                        <p className="text-xs text-muted-foreground">{p.status === "archived" ? "Archived" : `${p.members} ${p.members === 1 ? "member" : "members"}`}</p>
                      </div>
                      <span className="flex -space-x-1.5">
                        {team.map((a) => (
                          <ActorAvatar key={a.id} model={guessModel(a.runtime) ?? guessModel(a.display_name)} name={a.display_name} status={isAgentOnline(a.id, agents.data ?? [], [], now) ? "running" : "offline"} size="sm" />
                        ))}
                      </span>
                    </div>
                    <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={c ? COLUMNS.map((k) => `${c[k]} ${COLUMN_LABEL[k]}`).join(", ") : "Loading"}>
                      {c && all ? COLUMNS.map((k) => (c[k] ? <span key={k} className={BAR[k]} style={{ width: `${(c[k] / all) * 100}%` }} /> : null)) : null}
                    </div>
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Open</dt>
                        <dd className="text-sm font-medium tabular-nums">{open ?? "…"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">In review</dt>
                        <dd className="text-sm font-medium tabular-nums">{c ? c.review : "…"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">This month</dt>
                        <dd className="text-sm font-medium tabular-nums">{spend.data?.[Number(p.id)] ? money(spend.data[Number(p.id)]!.month.spend_micros) : "—"}</dd>
                      </div>
                    </dl>
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              You&apos;re not in any project yet.{" "}
              <Link to="/v3/projects/new" className="underline underline-offset-4">
                Create one
              </Link>
            </p>
          )}
          {projects.length > MAX_PROJECTS ? <p className="mt-2 text-xs text-muted-foreground">Showing {MAX_PROJECTS} of {projects.length}. Switch projects from the sidebar for the rest.</p> : null}
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-baseline border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Assigned to you</h3>
              <span className="ml-2 text-xs text-muted-foreground">all projects</span>
            </div>
            {mine.loading ? (
              <Skeleton className="m-4 h-16" />
            ) : mine.data?.length ? (
              <ul className="divide-y divide-border text-sm">
                {mine.data.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => openProject(String(t.project), `/v3/tasks/${t.id}`)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/50">
                      <StatusChip tone={t.status === "in_progress" ? "running" : t.status === "partial_done" ? "review" : t.status === "blocked" || t.status === "paused" ? "blocked" : "idle"} label="" />
                      <span className="min-w-0 flex-1 truncate">{t.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{projectName(t.project)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">Nothing open is assigned to you.</p>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Your agents</h3>
              <span className="text-xs text-muted-foreground">this week</span>
            </div>
            {agents.loading ? (
              <Skeleton className="m-4 h-16" />
            ) : agents.data?.length ? (
              <ul className="divide-y divide-border text-sm">
                {[...agents.data]
                  .sort((a, b) => Number(isAgentOnline(b.id, agents.data!, [], now)) - Number(isAgentOnline(a.id, agents.data!, [], now)) || agentSpend(b) - agentSpend(a))
                  .slice(0, 8)
                  .map((a) => {
                    const on = isAgentOnline(a.id, agents.data!, [], now)
                    return (
                      <li key={a.id}>
                        <button type="button" onClick={() => openProject(String(a.project), `/v3/agents/${a.id}`)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/50">
                          <ActorAvatar model={guessModel(a.runtime) ?? guessModel(a.display_name)} name={a.display_name} status={on ? "running" : "offline"} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{a.display_name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {projectName(a.project)}, {on ? "online" : a.last_seen_at ? `seen ${timeAgo(a.last_seen_at, now)}` : "never connected"}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs tabular-nums">{agentSpend(a) ? money(agentSpend(a)) : ""}</span>
                        </button>
                      </li>
                    )
                  })}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                No agents yet.{" "}
                <Link to="/v3/agents/new" className="underline underline-offset-4">
                  Add one
                </Link>
              </p>
            )}
          </section>
        </div>
      </div>
    </V3Shell>
  )
}
