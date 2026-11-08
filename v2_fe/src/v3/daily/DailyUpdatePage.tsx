/// Daily update (design: daily-update.html): the day's drafted summary,
/// editable, then posted to the project room or skipped (#1118).
///
/// /v3/daily-update opens the newest update; /v3/daily-update/:date opens
/// one day. Everyone in the project can read; only owners and admins edit,
/// draft again, skip or post, and the page hides those controls for anyone
/// else (the server enforces it too). Edits carry the version they started
/// from, so a concurrent change answers 409 and the page reloads it rather
/// than overwriting.
import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { CalendarClockIcon, PencilIcon, RefreshCwIcon, SendIcon } from "lucide-react"
import { toast } from "sonner"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import {
  DailyConflict,
  draftDailyNow,
  editDailyUpdate,
  getDailySettings,
  getDailyUpdate,
  listDailyUpdates,
  postDailyUpdate,
  redraftDailyUpdate,
  skipDailyUpdate,
  type DailySettings,
  type DailyUpdate,
  type DailyUpdateSummary,
} from "./daily-api"
import { STATUS_LABEL, isIsoDate, longDate, todayIn } from "./daily-logic"

function clock(at: string | null, tz: string | undefined) {
  if (!at) return null
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(tz ? { timeZone: tz, timeZoneName: "short" } : {}) })
  } catch {
    return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  }
}

export function DailyUpdatePage() {
  const { live, currentUser } = useWorkspace()
  const { date: routeDate } = useParams()
  const navigate = useNavigate()
  const now = useLivenessNow()
  const project = live?.project.id ?? null
  const role = live?.members.find((m) => m.user === currentUser?.id)?.role
  const canManage = role === "owner" || role === "admin"

  const [list, setList] = useState<{ project: number; rows: DailyUpdateSummary[] } | null>(null)
  const [settings, setSettings] = useState<DailySettings | null>(null)
  const [loaded, setLoaded] = useState<{ date: string; u: DailyUpdate | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState<null | "save" | "post" | "skip" | "redraft" | "draft">(null)
  const [confirmRedraft, setConfirmRedraft] = useState(false)
  const [tick, setTick] = useState(0)

  const rows = list?.project === project ? list.rows : null
  const today = todayIn(settings?.timezone, new Date(now))
  const date = isIsoDate(routeDate) ? routeDate : (rows?.[0]?.date ?? null)
  const update = loaded && loaded.date === date ? loaded.u : undefined

  const reloadAll = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!project) return
    const ctl = new AbortController()
    listDailyUpdates(project, ctl.signal)
      .then((r) => setList({ project, rows: r }))
      .catch((e: unknown) => !ctl.signal.aborted && setError(e instanceof Error ? e.message : "Couldn't load the daily updates."))
    getDailySettings(project, ctl.signal)
      .then(setSettings)
      .catch(() => {})
    return () => ctl.abort()
  }, [project, tick])

  useEffect(() => {
    if (!project || !date) return
    const ctl = new AbortController()
    getDailyUpdate(project, date, ctl.signal)
      .then((u) => setLoaded({ date, u }))
      .catch((e: unknown) => !ctl.signal.aborted && setError(e instanceof Error ? e.message : "Couldn't load the update."))
    return () => ctl.abort()
  }, [project, date, tick])

  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<DailyUpdate>, done: string) => {
    setBusy(what)
    try {
      const u = await fn()
      setLoaded({ date: u.date, u })
      if (what === "save") setEditing(false)
      toast.success(done)
      reloadAll()
      if (u.date !== date) navigate(`/v3/daily-update/${u.date}`)
    } catch (e) {
      if (e instanceof DailyConflict) {
        setEditing(false)
        reloadAll()
      }
      toast.error(e instanceof Error ? e.message : "Something went wrong.")
    } finally {
      setBusy(null)
    }
  }

  const agentName = settings?.drafting_agent ? (live?.agents.find((a) => a.id === settings.drafting_agent)?.display_name ?? `agent ${settings.drafting_agent}`) : null
  const roomName = settings?.post_channel ? live?.agentChannels.find((c) => c.id === settings.post_channel)?.title : null
  const postLabel = roomName ? `Post to ${roomName}` : "Post to the project room"
  const isDraft = update?.status === "draft"

  const actions =
    canManage && update && isDraft && !editing ? (
      <>
        <Button variant="outline" size="sm" onClick={() => (update.edit_count > 0 ? setConfirmRedraft(true) : void run("redraft", () => redraftDailyUpdate(project!, update.date), "Drafted again"))} disabled={busy !== null}>
          {busy === "redraft" ? <Spinner /> : <RefreshCwIcon />}
          <span className="hidden sm:inline">Draft again</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void run("skip", () => skipDailyUpdate(project!, update.date), "Skipped for today")} disabled={busy !== null}>
          Skip
        </Button>
        <Button size="sm" onClick={() => void run("post", () => postDailyUpdate(project!, update.date), "Posted")} disabled={busy !== null}>
          {busy === "post" ? <Spinner /> : <SendIcon />}
          {postLabel}
        </Button>
      </>
    ) : null

  const empty = rows && rows.length === 0 && !isIsoDate(routeDate)

  return (
    <V3Shell title="Daily update" actions={actions}>
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

      {empty ? (
        <Empty className="mt-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarClockIcon />
            </EmptyMedia>
            <EmptyTitle>No daily updates yet</EmptyTitle>
            <EmptyDescription>
              {settings?.enabled
                ? `One is drafted every day at ${settings.local_time} (${settings.timezone})${agentName ? ` by ${agentName}` : ""}, and you're asked to review it in the inbox.`
                : "A daily update summarises the day's activity, task changes and reviews for the team. Owners and admins can draft one now."}
            </EmptyDescription>
          </EmptyHeader>
          {canManage ? (
            <EmptyContent>
              <Button onClick={() => void run("draft", () => draftDailyNow(project!, today), "Drafted")} disabled={busy !== null || !project}>
                {busy === "draft" ? <Spinner /> : null}
                Draft today&apos;s update
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            {update === undefined && !error ? (
              <Skeleton className="h-96 w-full rounded-xl" />
            ) : update === null ? (
              <Empty className="mt-6 rounded-xl border border-dashed">
                <EmptyHeader>
                  <EmptyTitle>No update for {date ? longDate(date) : "this day"}</EmptyTitle>
                  <EmptyDescription>Nothing was drafted that day.</EmptyDescription>
                </EmptyHeader>
                {canManage && date && date >= todayIn(settings?.timezone, new Date(now - 7 * 86400000)) && date <= today ? (
                  <EmptyContent>
                    <Button onClick={() => void run("draft", () => draftDailyNow(project!, date), "Drafted")} disabled={busy !== null}>
                      {busy === "draft" ? <Spinner /> : null}
                      Draft it now
                    </Button>
                  </EmptyContent>
                ) : null}
              </Empty>
            ) : update ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-semibold tracking-tight">{longDate(update.date)}</h2>
                  <Badge variant={isDraft ? "outline" : "secondary"}>{STATUS_LABEL[update.status]}</Badge>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    {update.server_drafted ? null : <ActorAvatar model={guessModel(update.drafted_by_label)} name={update.drafted_by_label} size="xs" />}
                    Drafted by {update.drafted_by_label}
                    {update.window_end ? ` at ${clock(update.window_end, settings?.timezone)}` : ""}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {isDraft
                    ? `Written from the day's activity, task changes and reviews.${canManage ? " Edit anything; nothing is posted until you press Post." : ""}`
                    : update.status === "posted"
                      ? `Posted ${clock(update.posted_at, settings?.timezone) ?? ""}.`
                      : "Skipped; it wasn't posted."}
                </p>

                <article aria-label="Daily update" className="mt-5 rounded-xl border border-border bg-card p-5">
                  {editing ? (
                    <div className="space-y-2">
                      <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={18} autoFocus className="font-mono text-sm" aria-label="Update text (markdown)" />
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy !== null}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => void run("save", () => editDailyUpdate(project!, update.date, draft, update.version), "Saved")} disabled={busy !== null || !draft.trim()}>
                          {busy === "save" ? <Spinner /> : null}
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <MarkdownRenderer content={update.body_markdown} className="text-sm [&_h2]:mt-5 [&_h2]:text-base [&_h2:first-child]:mt-0 [&_h3]:mt-4 [&_h3]:font-medium" />
                      <div className="mt-5 flex items-center justify-between border-t border-border pt-3">
                        <p className="text-xs text-muted-foreground">{update.edit_count ? `Edited ${update.edit_count} time${update.edit_count === 1 ? "" : "s"}` : "Not edited"}</p>
                        {canManage && isDraft ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDraft(update.body_markdown)
                              setEditing(true)
                            }}
                          >
                            <PencilIcon />
                            Edit text
                          </Button>
                        ) : null}
                      </div>
                    </>
                  )}
                </article>
              </>
            ) : null}
          </div>

          <aside className="min-w-0 space-y-4">
            {update ? (
              <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="src-h">
                <h2 id="src-h" className="text-sm font-medium">
                  Drafted from
                </h2>
                <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                  {(
                    [
                      ["Activity events", update.sources.activity],
                      ["Task changes", update.sources.task_changes],
                      ["Reviews", update.sources.reviews],
                      ["Pull requests", update.sources.pull_requests],
                    ] as const
                  ).map(([label, n]) => (
                    <li key={label} className="flex justify-between">
                      <span>{label}</span>
                      <span className="text-foreground tabular-nums">{n}</span>
                    </li>
                  ))}
                </ul>
                {update.window_start && update.window_end ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Events from {clock(update.window_start, settings?.timezone)} to {clock(update.window_end, settings?.timezone)}.
                  </p>
                ) : null}
              </section>
            ) : null}

            {settings ? (
              <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="sch-h">
                <h2 id="sch-h" className="text-sm font-medium">
                  Schedule
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {settings.enabled
                    ? `Drafted every day at ${settings.local_time} (${settings.timezone})${agentName ? ` by ${agentName}` : ""}. You're asked to review it in the inbox.`
                    : "Not scheduled. Owners and admins can draft one any day from this page."}
                </p>
              </section>
            ) : null}

            {rows && rows.length ? (
              <section className="overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="prev-h">
                <h2 id="prev-h" className="px-4 pt-4 text-sm font-medium">
                  Updates
                </h2>
                <ul className="mt-2 divide-y divide-border text-sm">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <Link to={`/v3/daily-update/${r.date}`} aria-current={r.date === date ? "page" : undefined} className={cn("flex justify-between gap-2 px-4 py-2.5 hover:bg-muted/50", r.date === date && "bg-accent/50 font-medium")}>
                        <span className="truncate">{longDate(r.date)}</span>
                        <span className="shrink-0 text-muted-foreground">{STATUS_LABEL[r.status]}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </aside>
        </div>
      )}

      <AlertDialog open={confirmRedraft} onOpenChange={setConfirmRedraft}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Draft it again?</AlertDialogTitle>
            <AlertDialogDescription>This throws away the edits made to this draft and rebuilds it from the day&apos;s activity.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my edits</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmRedraft(false)
                if (update && project) void run("redraft", () => redraftDailyUpdate(project, update.date), "Drafted again")
              }}
            >
              Draft again
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </V3Shell>
  )
}
