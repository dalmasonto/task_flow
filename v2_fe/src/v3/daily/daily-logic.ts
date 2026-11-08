/// Pure rules for the v3 daily-update page (tested in daily-logic.test.ts).

/// "2026-11-01" → "Sunday, 1 November" (plus the year when it isn't this one).
/// Parsed as a calendar date, never through UTC, so it can't shift a day.
export function longDate(date: string, now = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })
}

/// Today in a timezone, as YYYY-MM-DD (the project's day, not the browser's).
/// Falls back to the browser's day when the zone is unknown.
export function todayIn(timezone: string | null | undefined, now = new Date()): string {
  try {
    if (timezone) return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  } catch {
    // unknown zone: fall through
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

export const isIsoDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)

export const STATUS_LABEL = { draft: "Draft", posted: "Posted", skipped: "Skipped" } as const
