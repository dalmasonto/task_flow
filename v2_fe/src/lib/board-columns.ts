/// #56: which stored statuses belong to each board column.
///
/// Paging the board per column means asking the SERVER for one column's tasks,
/// which needs the inverse of `mapLiveStatus` in App.tsx. That mapping is not
/// 1:1 — three columns absorb a second stored status:
///
///     review  <- partial_done      blocked <- paused      done <- archived
///
/// Getting it wrong is quiet rather than loud. On a paged board a column that
/// queries the wrong statuses just returns fewer rows, and "fewer rows" is
/// exactly what "you have reached the end" looks like.

import type { TaskflowTaskStatus } from "@/api/client"

export type BoardColumnId = "not_started" | "in_progress" | "review" | "blocked" | "done"

export const BOARD_COLUMN_IDS: BoardColumnId[] = [
  "not_started",
  "in_progress",
  "review",
  "blocked",
  "done",
]

/// The partition must stay TOTAL and DISJOINT — see the test. A stored status in
/// no column is a task that vanishes from the board; one in two columns is a task
/// counted twice, which corrupts the `loaded < count` test that decides whether
/// to fetch the next page.
///
/// Note `review` is a COLUMN, not a stored status — `TaskflowTaskStatus` has no
/// such value. It exists purely as the board's name for `partial_done`, so a
/// column id is not always a status you can filter by. That asymmetry is the
/// whole reason this lookup exists rather than passing the column id straight to
/// the API.
const COLUMN_STATUSES: Record<BoardColumnId, TaskflowTaskStatus[]> = {
  not_started: ["not_started"],
  in_progress: ["in_progress"],
  review: ["partial_done"],
  blocked: ["blocked", "paused"],
  done: ["done", "archived"],
}

export function columnStatuses(column: BoardColumnId): TaskflowTaskStatus[] {
  return COLUMN_STATUSES[column]
}
