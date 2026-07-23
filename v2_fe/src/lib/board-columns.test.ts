import { describe, it, expect } from "vitest"
import { columnStatuses, BOARD_COLUMN_IDS } from "./board-columns"

/// #56: paging the board per column means asking the SERVER for one column's
/// tasks. That needs the inverse of App.tsx's `mapLiveStatus`, and the mapping is
/// not 1:1 — three board columns absorb a second stored status. Get this wrong
/// and the column silently pages through the wrong rows, or misses some
/// entirely, which on a paged board is indistinguishable from "there are no
/// more".
describe("columnStatuses", () => {
  it("maps the columns that absorb a second stored status", () => {
    expect(columnStatuses("blocked").slice().sort()).toEqual(["blocked", "paused"])
    expect(columnStatuses("done").slice().sort()).toEqual(["archived", "done"])
  })

  it("maps the columns that are a single status", () => {
    expect(columnStatuses("not_started")).toEqual(["not_started"])
    expect(columnStatuses("in_progress")).toEqual(["in_progress"])
  })

  // `review` is a column NAME, not a stored status — TaskflowTaskStatus has no
  // such value. Passing a column id straight to the API would filter on a status
  // the backend has never heard of and quietly return nothing.
  it("maps the review column onto partial_done, which is what is actually stored", () => {
    expect(columnStatuses("review")).toEqual(["partial_done"])
  })

  // The partition must be total and disjoint over the STORED statuses. A status
  // in no column is a task that vanishes from the board; a status in two is a
  // task counted twice, which corrupts the "loaded < count" test that decides
  // whether to fetch another page.
  it("partitions every stored status across the columns exactly once", () => {
    const seen = BOARD_COLUMN_IDS.flatMap(columnStatuses)
    const stored = [
      "not_started",
      "in_progress",
      "paused",
      "blocked",
      "partial_done",
      "done",
      "archived",
    ]
    expect(seen.slice().sort()).toEqual(stored.slice().sort())
    expect(new Set(seen).size).toBe(seen.length)
  })
})
