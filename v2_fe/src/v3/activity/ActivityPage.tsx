/// Activity (design: activity.html, activity--empty): every task change,
/// review, tool call and log line in the project, newest first, by day.
///
/// The page pages the feed itself (server-sized pages, "Show older" appends),
/// with the actor and type filters applied server-side so they cover the whole
/// feed. Live rows come from App's one realtime stream (live.taskActivity) and
/// are merged in under the same filters; nothing here opens a stream. Search
/// is client-side over what's loaded, as in v2 (REST can't OR across fields).
import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ActivityIcon, BotIcon, SearchIcon, UserIcon, WrenchIcon } from "lucide-react"

import type { TaskflowTaskActivity } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { fetchActivityActions, fetchTaskTitles, taskflowApi, taskflowTables } from "@/lib/taskflow-api"
import { toast } from "sonner"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { groupByDay, liveRowFits, matchesSearch, mergeActivity, verbOf, type ActorFilter } from "./activity-logic"

const ANY = "any"

async function fetchPage(project: number, page: number, actor: ActorFilter, action: string | null) {
  const res = await taskflowApi
    .from(taskflowTables.taskActivity)
    .filter({ project, ...(actor !== "all" ? { actor_kind: actor } : {}), ...(action ? { action } : {}) })
    .orderBy("-created_at", "-id")
    .param("page", page)
    .list()
  return { rows: res.results as TaskflowTaskActivity[], totalPages: res.total_pages }
}

function clock(at: string | null) {
  if (!at) return ""
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export function ActivityPage() {
  const { live, projectTasks } = useWorkspace()
  const now = useLivenessNow()
  const project = live?.project.id ?? null
  const [actor, setActor] = useState<ActorFilter>("all")
  const [action, setAction] = useState<string | null>(null)
  const [actions, setActions] = useState<string[]>([])
  const [search, setSearch] = useState("")
  // Keyed by the filters it was loaded under, so a filter change shows the
  // skeleton at once without a synchronous reset inside the effect.
  const key = `${project}|${actor}|${action ?? ""}`
  const [feed, setFeed] = useState<{ key: string; rows: TaskflowTaskActivity[]; page: number; totalPages: number; error: string | null } | null>(null)
  const current = feed?.key === key ? feed : null
  const rows = current && !current.error ? current.rows : null
  const page = current?.page ?? 1
  const totalPages = current?.totalPages ?? 1
  const error = current?.error ?? null
  const [loadingMore, setLoadingMore] = useState(false)
  const [titles, setTitles] = useState<Record<number, string>>({})
  // Task ids already asked for; read and written only in callbacks.
  const requested = useRef(new Set<number>())

  const rememberTitles = (list: TaskflowTaskActivity[]) => {
    const known = new Set(projectTasks.map((t) => Number(t.id)))
    const missing = [...new Set(list.map((r) => r.task).filter((t): t is number => t != null && !known.has(t) && !requested.current.has(t)))]
    if (!missing.length) return
    for (const t of missing) requested.current.add(t)
    void fetchTaskTitles(missing)
      .then((ts) => setTitles((cur) => ({ ...cur, ...Object.fromEntries(ts.map((t) => [t.id, t.title])) })))
      .catch(() => {})
  }

  useEffect(() => {
    if (!project) return
    let live = true
    void fetchActivityActions(project)
      .then((a) => live && setActions(a))
      .catch(() => live && setActions([]))
    return () => {
      live = false
    }
  }, [project])

  useEffect(() => {
    if (!project) return
    let alive = true
    const k = `${project}|${actor}|${action ?? ""}`
    fetchPage(project, 1, actor, action)
      .then(({ rows: r, totalPages: t }) => {
        if (!alive) return
        setFeed({ key: k, rows: r, page: 1, totalPages: t, error: null })
        rememberTitles(r)
      })
      .catch((e: unknown) => alive && setFeed({ key: k, rows: [], page: 1, totalPages: 1, error: e instanceof Error ? e.message : "Couldn't load the activity." }))
    return () => {
      alive = false
    }
    // rememberTitles reads refs only; re-running on its identity would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, actor, action])

  const older = async () => {
    if (!project || loadingMore || !current) return
    setLoadingMore(true)
    try {
      const next = await fetchPage(project, page + 1, actor, action)
      setFeed((f) => (f && f.key === key ? { ...f, rows: [...f.rows, ...next.rows], page: f.page + 1, totalPages: next.totalPages } : f))
      rememberTitles(next.rows)
    } catch (e) {
      toast.error("Couldn't load older activity", { description: e instanceof Error ? e.message : undefined })
    } finally {
      setLoadingMore(false)
    }
  }

  const titleOf = (task: number | null) => (task == null ? undefined : (projectTasks.find((t) => Number(t.id) === task)?.title ?? titles[task]))

  const shown = useMemo(() => {
    if (!rows || !project) return []
    const oldest = page < totalPages && rows.length ? (rows[rows.length - 1].created_at ?? null) : null
    const liveRows = (live?.taskActivity ?? []).filter((r) => liveRowFits(r, project, actor, action, oldest))
    return mergeActivity(rows, liveRows).filter((r) => matchesSearch(r, titleOf(r.task), search))
    // titleOf closes over projectTasks/titles, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, live?.taskActivity, project, actor, action, search, page, totalPages, projectTasks, titles])

  const groups = groupByDay(shown, now)
  const filtered = actor !== "all" || action != null || search.trim() !== ""

  return (
    <V3Shell title="Activity">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          {(
            [
              { id: "all", label: "Everything", icon: null },
              { id: "agent", label: "Agents", icon: <BotIcon /> },
              { id: "user", label: "People", icon: <UserIcon /> },
            ] as const
          ).map((f) => (
            <Button key={f.id} variant={actor === f.id ? "secondary" : "ghost"} size="sm" aria-pressed={actor === f.id} onClick={() => setActor(f.id)}>
              {f.icon}
              {f.label}
            </Button>
          ))}
          <Select items={{ [ANY]: "Type: any", ...Object.fromEntries(actions.map((a) => [a, a.replace(/_/g, " ")])) }} value={action ?? ANY} onValueChange={(v) => setAction(!v || v === ANY ? null : String(v))}>
            <SelectTrigger className="h-8 w-auto" aria-label="Type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Type: any</SelectItem>
              {actions.map((a) => (
                <SelectItem key={a} value={a}>
                  {a.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="relative ml-auto w-full sm:w-56">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search activity" aria-label="Search activity" className="h-8 pl-8" />
          </label>
        </div>

        {error ? <p className="mt-6 text-sm text-destructive">{error}</p> : null}

        {!rows && !error ? (
          <div className="mt-6 space-y-3" aria-busy="true" aria-label="Loading activity">
            {[0, 1, 2, 3, 4].map((k) => (
              <Skeleton key={k} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : null}

        {rows && shown.length === 0 ? (
          filtered ? (
            <p className="mt-10 text-center text-sm text-muted-foreground">Nothing matches these filters{page < totalPages ? " in what's loaded" : ""}.</p>
          ) : (
            <Empty className="mt-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ActivityIcon />
                </EmptyMedia>
                <EmptyTitle>Nothing has happened yet</EmptyTitle>
                <EmptyDescription>Every task change, review, tool call and message from people and agents lands here as it happens.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button render={<Link to="/v3/agents/new" />} nativeButton={false}>
                  <BotIcon />
                  Connect an agent
                </Button>
              </EmptyContent>
            </Empty>
          )
        ) : null}

        {groups.map((g) => (
          <section key={g.key} aria-label={g.label}>
            <h2 className="mt-6 mb-2 text-sm font-semibold">{g.label}</h2>
            <ol className="relative ml-3 space-y-1 border-l border-border pl-5">
              {g.rows.map((r) => {
                const { verb, tool } = verbOf(r.action)
                const title = titleOf(r.task)
                const body = r.body_markdown?.trim()
                return (
                  <li key={r.id} className="relative rounded-lg px-2 py-2 hover:bg-muted/50">
                    <span className="absolute top-2 -left-8">
                      {r.actor_kind === "system" ? (
                        <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
                          <ActivityIcon className="size-3.5" />
                        </span>
                      ) : (
                        <ActorAvatar model={r.actor_kind === "agent" ? guessModel(r.actor_label) : null} name={r.actor_label || "Someone"} size="sm" />
                      )}
                    </span>
                    <p className="text-sm">
                      <span className="font-medium">{r.actor_label || "Someone"}</span> {tool ? (body ? body.split("\n")[0] : `ran ${verb}`) : verb}
                      {r.task != null ? (
                        <>
                          {" "}
                          <Link to={`/v3/tasks/${r.task}`} className="font-medium hover:underline">
                            #{r.task}
                          </Link>
                          {title ? <span className="text-muted-foreground"> {title}</span> : null}
                        </>
                      ) : null}
                    </p>
                    {body && (!tool || body.includes("\n")) ? <p className="mt-0.5 line-clamp-2 text-sm whitespace-pre-line text-muted-foreground">{tool ? body.split("\n").slice(1).join("\n") : body}</p> : null}
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                      <time dateTime={r.created_at ?? undefined}>{clock(r.created_at)}</time>
                      {tool ? (
                        <span className="inline-flex items-center gap-1 font-mono">
                          <WrenchIcon className="size-3" aria-hidden />
                          {r.action}
                        </span>
                      ) : null}
                    </p>
                  </li>
                )
              })}
            </ol>
          </section>
        ))}

        {rows && page < totalPages ? (
          <div className="mt-6 flex justify-center">
            <Button variant="outline" size="sm" onClick={() => void older()} disabled={loadingMore}>
              {loadingMore ? <Spinner /> : null}
              {loadingMore ? "Loading older activity" : "Show older"}
            </Button>
          </div>
        ) : null}
      </div>
    </V3Shell>
  )
}
