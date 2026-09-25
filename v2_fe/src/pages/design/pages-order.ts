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
/// Three rules are load-bearing, and each has a test in `pages-order.test.ts`:
///
/// * **The flat list is every page, in the FLOW order, numbered 1..N.** The
///   flow is `routeOrder` — the sequence the user built by moving pages up and
///   down — resolved over the manifest by `resolveRouteOrder`
///   (`lib/design-layout.ts`), which falls back to the pages' own order when no
///   flow has been set and appends every page the stored flow does not name.
///   The number beside a row is therefore the page's position in the sequence
///   it is being presented in, which is the only reading of a number the user
///   can act on. What it is NOT is a position in any GROUP: a grouping edit is
///   not a reorder (`assignRoute` never touches `routeOrder`), so grouping can
///   still never renumber or move a row. Only an explicit move can, and that is
///   what the row's arrows are for.
/// * **Every listing agrees with the canvas, in every view.** A group's pages
///   are listed in flow order and the ungrouped tail is listed in flow order;
///   the canvas draws its boards in flow order too, in all three arrangements
///   (`boardsForView` in `lib/design-devices.ts`). Panel and canvas describing
///   one sequence is the point of the feature — a panel that listed the flow and
///   a canvas that drew something else would each be claiming to be "the" order.
///   The one thing that must NOT follow the flow is a grouping edit's effect on
///   the canvas: `assignRoute` changes where a page is grouped, never where it
///   sits in the flow, so grouping a page leaves the boards in `rows` and
///   `bands` exactly where they were. (In `groups` the page joins its column,
///   which is what that view is for; the columns themselves stay put, ordered by
///   the document's groups and not by the flow.) §F states its rule about a LINK
///   CLICK — *"The canvas layout never reflows. Boards stay keyed `route@device`;
///   clicking a link must not add, remove or move anything"*
///   (`docs/superpowers/specs/2026-09-25-design-phase5-resources-and-ergonomics-design.md:152`)
///   — and this phase reads it the same way for every edit that is not an
///   explicit reorder, which is the only edit here that is allowed to move a
///   board.
/// * **Nothing can vanish, whatever the flow says.** `ungrouped` is the
///   COMPLEMENT of the routes the listed groups claim, never a separate "pages
///   with no group id" scan, so every manifest route lands in exactly one place.
///   These are the states that make it matter, all of them reachable: a group
///   the user deleted (`removeGroup` leaves its pages in no group at all), a
///   page two groups both claim (the client reads whatever it is sent;
///   `groupOf` resolves the row's picker with a `find`, so the FIRST group has to
///   win here too, or the section and the picker disagree), a group entry that is
///   not a page — the manifest and the layout are two separate fetches, and the
///   server's forgiving `filter_to_known` only drops those against the manifest
///   it read at that moment — and a STORED FLOW that names pages this project no
///   longer has. The manifest stays the filter for all of them, which is why the
///   sections walk the resolved order rather than whatever a group's own `routes`
///   array happens to hold.

import type { RouteEntry } from "@/lib/design-api"
import type { LayoutDoc } from "@/lib/design-layout"
import { resolveRouteOrder } from "@/lib/design-layout"

/// A page as the flat list draws it: its route, and the number it carries.
export type NumberedPage = { route: string; n: number }

/// The Groups section, as the panel draws it: each group with the pages it
/// holds, then the tail. ROUTES and not numbered pages — see `numberedPages`
/// for why the numbers are not here.
export type GroupedPages = {
  groups: { id: string; name: string; pages: string[] }[]
  ungrouped: string[]
}

/// The routes of a manifest, in the order the pages are presented in: what
/// every listing below is built from, so the panel has ONE idea of the flow.
const flowOf = (layout: LayoutDoc, routes: RouteEntry[]) =>
  resolveRouteOrder(
    layout,
    routes.map((entry) => entry.path),
  )

/// The Groups section: each group in `layout.groups` order with its pages in
/// flow order, then everything ungrouped, each as a route.
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
  /// The pages in presentation order. This IS the manifest's page list — the
  /// same routes, resolved — so a group entry naming a page this project does
  /// not have can never reach the list, which is what the loop below walks
  /// instead of the group's own `routes`.
  const order = flowOf(layout, routes)

  const groups = layout.groups.map((group) => {
    const pages: string[] = []
    for (const route of order) {
      if (claimed.has(route) || !group.routes.includes(route)) continue
      claimed.add(route)
      pages.push(route)
    }
    return { id: group.id, name: group.name, pages }
  })

  /// Everything no listed group claims — including a page whose group was
  /// removed, which is why this is computed from `claimed` and not from the
  /// stored grouping: a page whose group is gone must be listed, not hidden.
  const ungrouped = order.filter((route) => !claimed.has(route))

  return { groups, ungrouped }
}

/// The flat list: every page in the panel, numbered 1..N in FLOW order.
///
/// The number is the page's position in the sequence, and the sequence is the
/// pages' own order until the user moves one — see the module header's first
/// rule for what that number is for and what it deliberately is not.
export function numberedPages(layout: LayoutDoc, routes: RouteEntry[]): NumberedPage[] {
  return flowOf(layout, routes).map((route, i) => ({ route, n: i + 1 }))
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
