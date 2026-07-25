import * as React from "react"
import { AlertCircleIcon, LayoutDashboardIcon, Loader2 as LoaderIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import {
  fetchProjectStats,
  type MemberCount,
  type MemberSeconds,
  type ProjectStats,
  type StatsRange,
} from "@/lib/taskflow-api"
import { barModel, fillDaySeries, formatWorkedTime } from "@/lib/dashboard-stats"

const RANGE_OPTIONS: { value: StatsRange; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
]

/** "2026-07-24" → "Jul 24". Parsed as UTC so the label matches the day bucket
 *  the backend computed, regardless of the viewer's local timezone. */
function formatDay(day: string | undefined): string {
  if (!day) return ""
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

function findMemberSeconds(rows: MemberSeconds[], kind: "user" | "agent", id: number): number | null {
  const hit = rows.find((row) => row.kind === kind && row.id === id)
  return hit ? hit.seconds : null
}

export function OverviewPage({
  projectId,
  currentUserId,
}: {
  projectId: number | null
  currentUserId: number | null
}) {
  const [range, setRange] = React.useState<StatsRange>("30d")
  const [data, setData] = React.useState<ProjectStats | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Bumped by the "Try again" button to re-run the effect without touching `range`.
  const [retryToken, setRetryToken] = React.useState(0)

  React.useEffect(() => {
    // Nothing to fetch, and the "no project" branch below never reads
    // data/error/loading — bail without touching state.
    if (projectId == null) return
    let active = true
    // Every setState call lives inside the async body (not the effect's
    // synchronous top level) — same shape as ProfilePage's load effect.
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const stats = await fetchProjectStats(projectId, range)
        if (!active) return
        setData(stats)
      } catch (err) {
        if (!active) return
        setError(err instanceof Error ? err.message : "Could not load dashboard stats.")
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [projectId, range, retryToken])

  if (projectId == null) {
    return (
      <section className="grid place-items-center p-4 sm:p-8">
        <div className="w-full max-w-xl rounded-xl border bg-card p-8 text-center shadow-sm">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
            <LayoutDashboardIcon className="size-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold">No project selected</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            Select a project to see how much time has been worked, tasks closed over time, and who's most active.
          </p>
        </div>
      </section>
    )
  }

  const yourSeconds = currentUserId != null && data ? findMemberSeconds(data.worked_per_member, "user", currentUserId) ?? 0 : 0

  return (
    <section className="grid gap-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 shadow-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Insights</p>
          <h1 className="mt-1 text-2xl font-semibold">Dashboard</h1>
        </div>
        <div className="flex items-center gap-1 rounded-full border bg-background p-1" role="group" aria-label="Time range">
          {RANGE_OPTIONS.map((option) => {
            const active = range === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setRange(option.value)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/40 p-8 text-center">
          <AlertCircleIcon className="size-6 text-destructive" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={() => setRetryToken((n) => n + 1)}>
            <RefreshCwIcon />
            Try again
          </Button>
        </div>
      ) : loading && !data ? (
        <OverviewSkeleton />
      ) : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Your time" value={formatWorkedTime(yourSeconds)} />
            <StatTile label="Tasks done" value={String(data.totals.closed_in_range)} />
            <StatTile label="Tasks open" value={String(data.totals.open_now)} />
            <StatTile label="Active members" value={String(data.totals.active_members)} />
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <Panel title="Tasks closed over time" subtitle={rangeSubtitle(range)} empty={data.tasks_closed_by_day.length === 0}>
              {/* `generated_at` is the server's aggregation instant — using it
                  (rather than a fresh `Date.now()` at render time) keeps the
                  fill deterministic across re-renders of the same response. */}
              <Columns rows={fillDaySeries(data.tasks_closed_by_day, range, Date.parse(data.generated_at))} />
            </Panel>

            <Panel title="Time worked per member" subtitle="From completed task sessions" empty={data.worked_per_member.length === 0}>
              <div className="space-y-1.5">
                {barModel(data.worked_per_member, (r) => r.seconds).map((row) => (
                  <HBar
                    key={`${row.kind}-${row.id}`}
                    label={row.label}
                    pct={row.pct}
                    valueLabel={formatWorkedTime(row.seconds)}
                    highlighted={row.kind === "user" && currentUserId != null && row.id === currentUserId}
                  />
                ))}
              </div>
            </Panel>

            <Panel title="Activity per tool" subtitle="Actions logged in range" empty={data.activity_by_tool.length === 0}>
              <div className="space-y-1.5">
                {barModel(data.activity_by_tool, (r) => r.count).map((row) => (
                  <HBar key={row.tool} label={row.tool} pct={row.pct} valueLabel={String(row.count)} />
                ))}
              </div>
            </Panel>

            <Panel title="Most active" subtitle="By number of actions" empty={data.activity_by_member.length === 0}>
              <ol className="divide-y">
                {data.activity_by_member.map((row, index) => (
                  <LeaderboardRow
                    key={`${row.kind}-${row.id}`}
                    rank={index + 1}
                    row={row}
                    workedSeconds={findMemberSeconds(data.worked_per_member, row.kind, row.id)}
                    highlighted={row.kind === "user" && currentUserId != null && row.id === currentUserId}
                  />
                ))}
              </ol>
            </Panel>
          </div>
        </>
      ) : null}
    </section>
  )
}

function rangeSubtitle(range: StatsRange): string {
  switch (range) {
    case "7d":
      return "Last 7 days"
    case "30d":
      return "Last 30 days"
    case "90d":
      return "Last 90 days"
    case "all":
      return "All time"
  }
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  )
}

function Panel({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string
  subtitle?: string
  empty?: boolean
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      <div className="mt-4">
        {empty ? (
          <div className="rounded-md border border-dashed bg-muted/40 p-6 text-center text-sm text-muted-foreground">
            No activity in this range yet.
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  )
}

/** Horizontal bar: label, a track scaled to the row's `pct` (0-100, already
 *  scaled to the panel's max by `barModel`), and a value at the tip. The
 *  current user's row gets a primary ring + "You" tag rather than a distinct
 *  hue — identity here is a highlight, not a second series. */
function HBar({
  label,
  pct,
  valueLabel,
  highlighted,
}: {
  label: string
  pct: number
  valueLabel: string
  highlighted?: boolean
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-1.5 py-1",
        highlighted && "bg-primary/5 ring-1 ring-primary/40"
      )}
      title={`${label}: ${valueLabel}`}
    >
      <span className={cn("w-24 shrink-0 truncate text-xs font-medium sm:w-28", highlighted ? "text-primary" : "text-foreground")}>
        {label}
        {highlighted ? <span className="ml-1 text-[0.65rem] font-semibold text-primary/80">You</span> : null}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", highlighted ? "bg-primary" : "bg-primary/60")}
          style={{ width: `${pct > 0 ? Math.max(pct, 4) : 0}%` }}
        />
      </div>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{valueLabel}</span>
    </div>
  )
}

/** Day-series column chart. Bars grow from a fixed-height baseline (percentage
 *  heights need a definite parent height, hence the explicit `h-28`); the
 *  peak day is called out directly since labeling every column would collide
 *  once the range spans dozens of days. */
function Columns({ rows }: { rows: { day: string; count: number }[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0)
  const peakIndex = rows.reduce((best, row, index) => (row.count > rows[best].count ? index : best), 0)

  return (
    <div>
      <div
        className="flex h-28 items-end gap-[3px]"
        role="img"
        aria-label={max > 0 ? `Tasks closed per day, peak ${max} on ${formatDay(rows[peakIndex]?.day)}` : "No tasks closed in this range"}
      >
        {rows.map((row, index) => {
          const pct = max > 0 ? Math.max((row.count / max) * 100, row.count > 0 ? 6 : 3) : 3
          const isPeak = max > 0 && row.count === max
          return (
            <div
              key={row.day}
              className="group relative min-w-[2px] flex-1"
              title={`${formatDay(row.day)}: ${row.count} closed`}
            >
              <div
                className={cn(
                  "w-full rounded-t-[3px] transition-colors group-hover:bg-primary",
                  isPeak ? "bg-primary" : row.count > 0 ? "bg-primary/50" : "bg-muted"
                )}
                style={{ height: `${pct}%` }}
              />
              {index === peakIndex && max > 0 ? <span className="sr-only">peak</span> : null}
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[0.65rem] text-muted-foreground">
        <span>{formatDay(rows[0]?.day)}</span>
        {max > 0 ? (
          <span className="font-medium text-foreground">
            Peak {max} on {formatDay(rows[peakIndex]?.day)}
          </span>
        ) : null}
        <span>{formatDay(rows[rows.length - 1]?.day)}</span>
      </div>
    </div>
  )
}

function LeaderboardRow({
  rank,
  row,
  workedSeconds,
  highlighted,
}: {
  rank: number
  row: MemberCount
  workedSeconds: number | null
  highlighted?: boolean
}) {
  return (
    <li className={cn("flex items-center gap-3 py-2", highlighted && "-mx-1.5 rounded-md bg-primary/5 px-1.5 ring-1 ring-primary/40")}>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
        {rank}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-sm font-medium", highlighted && "text-primary")}>
        {row.label}
        {highlighted ? <span className="ml-1 text-[0.65rem] font-semibold text-primary/80">You</span> : null}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {workedSeconds != null ? formatWorkedTime(workedSeconds) : "—"}
      </span>
      <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums">{row.count}</span>
    </li>
  )
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-background px-3 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-card p-4 shadow-sm">
            <Skeleton className="h-4 w-40" />
            <div className="mt-4 flex items-center justify-center gap-1.5 text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              <span className="text-xs">Loading…</span>
            </div>
            <Skeleton className="mt-3 h-24 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
