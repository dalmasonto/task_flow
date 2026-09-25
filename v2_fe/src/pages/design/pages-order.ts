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
/// * **A page's number is its place in the SECTION it is listed under** — the
///   group it is grouped into, or the ungrouped section. A group of two screens
///   reads "1, 2"; the next group starts at 1 again; the ungrouped section
///   numbers itself. This is `groupedPages`, which both lists and numbers, so
///   the number and the section it belongs to cannot disagree.
///   There is a SECOND numbering, and only that one is global: the page's place
///   in the FLOW (`numberedPages`), which the panel does not draw. The flow is
///   `routeOrder` — the sequence the user built by moving pages up and down —
///   resolved over the manifest by `resolveRouteOrder` (`lib/design-layout.ts`),
///   which falls back to the pages' own order when no flow has been set and
///   appends every page the stored flow does not name. It still orders the
///   canvas in all three arrangements, and it is still what orders the pages
///   WITHIN a group — and because the row's move controls write a flow move,
///   their ends are the flow's ends, which is the one thing `numberedPages` is
///   still for. It is deliberately NOT a per-group order stored anywhere: a
///   grouping edit is not a reorder (`assignRoute` never touches `routeOrder`),
///   so grouping can still never renumber or move a row. Only an explicit move
///   can, and that is what the row's arrows are for.
/// * **Every listing agrees with the canvas, in every view.** A group's pages
///   are listed in flow order and the ungrouped section is listed in flow order;
///   the canvas draws its boards in flow order too, in all three arrangements
///   (`boardsForView` in `lib/design-devices.ts`), with the pages inside a group
///   column read down in that same flow order. Panel and canvas describing one
///   sequence is the point of the feature — a panel that listed the flow and a
///   canvas that drew something else would each be claiming to be "the" order.
///   The one thing that must NOT follow the flow is a grouping edit's effect on
///   the canvas: `assignRoute` changes where a page is grouped, never where it
///   sits in the flow, so grouping a page leaves the boards in `rows` and
///   `bands` exactly where they were. (In `groups` the page joins its column,
///   which is what that view is for; the columns themselves stay put, ordered by
///   the document's groups and not by the flow — the panel's group arrows are
///   what move them.) §F states its rule about a LINK CLICK — *"The canvas
///   layout never reflows. Boards stay keyed `route@device`; clicking a link
///   must not add, remove or move anything"*
///   (`docs/superpowers/specs/2026-09-25-design-phase5-resources-and-ergonomics-design.md:152`)
///   — and this phase reads it the same way for every edit that is not an
///   explicit reorder, which is the only edit here that is allowed to move a
///   board.
/// * **Nothing can vanish from the sections, and nothing is listed twice.**
///   The panel draws BOTH halves of `groupedPages` now — the groups and the
///   ungrouped section — so the partition is the invariant that keeps a page
///   from appearing under a group and again below it, which would be two rows
///   writing one `openRoutes` entry. `ungrouped` is the COMPLEMENT of the routes
///   the listed groups claim, never a separate "pages with no group id" scan, so
///   every manifest route lands in exactly one place.
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

/// A page as a section draws it: its route, and the number it carries THERE.
export type NumberedPage = { route: string; n: number }

/// The panel's sections, as `groupedPages` computes them: each group with the
/// pages it holds, numbered 1..n within that group, and the pages no listed
/// group claims, numbered 1..m within their own section. The panel draws both
/// halves — the groups under the "Groups" heading, the complement under
/// "Ungrouped" — and the two are a PARTITION of the manifest, so no page can be
/// drawn twice.
///
/// Both halves carry `NumberedPage`s rather than bare routes because the number
/// IS the section's: a section that listed routes and left the numbering to its
/// caller would be a second place that could disagree about which page is "2".
export type GroupedPages = {
  groups: { id: string; name: string; pages: NumberedPage[] }[]
  ungrouped: NumberedPage[]
}

/// The routes of a manifest, in the order the pages are presented in: what
/// every listing below is built from, so the panel has ONE idea of the flow.
const flowOf = (layout: LayoutDoc, routes: RouteEntry[]) =>
  resolveRouteOrder(
    layout,
    routes.map((entry) => entry.path),
  )

/// The panel's sections: each group in `layout.groups` order with its pages in
/// flow order and numbered 1..n within the group, and the rest of the manifest
/// as the `ungrouped` section, numbered 1..m of its own.
///
/// A group with no pages keeps its section and is drawn with no rows: `createGroup`
/// makes an empty one and `+ Add group` is the only way to make any, so dropping
/// empty sections would make that button look like it did nothing — and the
/// group's row is where its move arrows live.
export function groupedPages(layout: LayoutDoc, routes: RouteEntry[]): GroupedPages {
  /// Routes already placed in a section. A page lives in at most one group —
  /// the first group in document order that names it, which is the same rule
  /// `groupOf` resolves the row's own picker with.
  ///
  /// A route two groups both claim therefore lists ONCE here, while the canvas
  /// would draw it in both columns (`layoutGroups` does not dedupe across
  /// columns). That divergence is unreachable rather than handled: the server's
  /// `validate` refuses a document putting one page in two groups
  /// (`layout_doc.rs:111-113`), so it can only be built by hand.
  const claimed = new Set<string>()
  /// The pages in presentation order. This IS the manifest's page list — the
  /// same routes, resolved — so a group entry naming a page this project does
  /// not have can never reach the list, which is what the loop below walks
  /// instead of the group's own `routes`.
  const order = flowOf(layout, routes)

  const groups = layout.groups.map((group) => {
    const pages: NumberedPage[] = []
    for (const route of order) {
      if (claimed.has(route) || !group.routes.includes(route)) continue
      claimed.add(route)
      pages.push({ route, n: pages.length + 1 })
    }
    return { id: group.id, name: group.name, pages }
  })

  /// Everything no listed group claims — the sections' complement, drawn last
  /// and numbered from 1 of its own. Computed from `claimed` and not from the
  /// stored grouping, because that is what makes the two halves partition
  /// `order`: a group the user deleted, a page two groups both claim and a group
  /// entry that names nothing all leave the routes they touch in exactly one
  /// place, which is the invariant the tests pin.
  const ungrouped = order
    .filter((route) => !claimed.has(route))
    .map((route, i) => ({ route, n: i + 1 }))

  return { groups, ungrouped }
}

/// The FLOW as numbered places: every page at its position in the sequence,
/// 1..N.
///
/// The panel does not draw these — the number beside a row is its place in its
/// own section (`groupedPages`) — and this is not a second order: it is the same
/// `routeOrder` the canvas draws in and the same sequence the rows are listed
/// in, read as positions. What reads it is the ROW'S MOVE CONTROLS: a move
/// writes a flow move (`moveRoute`, ±1), so it is refused at the flow's ends,
/// and the ends are where this says 1 and N. That is why the panel asks for both
/// numberings, and why the drawn one is the section's.
///
/// The consequence, stated rather than discovered: a page that leads its group
/// while sitting in the middle of the flow has an ENABLED "up" that changes no
/// number in this panel — the flow moves, the section's order does not, and in
/// `groups` view no column moves either. It is enabled because it does act: it
/// moves the page one place in the sequence the canvas draws in `rows` and
/// `bands`, which is still the project's presentation order.
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
/// a route this panel cannot list has no row here, so preserving one would keep
/// an open page that nothing in this panel shows or closes. The CANVAS is not
/// why — `layoutGroups` builds its ungrouped tail from the open list itself,
/// with no manifest filter, so a stale route does draw a board; it is the
/// panel's rows that come from the manifest. The one open-routes state is a
/// subset of the manifest everywhere else too (`openRoute` filters through it),
/// so this cannot lose anything real.
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
