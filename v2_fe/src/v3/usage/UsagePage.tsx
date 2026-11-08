/// Usage (design: usage.html): tokens and spend over a range, by day, agent,
/// model and task, against the month's budget, with the budget alerts.
///
/// All numbers come from the usage service (#1100): self-reported token
/// counts from each agent's MCP, priced server-side. The page says so, and
/// says when reports had no price. Breakdowns are one dimension each (the API
/// groups by one key), so "per day" is tokens per day and "by model" is its
/// own list rather than a stacked chart the data can't back.
import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowDownIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { fetchTaskTitles } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { useLoad } from "../lib/use-load"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { fetchUsage, fetchUsageSettings, money, saveUsageSettings, tokens, totalTokens, type UsageSettings } from "./usage-api"
import { RANGES, cacheHitRate, change, dailySeries, toCsv, toMicros, windows, type RangeId } from "./usage-logic"

const ALL = "all"

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function BudgetDialog({ open, onOpenChange, current, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; current: UsageSettings; onSave: (s: UsageSettings) => Promise<void> }) {
  const [budget, setBudget] = useState(current.budget_micros != null ? String(current.budget_micros / 1_000_000) : "")
  const [pct, setPct] = useState(current.alert_percent != null ? String(current.alert_percent) : "80")
  const [cap, setCap] = useState(current.task_cap_micros != null ? String(current.task_cap_micros / 1_000_000) : "")
  const [pending, setPending] = useState(false)
  const save = async () => {
    const p = pct.trim() ? Number(pct) : null
    if (p != null && !(Number.isInteger(p) && p >= 1 && p <= 100)) return toast.error("Alert at: a whole percent from 1 to 100.")
    setPending(true)
    try {
      await onSave({ ...current, budget_micros: toMicros(budget), alert_percent: p, task_cap_micros: toMicros(cap) })
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(28rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Budget and caps</DialogTitle>
          <DialogDescription>For awareness: usage is what agents report, priced from the project&apos;s price list.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="ub">Monthly budget (USD)</FieldLabel>
            <Input id="ub" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="150" />
            <FieldDescription>Blank for no budget.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="up">Alert at (% of budget)</FieldLabel>
            <Input id="up" inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="80" />
          </Field>
          <Field>
            <FieldLabel htmlFor="uc">Per-task cap (USD)</FieldLabel>
            <Input id="uc" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="5" />
            <FieldDescription>Blank for no cap.</FieldDescription>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={pending}>
            {pending ? <Spinner /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function UsagePage() {
  const { live } = useWorkspace()
  const now = useLivenessNow()
  const project = live?.project.id ?? null
  const [range, setRange] = useState<RangeId>("14d")
  const [agent, setAgent] = useState<string>(ALL)
  const [editing, setEditing] = useState(false)
  // Windows are anchored to the hour so the minute tick doesn't refetch.
  const hour = Math.floor(now / 3_600_000) * 3_600_000
  const w = windows(range, new Date(hour))
  const key = project ? `${project}|${range}|${agent}|${hour}` : null
  const agentId = agent === ALL ? undefined : Number(agent)
  const q = { from: w.from, to: w.to, agent: agentId }

  const byDay = useLoad(key && `day|${key}`, (s) => fetchUsage(project!, { ...q, group: "day" }, s))
  const byAgent = useLoad(key && `agent|${key}`, (s) => fetchUsage(project!, { ...q, group: "agent" }, s))
  const byModel = useLoad(key && `model|${key}`, (s) => fetchUsage(project!, { ...q, group: "model" }, s))
  const byTask = useLoad(key && `task|${key}`, (s) => fetchUsage(project!, { ...q, group: "task" }, s))
  const before = useLoad(key && `prev|${key}`, (s) => fetchUsage(project!, { from: w.prevFrom, to: w.prevTo, agent: agentId, group: "model" }, s))
  const settings = useLoad(project ? `settings|${project}` : null, (s) => fetchUsageSettings(project!, s))

  const agentName = (id: string) => live?.agents.find((a) => String(a.id) === id)?.display_name ?? `Agent ${id}`
  const agentRuntime = (id: string) => live?.agents.find((a) => String(a.id) === id)?.runtime ?? null
  const taskIds = (byTask.data?.groups ?? []).map((g) => Number(g.key)).filter((n) => Number.isFinite(n))
  const titles = useLoad(taskIds.length ? `titles|${taskIds.join(",")}` : null, () => fetchTaskTitles(taskIds))
  const taskTitle = (id: string) => live?.tasks.find((t) => String(t.id) === id)?.title ?? titles.data?.find((t) => String(t.id) === id)?.title

  const total = byDay.data?.total
  const series = byDay.data ? dailySeries(byDay.data.groups, w.from, w.to) : []
  const peak = Math.max(1, ...series.map((d) => d.tokens))
  const delta = total && before.data ? change(total.cost_micros || totalTokens(total), before.data.total.cost_micros || totalTokens(before.data.total)) : null
  const month = byDay.data?.month
  const s = settings.data?.settings
  const canEdit = settings.data?.can_edit ?? false
  const tasks = (byTask.data?.groups ?? []).filter((g) => g.key !== "none").sort((a, b) => b.usage.cost_micros - a.usage.cost_micros || totalTokens(b.usage) - totalTokens(a.usage))
  const noTask = byTask.data?.groups.find((g) => g.key === "none")?.usage
  const topTask = tasks[0]?.usage.cost_micros || 1
  const loading = byDay.loading
  const empty = byDay.data && byDay.data.total.reports === 0

  const save = async (next: UsageSettings) => {
    if (!project) return
    try {
      await saveUsageSettings(project, next)
      toast.success("Saved")
      settings.reload()
      // The month's budget is read back with the usage, so refresh it too.
      byDay.reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save")
      throw e
    }
  }

  const exportCsv = () => {
    const g = byAgent.data?.groups ?? []
    download(`usage-by-agent-${w.from.toISOString().slice(0, 10)}-${w.to.toISOString().slice(0, 10)}.csv`, toCsv("agent", g.map((x) => ({ ...x, label: agentName(x.key) }))))
  }

  return (
    <V3Shell
      title="Usage"
      actions={
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!byAgent.data?.groups.length}>
          <ArrowDownIcon />
          Export CSV
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Time range" className="inline-flex rounded-md border border-border p-0.5 text-sm">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={range === r.id}
                onClick={() => setRange(r.id)}
                className={cn("inline-flex h-7 items-center rounded px-2.5", range === r.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {r.label}
              </button>
            ))}
          </div>
          <Select items={{ [ALL]: "All agents", ...Object.fromEntries((live?.agents ?? []).map((a) => [String(a.id), a.display_name])) }} value={agent} onValueChange={(v) => setAgent(String(v ?? ALL))}>
            <SelectTrigger className="h-8 w-auto" aria-label="Agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All agents</SelectItem>
              {(live?.agents ?? []).map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="ml-auto text-xs text-muted-foreground">Self-reported by each agent&apos;s MCP. For awareness, not billing.</p>
        </div>

        {byDay.error ? <p className="text-sm text-destructive">{byDay.error}</p> : null}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="min-w-0 rounded-xl border border-border bg-card p-4">
            {loading ? (
              <Skeleton className="h-64" />
            ) : total ? (
              <>
                <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Tokens, {RANGES.find((r) => r.id === range)?.label.toLowerCase()}</p>
                    <p className="text-2xl font-semibold tabular-nums">{tokens(totalTokens(total))}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Spend</p>
                    <p className="text-2xl font-semibold tabular-nums">{money(total.cost_micros)}</p>
                  </div>
                  {delta ? (
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">{delta}</span> than the {w.days} days before
                    </p>
                  ) : null}
                </div>
                {total.unpriced_reports ? <p className="mt-2 text-xs text-muted-foreground">{total.unpriced_reports} of {total.reports} reports had no price for their model; their cost isn&apos;t included.</p> : null}
                {empty ? (
                  <p className="mt-6 text-sm text-muted-foreground">No usage reported in this range. Agents report tokens through their MCP after each turn.</p>
                ) : (
                  <figure className="mt-5">
                    <div className="flex h-48 items-end gap-0.5 sm:gap-1" role="img" aria-label={`Tokens per day: ${series.map((d) => `${d.day} ${tokens(d.tokens)}`).join(", ")}`}>
                      {series.map((d) => (
                        <div key={d.day} className="flex h-full flex-1 flex-col justify-end" title={`${d.day}: ${tokens(d.tokens)} tokens, ${money(d.cost)}`}>
                          <div className="min-h-px rounded-t bg-chart-1" style={{ height: `${(d.tokens / peak) * 100}%` }} />
                        </div>
                      ))}
                    </div>
                    <figcaption className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                      <span>{series[0]?.day}</span>
                      <span>Tokens per day (UTC)</span>
                      <span>{series[series.length - 1]?.day}</span>
                    </figcaption>
                  </figure>
                )}
              </>
            ) : null}
          </section>

          <div className="min-w-0 space-y-4">
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">{new Date(now).toLocaleDateString(undefined, { month: "long" })} budget</h2>
                {canEdit && s ? (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                ) : null}
              </div>
              {month ? (
                month.budget_micros ? (
                  <>
                    <p className="mt-2 text-sm">
                      <span className="text-lg font-semibold tabular-nums">{money(month.spend_micros)}</span> <span className="text-muted-foreground">of {money(month.budget_micros)}</span>
                    </p>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={month.budget_micros} aria-valuenow={month.spend_micros} aria-label="Budget used">
                      <div className={cn("h-full rounded-full", month.spend_micros > month.budget_micros ? "bg-failed" : "bg-primary")} style={{ width: `${Math.min(100, (month.spend_micros / month.budget_micros) * 100)}%` }} />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">At this pace, about {money(month.projected_micros)} by the end of the month.</p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {money(month.spend_micros)} so far this month. No budget set{canEdit ? "" : "; an owner or admin can set one"}.
                  </p>
                )
              ) : (
                <Skeleton className="mt-2 h-12" />
              )}
            </section>

            {s ? (
              <section className="rounded-xl border border-border bg-card p-4">
                <h2 className="text-sm font-semibold">Alerts</h2>
                <ul className="mt-3 space-y-3 text-sm">
                  <li className="flex items-start gap-3">
                    <Switch
                      checked={s.alert_percent != null && s.budget_micros != null}
                      disabled={!canEdit || s.budget_micros == null}
                      onCheckedChange={(v) => void save({ ...s, alert_percent: v ? (s.alert_percent ?? 80) : null }).catch(() => {})}
                      aria-label="Budget alert"
                    />
                    <span className={cn(s.budget_micros == null && "text-muted-foreground")}>
                      Tell the team at <span className="font-medium tabular-nums">{s.alert_percent ?? 80}%</span> of the budget{s.budget_micros == null ? " (set a budget first)" : ""}
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <Switch checked={s.task_cap_micros != null} disabled={!canEdit} onCheckedChange={(v) => (v ? setEditing(true) : void save({ ...s, task_cap_micros: null }).catch(() => {}))} aria-label="Task cost cap" />
                    <span>
                      Flag a task that passes <span className="font-medium tabular-nums">{s.task_cap_micros != null ? money(s.task_cap_micros) : "a cap"}</span>
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <Switch checked={s.idle_alert} disabled={!canEdit} onCheckedChange={(v) => void save({ ...s, idle_alert: v }).catch(() => {})} aria-label="Idle spend alert" />
                    <span className={cn(!s.idle_alert && "text-muted-foreground")}>Warn when an idle agent keeps spending</span>
                  </li>
                </ul>
                {!canEdit ? <p className="mt-3 text-xs text-muted-foreground">Only owners and admins change these.</p> : null}
              </section>
            ) : null}
          </div>
        </div>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-2">
            <h2 className="text-sm font-semibold">By agent</h2>
            <span className="text-xs text-muted-foreground">Reported after every turn</span>
          </div>
          {byAgent.data?.groups.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2 text-left font-medium">Agent</th>
                    <th className="px-4 py-2 text-right font-medium">Input</th>
                    <th className="px-4 py-2 text-right font-medium">Output</th>
                    <th className="px-4 py-2 text-right font-medium">Cache hits</th>
                    <th className="px-4 py-2 text-right font-medium">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byAgent.data.groups]
                    .sort((a, b) => b.usage.cost_micros - a.usage.cost_micros || totalTokens(b.usage) - totalTokens(a.usage))
                    .map((g) => {
                      const hit = cacheHitRate(g.usage)
                      return (
                        <tr key={g.key} className="border-b border-border last:border-0 hover:bg-muted/40">
                          <td className="px-4 py-2.5">
                            <Link to={`/v3/agents/${g.key}`} className="flex items-center gap-2.5 hover:underline">
                              <ActorAvatar model={guessModel(agentRuntime(g.key)) ?? guessModel(agentName(g.key))} name={agentName(g.key)} size="sm" />
                              <span>
                                <span className="block font-medium">{agentName(g.key)}</span>
                                {agentRuntime(g.key) ? <span className="block text-xs text-muted-foreground">{agentRuntime(g.key)}</span> : null}
                              </span>
                            </Link>
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{tokens(g.usage.input_tokens)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{tokens(g.usage.output_tokens)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{hit == null ? "—" : `${Math.round(hit * 100)}%`}</td>
                          <td className="px-4 py-2.5 text-right font-medium tabular-nums">{money(g.usage.cost_micros)}</td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-4 pb-4 text-sm text-muted-foreground">{byAgent.loading ? "Loading…" : "Nothing reported in this range."}</p>
          )}
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">By model</h2>
              <span className="text-xs text-muted-foreground">Tokens and spend</span>
            </div>
            {byModel.data?.groups.length ? (
              <ul className="mt-3 divide-y divide-border text-sm">
                {[...byModel.data.groups]
                  .sort((a, b) => b.usage.cost_micros - a.usage.cost_micros || totalTokens(b.usage) - totalTokens(a.usage))
                  .map((g) => (
                    <li key={g.key} className="flex items-center gap-3 py-2">
                      <ActorAvatar model={guessModel(g.key)} name={g.key} size="xs" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{g.key}</span>
                      <span className="text-muted-foreground tabular-nums">{tokens(totalTokens(g.usage))}</span>
                      <span className="w-16 text-right font-medium tabular-nums">{g.usage.unpriced_reports === g.usage.reports ? "no price" : money(g.usage.cost_micros)}</span>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{byModel.loading ? "Loading…" : "Nothing reported in this range."}</p>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">Most expensive tasks</h2>
              <span className="text-xs text-muted-foreground">Spend in this range</span>
            </div>
            {tasks.length ? (
              <ul className="mt-3 space-y-3">
                {tasks.slice(0, 6).map((g) => (
                  <li key={g.key} className="grid grid-cols-[minmax(0,1fr)_6rem_4.5rem] items-center gap-3">
                    <Link to={`/v3/tasks/${g.key}`} className="truncate text-sm hover:underline">
                      #{g.key} {taskTitle(g.key) ?? ""}
                    </Link>
                    <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-chart-1" style={{ width: `${(g.usage.cost_micros / topTask) * 100}%` }} />
                    </span>
                    <span className="text-right text-sm font-medium tabular-nums">{money(g.usage.cost_micros)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{byTask.loading ? "Loading…" : "No usage was reported against a task in this range."}</p>
            )}
            {noTask && noTask.reports ? <p className="mt-3 text-xs text-muted-foreground">{money(noTask.cost_micros)} came from turns with no task claimed.</p> : null}
          </section>
        </div>
      </div>

      {s && editing ? <BudgetDialog open={editing} onOpenChange={setEditing} current={s} onSave={save} /> : null}
    </V3Shell>
  )
}
