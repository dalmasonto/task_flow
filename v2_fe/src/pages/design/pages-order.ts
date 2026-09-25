/// Display order and numbering for the Pages panel — the one place that decides
/// which page reads as "1" and which section it is listed under.
///
/// Both are pure functions of the manifest and the arrangement document, so
/// they live here rather than as expressions inside `pages-panel.tsx`: the app
/// has no DOM in its test setup, and a `.tsx` that exports a non-component costs
/// a `react-refresh/only-export-components` error apiece (the same reasoning as
/// `design-comments.ts`, the other module of pure helpers the design page shares
/// between files).
///
/// Four rules are load-bearing, and each has a test in `pages-order.test.ts`:
///
/// * **One 1..N series over the whole displayed sequence** — the groups in
///   document order, then the ungrouped tail. Restarting per section would print
///   two different pages as "1" and the number would stop meaning "where this
///   page sits in the list".
/// * **A group's pages are in MANIFEST order, not assignment order.** This is a
///   deliberate divergence from the canvas, whose `layoutGroups`
///   (`lib/design-devices.ts:315`) renders a group's boards in `g.routes` order
///   — and `assignRoute` APPENDS, so that array is assignment order. Matching it
///   here was considered and rejected:
///   * it would agree on the sequence of NAMES and not on positions: the canvas
///     draws only the OPEN routes of each column (`g.routes.filter(r =>
///     openRoutes.includes(r))`, same line), so the panel's number cannot be a
///     board ordinal unless every page happens to be open;
///   * and it would cost STABILITY. `assignRoute` appends, so putting one page
///     into a group would renumber that group's existing pages under the user —
///     the opposite of what a fixed 1..N reference is for.
///   Flipping it is a ONE-LINE change here, in `groupedPages` (iterate
///   `group.routes` instead of `routes`, resolving each path against the
///   manifest). If anyone does, the manifest MUST stay the FILTER
///   (`group.routes.filter(r => byPath.has(r))`): dropping it draws a row for a
///   page that does not exist and spends a number on it — the phantom-row case
///   `pages-order.test.ts` pins with mutation M8.
/// * **The canvas is NOT sorted to match.** `openRoutes` stays in manifest order
///   (`DesignSurfacePage`'s `openRoute`) and the boards render in it, so
///   sorting the boards into the panel's grouped order would move every board
///   below the edited row. The spec's §F is absolute about this — *"The canvas
///   layout never reflows. Boards stay keyed `route@device`; clicking a link must
///   not add, remove or move anything"*
///   (`docs/superpowers/specs/2026-09-25-design-phase5-resources-and-ergonomics-design.md:152`)
///   — and a grouping edit is no more entitled to a reflow than a link is.
/// * **Nothing can vanish.** `ungrouped` is the COMPLEMENT of the routes the
///   listed groups claim, never a separate "pages with no group id" scan, so
///   every manifest route lands in exactly one place. These are the states that
///   make it matter, all of them reachable: a group the user deleted
///   (`removeGroup` leaves its pages in no group at all), a page two groups both
///   claim (the client reads whatever it is sent; `groupOf` resolves the row's
///   picker with a `find`, so the FIRST group has to win here too, or the
///   section and the picker disagree), and a group entry that is not a page —
///   the manifest and the layout are two separate fetches, and the server's
///   forgiving `filter_to_known` only drops those against the manifest it read
///   at that moment.

import type { RouteEntry } from "@/lib/design-api"
import type { LayoutDoc } from "@/lib/design-layout"

/** A page as the panel draws it: its route, and the number it carries. */
export type NumberedPage = { route: string; n: number }

export type GroupedPages = {
  groups: { id: string; name: string; pages: NumberedPage[] }[]
  ungrouped: NumberedPage[]
}

/// Pages in DISPLAY order: each group in `layout.groups` order with its pages in
/// manifest order, then everything ungrouped. Numbering runs across the whole
/// displayed sequence, so the number a user reads matches the position they see.
///
/// A group with no pages keeps its section: `createGroup` makes an empty one and
/// `+ New group` is the only way to make any, so dropping empty sections would
/// make that button look like it did nothing.
export function groupedPages(layout: LayoutDoc, routes: RouteEntry[]): GroupedPages {
  /// Routes already placed in a section. A page lives in at most one group —
  /// the first group in document order that names it, which is the same rule
  /// `groupOf` resolves the row's own picker with.
  const claimed = new Set<string>()
  /// The running number of the displayed sequence.
  let n = 0

  const groups = layout.groups.map((group) => {
    const pages: NumberedPage[] = []
    // The MANIFEST is the loop, not the group's `routes`: that is what puts the
    // pages in canonical order and what keeps an entry naming a page this
    // project does not have out of the list.
    //
    // This line IS the one-line flip to assignment order, and the divergence
    // from the canvas's `g.routes` order is deliberate — the reasoning is in
    // the module header. Flipping it means iterating `group.routes` and
    // resolving each path against `routes`; the manifest must stay the FILTER,
    // or the phantom-row case below comes back.
    for (const entry of routes) {
      if (claimed.has(entry.path) || !group.routes.includes(entry.path)) continue
      claimed.add(entry.path)
      n += 1
      pages.push({ route: entry.path, n })
    }
    return { id: group.id, name: group.name, pages }
  })

  /// Everything no listed group claims — including a page whose group was
  /// removed, which is why this is computed from `claimed` and not from the
  /// stored grouping: a page whose group is gone must be listed, not hidden.
  const ungrouped = routes
    .filter((entry) => !claimed.has(entry.path))
    .map((entry) => {
      n += 1
      return { route: entry.path, n }
    })

  return { groups, ungrouped }
}
