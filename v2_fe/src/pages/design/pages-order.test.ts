import { describe, expect, it } from "vitest"

import type { RouteEntry } from "@/lib/design-api"
import { moveRoute, normalizeLayout, removeGroup } from "@/lib/design-layout"
import { groupedPages, numberedPages, selectAllState, type GroupedPages } from "./pages-order"

// The panel these helpers exist for is the Pages tab, and what it can silently
// get wrong is a row the user cannot find or a number that moves under them: a
// page missing from the list, listed twice, or numbered by something other than
// where it sits in the project's own route list. None of those throws.
//
// The fixtures are the WIRE, following `design-comments.test.ts`: a document
// goes in through the real `normalizeLayout` read path (`fetchLayout` calls it
// on every response), so a fixture cannot be re-spelled to agree with a mistake
// in the module — the shapes have to match what the server actually sends.

const MANIFEST: RouteEntry[] = [
  { path: "/", file: "src/pages/Home.tsx", title: "Home" },
  { path: "/login", file: "src/pages/Login.tsx", title: "Sign in" },
  { path: "/signup", file: "src/pages/Signup.tsx", title: "Sign up" },
  { path: "/settings", file: "src/pages/Settings.tsx", title: "Settings" },
]

/// A layout document as `/api/design/{id}/layout` sends it.
const layout = (groups: { id: string; name: string; routes: string[] }[]) =>
  normalizeLayout({ view: "groups", routeOrder: [], groups, pageLabels: {} })

/// A layout with a FLOW set — the order the user built by moving pages up and
/// down — and nothing grouped. Same read path as `layout`.
const flowed = (routeOrder: string[]) =>
  normalizeLayout({ view: "groups", routeOrder, groups: [], pageLabels: {} })

/// Every route the Groups section lists, in display order: each group's pages,
/// then the ungrouped tail. Assertions go through this rather than through
/// `sections.ungrouped` so a test cannot pass while the page it names is listed
/// somewhere unexpected.
const listed = (sections: GroupedPages) => [
  ...sections.groups.flatMap((section) => section.pages),
  ...sections.ungrouped,
]

describe("groupedPages", () => {
  // The first-run state: every project before anyone opens the group picker.
  it("puts every page in the ungrouped tail when there are no groups", () => {
    const result = groupedPages(layout([]), MANIFEST)

    expect(result.groups).toEqual([])
    expect(result.ungrouped).toEqual(["/", "/login", "/signup", "/settings"])
  })

  it("lists the groups in document order, each with its pages, then the ungrouped rest", () => {
    const result = groupedPages(
      layout([
        { id: "g1", name: "Auth", routes: ["/login", "/signup"] },
        // Named so that a name sort would put it FIRST: "Admin" < "Auth". The
        // document order is the only order the user set, so it is the order.
        { id: "g2", name: "Admin", routes: ["/settings"] },
      ]),
      MANIFEST,
    )

    expect(result.groups.map((section) => [section.id, section.name])).toEqual([
      ["g1", "Auth"],
      ["g2", "Admin"],
    ])
    expect(result.groups[0].pages).toEqual(["/login", "/signup"])
    expect(result.ungrouped).toEqual(["/"])
  })

  // `assignRoute` APPENDS, so a group's own `routes` array is assignment order.
  // The panel lists the pages in the FLOW order instead — the pages' own order
  // when the user has set no flow, and the order they set otherwise — so
  // assigning a page to a group never reshuffles the rows under them, and the
  // section agrees with the flat list. See the module header.
  it("orders a group's pages by the pages' own order, not by the order they were assigned", () => {
    const result = groupedPages(
      layout([{ id: "g1", name: "Auth", routes: ["/signup", "/login"] }]),
      MANIFEST,
    )

    expect(result.groups[0].pages).toEqual(["/login", "/signup"])
  })

  // The same column, with a flow set: it is the flow that orders the section
  // now, in every view — the canvas draws its group columns the same way
  // (`layoutGroups`), which is what stops the panel and the boards disagreeing
  // about the sequence the user just built.
  it("orders a group's pages by the flow when one is set", () => {
    const result = groupedPages(
      normalizeLayout({
        view: "groups",
        routeOrder: ["/signup", "/login"],
        groups: [{ id: "g1", name: "Auth", routes: ["/login", "/signup"] }],
        pageLabels: {},
      }),
      MANIFEST,
    )

    expect(result.groups[0].pages).toEqual(["/signup", "/login"])
  })

  // The tail is the same list, so it is ordered the same way: the flow first,
  // then the pages it does not name, in their own order. A flow that named only
  // grouped pages would otherwise leave the tail in a different order from the
  // rows beside it.
  it("orders the ungrouped tail by the flow too", () => {
    const result = groupedPages(
      normalizeLayout({
        view: "groups",
        routeOrder: ["/settings", "/signup"],
        groups: [{ id: "g1", name: "Auth", routes: ["/settings"] }],
        pageLabels: {},
      }),
      MANIFEST,
    )

    expect(result.groups[0].pages).toEqual(["/settings"])
    expect(result.ungrouped).toEqual(["/signup", "/", "/login"])
  })

  // The sections carry ROUTES, not numbered pages: the numbering belongs to the
  // flat list, and a page has exactly one number — the one the user reads beside
  // its row. A section that also produced numbers would be a second series, and
  // it is structurally impossible here rather than merely undrawn: this is what
  // the panel iterates.
  it("lists its pages as routes, with no number attached", () => {
    const result = groupedPages(
      layout([{ id: "g1", name: "Auth", routes: ["/signup"] }]),
      MANIFEST,
    )

    expect(result.groups[0].pages).toEqual(["/signup"])
    expect(result.ungrouped).toEqual(["/", "/login", "/settings"])
  })

  // The transition the user actually performs: delete a group, and the pages it
  // held come back to the tail. A page that silently vanishes from the panel is
  // the worst outcome here — nothing on screen says it is still open on the
  // canvas, and there is no affordance to bring it back.
  it("falls back to ungrouped when the group a page was in has been removed", () => {
    const grouped = layout([{ id: "g1", name: "Auth", routes: ["/login", "/signup"] }])
    const result = groupedPages(removeGroup(grouped, "g1"), MANIFEST)

    expect(result.groups).toEqual([])
    expect(listed(result)).toEqual(["/", "/login", "/signup", "/settings"])
  })

  // A group entry that is not a page at all — the manifest and the layout are
  // two separate fetches, and `normalizeLayout` keeps whatever routes a group
  // names (only the server's `filter_to_known` drops them, and it does that
  // against the manifest it read at that moment). Walking the group's `routes`
  // instead of the manifest would list a route for a page that does not exist.
  it("ignores a group entry that is not a page in the manifest", () => {
    const result = groupedPages(
      layout([{ id: "g1", name: "Auth", routes: ["/ghost", "/login"] }]),
      MANIFEST,
    )

    expect(listed(result)).toEqual(["/login", "/", "/signup", "/settings"])
  })

  // The server refuses a document that puts one page in two groups, but the
  // client reads whatever it is sent, and the row's own picker resolves its
  // group with `groupOf` — a `find`, i.e. the FIRST group that names the route.
  // Listing a page under both would draw it twice, and neither listing would
  // match the group the picker shows.
  it("lists a route two groups both claim once, under the first", () => {
    const result = groupedPages(
      layout([
        { id: "g1", name: "Auth", routes: ["/login"] },
        { id: "g2", name: "Admin", routes: ["/login", "/settings"] },
      ]),
      MANIFEST,
    )

    expect(result.groups[0].pages).toEqual(["/login"])
    expect(result.groups[1].pages).toEqual(["/settings"])
  })

  // `createGroup` makes an empty group and `+ Add group` is the only way to do
  // it; dropping empty sections would make the button look like it did nothing.
  it("keeps an empty group as a section, so a just-created group is visible", () => {
    const result = groupedPages(layout([{ id: "g1", name: "Auth", routes: [] }]), MANIFEST)

    expect(result.groups).toEqual([{ id: "g1", name: "Auth", pages: [] }])
    expect(listed(result)).toEqual(["/", "/login", "/signup", "/settings"])
  })

  // The invariant every test above is a special case of: the sections partition
  // the manifest. Nothing is dropped and nothing is repeated, whatever the
  // document happens to say.
  it("never drops or repeats a page — the sections partition the manifest", () => {
    const result = groupedPages(
      layout([
        { id: "g1", name: "Auth", routes: ["/login"] },
        { id: "g2", name: "Admin", routes: ["/settings", "/ghost"] },
      ]),
      MANIFEST,
    )

    const shown = listed(result)
    expect([...shown].sort()).toEqual(MANIFEST.map((route) => route.path).sort())
    expect(shown).toHaveLength(MANIFEST.length)
  })

  // The same invariant, with the other reachable way to break it: the flow is a
  // snapshot taken when the project had different pages, so it names one that
  // is gone and does not name one it has. The sections are built from the flow
  // now (`resolveRouteOrder` appends what it does not name), so this is where a
  // page could quietly stop being listed at all.
  it("never drops or repeats a page when the stored flow is stale", () => {
    const result = groupedPages(
      normalizeLayout({
        view: "groups",
        routeOrder: ["/about", "/settings"],
        groups: [{ id: "g1", name: "Auth", routes: ["/login"] }],
        pageLabels: {},
      }),
      MANIFEST,
    )

    // The flow names a page that is gone (`/about`) and then `/settings`, so the
    // tail runs `/settings`, `/`, `/signup` — a sequence the pages' own order
    // cannot produce, which is what makes this fixture able to fail.
    const shown = listed(result)
    expect(shown).toEqual(["/login", "/settings", "/", "/signup"])
    expect([...shown].sort()).toEqual(MANIFEST.map((route) => route.path).sort())
  })
})

describe("numberedPages", () => {
  // The first-run state: no flow has been set, so the list is the manifest and
  // the numbers are the manifest's positions. This is the fallback every other
  // case is a departure from.
  it("numbers every page 1..N in the flow, which is the pages' own order until one is set", () => {
    expect(numberedPages(layout([]), MANIFEST)).toEqual([
      { route: "/", n: 1 },
      { route: "/login", n: 2 },
      { route: "/signup", n: 3 },
      { route: "/settings", n: 4 },
    ])
  })

  // The whole point of the numbers: once the user has ordered the screens into
  // a flow, the number beside a row is its position IN THAT FLOW — the list and
  // the canvas agree, and "the page at 3" means the third screen of the
  // sequence. The pages the flow does not name keep their own order after the
  // ones it does, so a reorder can never lose a page.
  it("numbers by the flow the user built, then the pages it does not name", () => {
    expect(numberedPages(flowed(["/settings", "/signup"]), MANIFEST)).toEqual([
      { route: "/settings", n: 1 },
      { route: "/signup", n: 2 },
      { route: "/", n: 3 },
      { route: "/login", n: 4 },
    ])
  })

  // The property the old numbering was built for, and which survives the change
  // of what the number MEANS: assigning a page to a group is a listing edit,
  // not a reorder — `assignRoute` does not touch `routeOrder` — so it cannot
  // move a page or renumber it. What can is an explicit move, and nothing else.
  it("does not renumber a page when it is grouped, only when it is moved", () => {
    const grouped = layout([{ id: "g1", name: "Auth", routes: ["/settings", "/signup"] }])
    const sections = groupedPages(grouped, MANIFEST)

    // The group lists the manifest's LAST two pages first, and they are still
    // numbered 3 and 4 — by where the flow puts them, which grouping did not
    // change.
    expect(sections.groups[0].pages).toEqual(["/signup", "/settings"])
    expect(numberedPages(grouped, MANIFEST)).toEqual(numberedPages(layout([]), MANIFEST))
    // ...and a move — and only a move — renumbers: the same pages, one flow
    // later, in a different order.
    expect(numberedPages(moveRoute(grouped, "/settings", -1, MANIFEST.map((r) => r.path)), MANIFEST)).toEqual([
      { route: "/", n: 1 },
      { route: "/login", n: 2 },
      { route: "/settings", n: 3 },
      { route: "/signup", n: 4 },
    ])
  })

  // The state a stored flow is always eventually in: written when the project
  // had different pages. A page it does not name must still be listed and
  // numbered — a page missing from the list has no row to open it from — and a
  // page it names that is gone must not be.
  it("numbers every page it is given, and only those, when the stored flow is stale", () => {
    const numbered = numberedPages(flowed(["/ghost", "/signup"]), MANIFEST)

    expect(numbered.map((page) => page.route)).toEqual(["/signup", "/", "/login", "/settings"])
    expect(numbered.map((page) => page.n)).toEqual([1, 2, 3, 4])
  })

  it("numbers nothing when the project has no pages", () => {
    expect(numberedPages(layout([]), [])).toEqual([])
  })
})

describe("selectAllState", () => {
  // Bulk open is the SAME `openRoutes` state the rows write, so what it writes
  // is every page, in the order that state keeps them in — the manifest's, which
  // is what `resolveRouteOrder` appends the pages the flow does not name in. The
  // flow is not this list's to write: it is shared, and it decides the order the
  // boards are DRAWN in, not which of them are open.
  it("offers Select all while any page is closed, and writes every page in manifest order", () => {
    const state = selectAllState(MANIFEST, [])

    expect(state.allOpen).toBe(false)
    expect(state.label).toBe("Select all")
    expect(state.next).toEqual(["/", "/login", "/signup", "/settings"])
  })

  // Partly open is still "Select all": the control summarises, so it is checked
  // only when there is nothing left to open.
  it("offers Select all while only some pages are open", () => {
    const state = selectAllState(MANIFEST, ["/login"])

    expect(state.allOpen).toBe(false)
    expect(state.label).toBe("Select all")
    expect(state.next).toEqual(["/", "/login", "/signup", "/settings"])
  })

  it("offers Deselect once every page is open, and writes nothing", () => {
    const state = selectAllState(MANIFEST, ["/", "/login", "/signup", "/settings"])

    expect(state.allOpen).toBe(true)
    expect(state.label).toBe("Deselect")
    expect(state.next).toEqual([])
  })

  // The open routes are not necessarily the manifest's — the manifest is
  // fetched separately and a stale tab can hold a route the project no longer
  // has. The control writes the PAGES, so a route that is not one of them is
  // not preserved: there is no board it could draw.
  it("writes the manifest's pages, not whatever happens to be open", () => {
    const state = selectAllState(MANIFEST, ["/", "/login", "/signup", "/settings", "/ghost"])

    expect(state.allOpen).toBe(true)
    expect(state.next).toEqual([])
  })

  // Vacuous truth would read "Deselect" over a project with no pages — a
  // checked box offering to close nothing. The panel does not draw the control
  // in that state (there is nothing to select), and this is the definition it
  // would fall back on if it did.
  it("reads Select all when there are no pages at all", () => {
    const state = selectAllState([], [])

    expect(state.allOpen).toBe(false)
    expect(state.label).toBe("Select all")
    expect(state.next).toEqual([])
  })
})
