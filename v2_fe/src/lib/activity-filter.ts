/** Filtering the activity feed by tool (the action name) and a free-text search
 *  over the human-visible fields, for analysis on the activity page. */

export type FilterableActivity = {
  /** The tool / action name, e.g. "Read", "status_changed". */
  action: string
  actor: string
  detail: string
  title: string
  taskLabel?: string | null
}

/** The sentinel tool value meaning "no tool filter". */
export const ALL_TOOLS = "all"

/** Distinct tool/action names present in the feed, sorted for a stable filter list. */
export function activityTools<T extends { action: string }>(events: readonly T[]): string[] {
  return [...new Set(events.map((event) => event.action))].sort((a, b) => a.localeCompare(b))
}

/** Does the event match the free-text query (case-insensitive, across the
 *  visible fields)? An empty/whitespace query matches everything. */
export function matchesActivitySearch(event: FilterableActivity, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [event.action, event.actor, event.detail, event.title, event.taskLabel ?? ""]
    .join("  ")
    .toLowerCase()
    .includes(needle)
}

/** Filter by tool (ALL_TOOLS = no filter) AND free-text search. */
export function filterActivityEvents<T extends FilterableActivity>(
  events: readonly T[],
  opts: { search: string; tool: string },
): T[] {
  const toolActive = opts.tool !== "" && opts.tool !== ALL_TOOLS
  return events.filter(
    (event) =>
      (!toolActive || event.action === opts.tool) && matchesActivitySearch(event, opts.search),
  )
}
