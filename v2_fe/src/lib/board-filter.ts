/** Filtering board tasks by a free-text search and by priority. Kept pure and
 *  UI-agnostic so it can be unit-tested and reused. */

export type FilterableTask = {
  id: string
  title: string
  priority: string
  owner: string
  operatorName: string
  tags: string[]
}

/** Sentinel priority meaning "any priority". */
export const ALL_PRIORITIES = "all"

/** The priority chips a board offers, most-urgent first. */
export const BOARD_PRIORITIES = ["critical", "high", "normal", "low"] as const

/** Free-text match over id (`#12` or `12`), title, owner, operator, and tags. */
export function matchesBoardSearch(task: FilterableTask, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [`#${task.id}`, task.title, task.owner, task.operatorName, task.tags.join(" ")]
    .join("  ")
    .toLowerCase()
    .includes(needle)
}

/** Filter by priority (ALL_PRIORITIES = no filter) AND free-text search. */
export function filterBoardTasks<T extends FilterableTask>(
  tasks: readonly T[],
  opts: { search: string; priority: string },
): T[] {
  const priorityActive = opts.priority !== "" && opts.priority !== ALL_PRIORITIES
  return tasks.filter(
    (task) =>
      (!priorityActive || task.priority === opts.priority) && matchesBoardSearch(task, opts.search),
  )
}
