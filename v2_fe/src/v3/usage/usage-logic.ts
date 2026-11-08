/// Pure rules for the v3 usage page (tested in usage-logic.test.ts).
import type { UsageBucket } from "./usage-api"

export type RangeId = "7d" | "14d" | "30d" | "month"

export const RANGES: { id: RangeId; label: string }[] = [
  { id: "7d", label: "7 days" },
  { id: "14d", label: "14 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
]

/// The window for a range, and the same-length window just before it (for
/// "12% more than the 14 days before"). "This month" compares with the same
/// number of days at the end of last month.
export function windows(range: RangeId, now: Date): { from: Date; to: Date; prevFrom: Date; prevTo: Date; days: number } {
  const to = new Date(now)
  let from: Date
  if (range === "month") from = new Date(now.getFullYear(), now.getMonth(), 1)
  else from = new Date(now.getTime() - Number.parseInt(range, 10) * 86_400_000)
  const span = to.getTime() - from.getTime()
  return { from, to, prevFrom: new Date(from.getTime() - span), prevTo: from, days: Math.max(1, Math.ceil(span / 86_400_000)) }
}

/// Every day in [from, to] as YYYY-MM-DD (UTC, matching the server's day
/// grouping), oldest first, each with that day's bucket or zero.
export function dailySeries(groups: { key: string; usage: UsageBucket }[], from: Date, to: Date): { day: string; tokens: number; cost: number }[] {
  const by = new Map(groups.map((g) => [g.key, g.usage]))
  const out: { day: string; tokens: number; cost: number }[] = []
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  while (d.getTime() <= to.getTime()) {
    const key = d.toISOString().slice(0, 10)
    const b = by.get(key)
    out.push({ day: key, tokens: b ? b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens : 0, cost: b?.cost_micros ?? 0 })
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

/// Share of prompt tokens served from cache, or null with no prompt tokens.
export function cacheHitRate(b: UsageBucket): number | null {
  const prompt = b.input_tokens + b.cache_read_tokens
  return prompt ? b.cache_read_tokens / prompt : null
}

/// "12% more" / "8% less" / "about the same", or null when there's nothing
/// to compare with.
export function change(now: number, before: number): string | null {
  if (!before) return null
  const pct = Math.round(((now - before) / before) * 100)
  if (Math.abs(pct) < 3) return "About the same"
  return `${Math.abs(pct)}% ${pct > 0 ? "more" : "less"}`
}

const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))

/// CSV of a grouped usage response, one row per group.
export function toCsv(groupLabel: string, groups: { key: string; label: string; usage: UsageBucket }[]): string {
  const head = [groupLabel, "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "unpriced_reports", "reports"]
  const rows = groups.map((g) => [g.label, g.usage.input_tokens, g.usage.output_tokens, g.usage.cache_read_tokens, g.usage.cache_write_tokens, (g.usage.cost_micros / 1_000_000).toFixed(6), g.usage.unpriced_reports, g.usage.reports])
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n"
}

/// Dollars typed in a form → micro-dollars, or null for blank. NaN-safe.
export function toMicros(dollars: string): number | null {
  const t = dollars.trim().replace(/^\$/, "")
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : null
}
