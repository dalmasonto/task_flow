/// Display order, numbering and the bulk open state for the Pages panel — the
/// one place that decides which page reads as "1", which section it is listed
/// under, and what the panel's Select all control writes.
///
/// All three are pure functions of the manifest, the arrangement document and
/// the open routes, so they live here rather than as expressions inside
/// `pages-panel.tsx`: the app has no DOM in its test setup, and a `.tsx` that
/// exports a non-component costs a `react-refresh/only-export-components` error
/// apiece (the same reasoning as `design-comments.ts`, the other module of pure
/// helpers the design page shares between files).
///
/// Four rules are load-bearing, and each has a test in `pages-order.test.ts`:
///
/// * **The flat list is the MANIFEST, in manifest order, numbered 1..N.** A
///   page's number is where it sits in the project's own route list, full stop:
///   `numberedPages` does not even receive the arrangement document, so grouping
///   a page cannot renumber it or move it. That is the whole value of a number
///   the user can quote ("the page at 4"), and it is why this list is not sorted
///   into the Groups section's order.
/// * **A group's pages are listed in MANIFEST order, not assignment order.**
///   This is a deliberate divergence from the canvas, whose `layoutGroups`
///   (`lib/design-devices.ts:315`) renders a group's boards in `g.routes` order
///   — and `assignRoute` APPENDS, so that array is assignment order. Matching it
///   here was considered and rejected:
///   * it would agree on the sequence of NAMES and not on positions: the canvas
///     draws only the OPEN routes of each column (`g.routes.filter(r =>
///     openRoutes.includes(r))`, same line), so the panel's order could not be a
///     board ordinal unless every page happens to be open;
///   * and it would cost STABILITY. `assignRoute` appends, so putting one page
///     into a group would move that group's existing pages under the user — the
///     opposite of what a fixed listing is for.
///   Flipping it is a ONE-LINE change here, in `groupedPages` (iterate
///   `group.routes` instead of `routes`, resolving each path against the
///   manifest). If anyone does, the manifest MUST stay the FILTER
///   (`group.routes.filter(r => byPath.has(r))`): dropping it lists a route for a
///   page that does not exist — the phantom-row case `pages-order.test.ts` pins.
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

/** A page as the flat list draws it: its route, and the number it carries. */
export type NumberedPage = { route: string; n: number }

/// The Groups section, as the panel draws it: each group with the pages it
/// holds, then the tail. ROUTES and not numbered pages — see `numberedPages`
/// for why the numbers are not here.
export type GroupedPages = {
  groups: { id: string; name: string; pages: string[] }[]
  ungrouped: string[]
}

/// The Groups section: each group in `layout.groups` order with its pages in
/// manifest order, then everything ungrouped, each as a route.
///
/// These are the NAMES the overview lists; no number is attached, because the
/// panel's one numbering is the flat list's (`numberedPages`) and a second
/// series would print two different pages as "1".
///
/// A group with no pages keeps its section: `createGroup` makes an empty one and
/// `+ Add group` is the only way to make any, so dropping empty sections would
/// make that button look like it did nothing.
export function groupedPages(layout: LayoutDoc, routes: RouteEntry[]): GroupedPages {
  /// Routes already placed in a section. A page lives in at most one group —
  /// the first group in document order that names it, which is the same rule
  /// `groupOf` resolves the row's own picker with.
  const claimed = new Set<string>()

  const groups = layout.groups.map((group) => {
    const pages: string[] = []
    // The MANIFEST is the loop, not the group's `routes`: that is what puts the
    // pages in canonical order and what keeps an entry naming a page this
    // project does not have out of the list.
    //
    // This line IS the one-line flip to assignment order, and the divergence
    // from the canvas's `g.routes` order is deliberate — the reasoning is in
    // the module header. Flipping it means iterating `group.routes` and
    // resolving each path against `routes`; the manifest must stay the FILTER,
    // or the phantom-row case comes back.
    for (const entry of routes) {
      if (claimed.has(entry.path) || !group.routes.includes(entry.path)) continue
      claimed.add(entry.path)
      pages.push(entry.path)
    }
    return { id: group.id, name: group.name, pages }
  })

  /// Everything no listed group claims — including a page whose group was
  /// removed, which is why this is computed from `claimed` and not from the
  /// stored grouping: a page whose group is gone must be listed, not hidden.
  const ungrouped = routes
    .filter((entry) => !claimed.has(entry.path))
    .map((entry) => entry.path)

  return { groups, ungrouped }
}

/// The flat list: every page in the panel, numbered 1..N in MANIFEST order.
///
/// A pure function of the route list alone. The arrangement document is not a
/// parameter and must not become one: the number is the page's position in the
/// project, so assigning the page to a group — or creating one — cannot renumber
/// it under the user. See the module header's first rule.
export function numberedPages(routes: RouteEntry[]): NumberedPage[] {
  return routes.map((entry, i) => ({ route: entry.path, n: i + 1 }))
}

export type SelectAllState = {
  /** Whether every page is open: the state of the control's own box. */
  allOpen: boolean
  /** What the control reads. The two states are the whole vocabulary. */
  label: "Select all" | "Deselect"
  /** The open routes the control WRITES when it is used: every page in manifest
   *  order, or none. The panel hands this straight to the same setter the rows
   *  go through — the bulk control is a second entry point to `openRoutes`, never
   *  a second state. */
  next: string[]
}

/// The bulk open/close control, derived from the pages and the state it
/// summarises.
///
/// `next` is the MANIFEST's pages rather than "whatever is open plus the rest":
/// a route that is not a page in the manifest cannot be drawn on the canvas, so
/// preserving one would keep a board the user can never see. The one open-routes
/// state is a subset of the manifest everywhere else too (`openRoute` filters
/// through it), so this cannot lose anything real.
export function selectAllState(routes: RouteEntry[], openRoutes: string[]): SelectAllState {
  // `routes.length` and not a bare `every`: with no pages at all, "every page is
  // open" is vacuously true, and the control would read "Deselect" beside "No
  // pages yet." — a checked box offering to close nothing. The panel does not
  // draw the control in that state; this is the definition it falls back on.
  const allOpen = routes.length > 0 && routes.every((entry) => openRoutes.includes(entry.path))
  return {
    allOpen,
    label: allOpen ? "Deselect" : "Select all",
    next: allOpen ? [] : routes.map((entry) => entry.path),
  }
}
