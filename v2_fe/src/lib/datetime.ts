/** Bridging a stored UTC timestamp and an `<input type="datetime-local">`.
 *
 * A datetime-local input has no timezone: its value is a bare local wall-clock
 * string (`YYYY-MM-DDTHH:mm`), and the browser both shows and parses it in the
 * user's own timezone. So a UTC iso must be shifted into local wall-clock before
 * it seeds the input, or the field shows the UTC time (e.g. 21:30 UTC instead of
 * the 00:30 the user actually picked). Saving is the mirror: parse the local
 * string as local and serialize to UTC.
 */

/** UTC iso → local wall-clock `YYYY-MM-DDTHH:mm` for a datetime-local input. */
export function isoToDatetimeLocalInput(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  // Subtract the local offset so the UTC slice reads as local wall-clock.
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

/** Local datetime-local value → UTC iso, or null when empty/invalid. */
export function datetimeLocalInputToIso(value: string): string | null {
  if (!value) return null
  // A bare datetime-local string is parsed as LOCAL time by the Date ctor.
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}
