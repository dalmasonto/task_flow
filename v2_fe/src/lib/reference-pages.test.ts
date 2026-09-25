import { describe, expect, it, vi } from "vitest"
import { fetchAllReferencePages, MAX_REFERENCE_PAGES, type ReferencePage } from "./reference-pages"

/// A server that has `count` rows in total, served in pages of `pageSize`,
/// recording every page it was asked for. `count` can be overridden per page to
/// model the totals a real list reports while rows are being added to it.
function server<T>(rows: T[], pageSize: number, counts?: number[]) {
  const asked: number[] = []
  const fetchPage = async (page: number): Promise<ReferencePage<T>> => {
    asked.push(page)
    const declared = counts?.[page - 1] ?? rows.length
    return { results: rows.slice((page - 1) * pageSize, page * pageSize), count: declared }
  }
  return { asked, fetchPage }
}

describe("fetchAllReferencePages", () => {
  it("makes exactly one request when the list fits on one page", async () => {
    const { asked, fetchPage } = server([1, 2, 3], 100)
    expect(await fetchAllReferencePages(fetchPage, "test")).toEqual([1, 2, 3])
    expect(asked).toEqual([1])
  })

  it("walks every page and keeps them in server order", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => i)
    const { asked, fetchPage } = server(rows, 100)
    expect(await fetchAllReferencePages(fetchPage, "test")).toEqual(rows)
    expect(asked).toEqual([1, 2, 3])
  })

  // The one case that must not be silently swallowed: the envelope said there
  // was a 4th page and the walk stopped at `maxPages` instead. The caller gets
  // the rows it did fetch, and the console says which list is short.
  it("stops at maxPages and says which list is truncated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const rows = Array.from({ length: 1200 }, (_, i) => i)
    const { asked, fetchPage } = server(rows, 100)
    const out = await fetchAllReferencePages(fetchPage, "taskflow_project_member")
    expect(out).toHaveLength(MAX_REFERENCE_PAGES * 100)
    expect(asked).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("taskflow_project_member")
    expect(warn.mock.calls[0][0]).toContain("1200")
    warn.mockRestore()
  })

  // A list at or under the ceiling must not warn on its way past it: the
  // warning is the signal that something is missing, so a walk that completes
  // has to stay quiet.
  it("does not warn when the walk completes, even at the page bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const rows = Array.from({ length: 1000 }, (_, i) => i)
    const { fetchPage } = server(rows, 100)
    expect(await fetchAllReferencePages(fetchPage, "test")).toHaveLength(1000)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // The guard against a paginator that stops advancing. Without it the loop
  // trusts `count` alone and asks for page 2, 3, 4 … forever.
  it("stops on an empty page even when count claims more rows", async () => {
    const asked: number[] = []
    const fetchPage = async (page: number): Promise<ReferencePage<number>> => {
      asked.push(page)
      return page === 1 ? { results: [1, 2], count: 500 } : { results: [], count: 500 }
    }
    expect(await fetchAllReferencePages(fetchPage, "test")).toEqual([1, 2])
    expect(asked).toEqual([1, 2])
  })

  // `count` is a per-request snapshot; a list that grew mid-walk can report a
  // total a later page has already gone past. The stopping condition is on the
  // rows HELD, not on the last page's length: page 2 returns a full page of two
  // while the (stale) total says three, and the walk must still stop there.
  it("stops once the rows it holds reach the reported total", async () => {
    const { asked, fetchPage } = server([1, 2, 3, 4], 2, [3, 3])
    expect(await fetchAllReferencePages(fetchPage, "test")).toEqual([1, 2, 3, 4])
    expect(asked).toEqual([1, 2])
  })
})
