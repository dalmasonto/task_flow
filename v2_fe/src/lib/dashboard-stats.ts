/** Pure shaping helpers for the project dashboard. No DOM, no network — the
 *  page stays thin by pushing every testable bit of logic here. */

/** Seconds → "12h 40m" / "40m" / "0m". Rounds down to whole minutes. */
export function formatWorkedTime(seconds: number): string {
  const totalMin = Math.floor(Math.max(0, seconds) / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** Attach a 0–100 `pct` (share of the max value) to each row for bar widths. */
export function barModel<T>(rows: T[], value: (r: T) => number): Array<T & { pct: number }> {
  const max = rows.reduce((m, r) => Math.max(m, value(r)), 0)
  return rows.map((r) => ({ ...r, pct: max > 0 ? Math.round((value(r) / max) * 100) : 0 }))
}

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 }

/**
 * Expand a sparse day→count list into a contiguous ascending series covering the
 * range (so the bar chart shows empty days). For "all", spans from the earliest
 * present day to `now`. `now` is injected for testability.
 */
export function fillDaySeries(
  rows: { day: string; count: number }[],
  range: string,
  now: number,
): { day: string; count: number }[] {
  const present = new Map(rows.map((r) => [r.day, r.count]))
  const dayMs = 86_400_000
  const end = new Date(now)
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
  let startUtc: number
  if (range in RANGE_DAYS) {
    startUtc = endUtc - (RANGE_DAYS[range] - 1) * dayMs
  } else {
    // "all": from the earliest present day (or just today if none).
    const earliest = rows.length
      ? Math.min(...rows.map((r) => Date.parse(`${r.day}T00:00:00Z`)))
      : endUtc
    startUtc = earliest
  }
  const out: { day: string; count: number }[] = []
  for (let d = startUtc; d <= endUtc; d += dayMs) {
    const key = new Date(d).toISOString().slice(0, 10)
    out.push({ day: key, count: present.get(key) ?? 0 })
  }
  return out
}
