/// The usage service (#1100), people's side. Shapes mirror
/// backend/plugins/taskflow-usage/src/service.rs. Usage is self-reported by
/// each agent's MCP (token counts only; cost is priced server-side from the
/// project's price table), for awareness, not billing.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type UsageBucket = {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_micros: number
  /// Reports with no price for their model: their cost isn't in cost_micros.
  unpriced_reports: number
  reports: number
}

export type UsageGroup = "day" | "model" | "agent" | "task"

export type UsageResponse = {
  self_reported: true
  note: string
  from: string
  to: string
  group: UsageGroup
  total: UsageBucket
  groups: { key: string; usage: UsageBucket }[]
  month: { start: string; spend_micros: number; projected_micros: number; budget_micros: number | null }
}

export type UsageSettings = {
  budget_micros: number | null
  alert_percent: number | null
  alert_channel: number | null
  task_cap_micros: number | null
  idle_alert: boolean
  updated_by_label: string | null
  updated_at: string | null
}

export type UsagePrice = {
  id: number
  model_prefix: string
  display_name: string | null
  input_micros_per_mtok: number | null
  output_micros_per_mtok: number | null
  cache_read_micros_per_mtok: number | null
  cache_write_micros_per_mtok: number | null
}

const base = (p: number) => `${API_BASE_URL}/api/taskflow/usage/${p}`

async function get<T>(url: string, signal: AbortSignal | undefined, fallback: string): Promise<T> {
  const res = await fetch(url, withBearer({ signal }))
  if (!res.ok) throw new Error(`${fallback} (${res.status}).`)
  return (await res.json()) as T
}

export function fetchUsage(project: number, q: { from?: Date; to?: Date; group?: UsageGroup; agent?: number }, signal?: AbortSignal): Promise<UsageResponse> {
  const p = new URLSearchParams()
  if (q.from) p.set("from", q.from.toISOString())
  if (q.to) p.set("to", q.to.toISOString())
  if (q.group) p.set("group", q.group)
  if (q.agent != null) p.set("agent", String(q.agent))
  return get<UsageResponse>(`${base(project)}?${p}`, signal, "Couldn't load usage")
}

export const fetchUsageSettings = (project: number, signal?: AbortSignal) => get<{ settings: UsageSettings; can_edit: boolean }>(`${base(project)}/settings`, signal, "Couldn't load the budget")

export const fetchUsagePrices = async (project: number, signal?: AbortSignal) => (await get<{ results?: UsagePrice[] }>(`${base(project)}/prices`, signal, "Couldn't load prices")).results ?? []

export async function saveUsageSettings(project: number, s: Partial<Omit<UsageSettings, "updated_by_label" | "updated_at">>): Promise<UsageSettings> {
  const res = await fetch(`${base(project)}/settings`, withBearer({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s) }))
  if (res.status === 403) throw new Error("Only owners and admins can change the budget.")
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { field?: string; reason?: string } | null
    throw new Error(b?.field && b.reason ? `${b.field.replace(/_/g, " ")}: ${b.reason}` : `Couldn't save the budget (${res.status}).`)
  }
  const body = (await res.json()) as { settings?: UsageSettings } & Partial<UsageSettings>
  return (body.settings ?? body) as UsageSettings
}

/// $12.34 from micro-dollars; "<$0.01" for a non-zero sliver.
export function money(micros: number | null | undefined): string {
  const m = micros ?? 0
  if (m > 0 && m < 10_000) return "<$0.01"
  return `$${(m / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/// 1.84M / 920K / 512 tokens.
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, "")}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

export const totalTokens = (b: UsageBucket) => b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens
