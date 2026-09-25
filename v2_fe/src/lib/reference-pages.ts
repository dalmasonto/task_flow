/// Walking a "reference list" — a roster, a room list, a settings list — to
/// completion, so page 1 is not mistaken for the whole list.
///
/// The reference loaders in `taskflow-api` all send `page_size=100` (the
/// server's ceiling: `PageNumberPagination::new(25)` in backend/src/main.rs
/// sets `max_page_size = page_size * 4`) and used to read `.results` while
/// **`count` — the true total, in the same envelope — went unread**. Past 100
/// rows every one of those lists showed a prefix of itself and nothing said so.
/// In production, which is the "lots of data" case this work exists for, that
/// is a wrong answer rather than a slow one.
///
/// The envelope is what makes the walk finite and honest: page 1 reports the
/// total, so the caller knows whether a second page exists at all. A list at or
/// under one page still costs exactly one request.
///
/// `maxPages` is a bound rather than an optimisation. A project large enough to
/// cross it gets its first 1000 rows and a warning naming the list, because a
/// silent stop is the defect this function exists to remove. Trade-off, stated:
/// below the bound the walk is exact; at the bound the answer is partial and
/// says so.

export type ReferencePage<T> = { results: T[]; count: number }

export const MAX_REFERENCE_PAGES = 10

export async function fetchAllReferencePages<T>(
  /// Fetch ONE page. Must return a fresh query per call: the client's builder
  /// mutates the query it is called on, so a shared query would carry page 1's
  /// `page` param into every later request and re-fetch the same page forever.
  fetchPage: (page: number) => Promise<ReferencePage<T>>,
  /// Names the list in the truncation warning. A warning that cannot say which
  /// list stopped early is not worth emitting.
  label: string,
  maxPages: number = MAX_REFERENCE_PAGES
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 1; ; page += 1) {
    const { results, count } = await fetchPage(page)
    rows.push(...results)
    // No rows is the end, whatever `count` claims. Trusting the total alone
    // would loop on a paginator that stops advancing — which is the one way
    // this can hang a page load.
    if (!results.length) return rows
    // `count` is a snapshot taken per request, so a list that grows mid-walk
    // can report a total a later page has already passed. `>=` stops either way.
    if (rows.length >= count) return rows
    if (page >= maxPages) {
      console.warn(
        `taskflow: ${label} is truncated at ${rows.length} of ${count} rows (stopped after ${maxPages} pages)`
      )
      return rows
    }
  }
}
