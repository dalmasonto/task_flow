/** Parse a free-text estimate into whole minutes, or null. Leading int wins. */
export function parseEstimateMinutes(text: string): number | null {
  const match = text.trim().match(/^(\d+)/)
  return match ? Number(match[1]) : null
}

/** Render an estimate for display. */
export function formatEstimateMinutes(minutes: number | null | undefined): string {
  return typeof minutes === "number" ? `${minutes} min` : "—"
}
