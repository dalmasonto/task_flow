import { describe, expect, it } from "vitest"

import type { RouteEntry } from "@/lib/design-api"
import { moveRoute, normalizeLayout, removeGroup } from "@/lib/design-layout"
import { groupedPages, numberedPages, selectAllState, type GroupedPages } from "./pages-order"

// The panel these helpers exist for is the Pages tab, and what it can silently
// get wrong is a row the user cannot find or a number that moves under them: a
// page missing from the panel, listed TWICE — once under its group and once in
// the ungrouped section — or numbered by something other than its place in the
// section it is listed under. None of those throws.
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

/// Every route the panel lists, in display order: each group's pages, then the
/// ungrouped section. Assertions go through this rather than through
/// `sections.ungrouped` so a test cannot pass while the page it names is listed
/// somewhere unexpected.
const listed = (sections: GroupedPages) => [
  ...sections.groups.flatMap((section) => section.pages),
  ...sections.ungrouped,
].map((page) => page.route)

/// The sections as LISTS of numbered pages, the way the panel draws them: each
/// group's, then the ungrouped section's. The numbering tests read this rather
/// than the sections individually, because "every section starts at 1 and runs
/// without a gap" is one property of the whole result.
const numbered = (sections: GroupedPages) => [
  ...sections.groups.map((section) => section.pages),
  sections.ungrouped,
]

describe("groupedPages", () => {
  // The first-run state: every project before anyone opens the group picker.
  // There is no group, so the whole manifest is the ungrouped section, and its
  // numbering starts there.
  it("puts every page in the ungrouped section when there are no groups", () => {
    const result = groupedPages(layout([]), MANIFEST)

    expect(result.groups).toEqual([])
    expect(result.ungrouped).toEqual([
      { route: "/", n: 1 },
      { route: "/login", n: 2 },
      { route: "/signup", n: 3 },
      { route: "/settings", n: 4 },
    ])
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
    expect(result.groups[0].pages).toEqual([
      { route: "/login", n: 1 },
      { route: "/signup", n: 2 },
    ])
    expect(result.ungrouped).toEqual([{ route: "/", n: 1 }])
  })

  // The panel's numbering, and the rule it replaced a flat 1..N with: the
  // number beside a row is the page's place in the SECTION it is listed under.
  // Two screens in Auth read "1, 2" — the user's own example — and the next
  // group starts again at "1" rather than continuing the count.
  it("numbers a group's pages 1..n within the group", () => {
    const result = groupedPages(
      layout([{ id: "g1", name: "Auth", routes: ["/login", "/signup"] }]),
      MANIFEST,
    )

    expect(result.groups[0].pages).toEqual([
      { route: "/login", n: 1 },
      { route: "/signup", n: 2 },
    ])
  })

  it("starts every group at 1, and the ungrouped section at 1 of its own", () => {
    const result = groupedPages(
      layout([
        { id: "g1", name: "Auth", routes: ["/login", "/signup"] },
        { id: "g2", name: "Ops", routes: ["/settings"] },
      ]),
      MANIFEST,
    )

    expect(numbered(result)).toEqual([
      [
        { route: "/login", n: 1 },
        { route: "/signup", n: 2 },
      ],
      [{ route: "/settings", n: 1 }],
      [{ route: "/", n: 1 }],
    ])
  })

  // The number depends on the page's place IN ITS SECTION and nothing else —
  // not on where the flow puts it overall. The fixture interleaves the two
  // groups and the ungrouped page in the flow, so a numbering that leaked the
  // flow's position would read /signup 3, /login 4, /settings 1, / 2 — four
  // different numbers — instead of two 1s, a 2 and a 1.
  it("numbers by the place in the section, not by the place in the flow", () => {
    const result = groupedPages(
      normalizeLayout({
        view: "groups",
        routeOrder: ["/settings", "/", "/signup", "/login"],
        groups: [
          { id: "g1", name: "Auth", routes: ["/signup", "/login"] },
          { id: "g2", name: "Ops", routes: ["/settings"] },
        ],
        pageLabels: {},
      }),
      MANIFEST,
    )

    expect(numbered(result)).toEqual([
      [
        { route: "/signup", n: 1 },
        { route: "/login", n: 2 },
      ],
      [{ route: "/settings", n: 1 }],
      [{ route: "/", n: 1 }],
    ])
  })

  // `assignRoute` APPENDS, so a group's own `routes` array is assignment order.
  // The panel lists the pages in the FLOW order instead — the pages' own order
  // when the user has set no flow, and the order they set otherwise — so
  // assigning a page to a group never reshuffles the rows under them, and the
  // section reads in the same order as the canvas column it mirrors. See the
  // module header.
  it("orders a group's pages by the pages' own order, not by the order they were assigned", () => {
    const result = groupedPages(
      layout([{ id: "g1", name: "Auth", routes: ["/signup", "/login"] }]),
      MANIFEST,
    )

    expect(result.groups[0].pages.map((page) => page.route)).toEqual(["/login", "/signup"])
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

    expect(result.groups[0].pages.map((page) => page.route)).toEqual(["/signup", "/login"])
  })

  // The ungrouped section is the same list, so it is ordered the same way: the
  // flow first, then the pages it does not name, in their own order. A flow that
  // named only grouped pages would otherwise leave the section in a different
  // order from the rows beside it.
  it("orders the ungrouped section by the flow too", () => {
    const result = groupedPages(
      normalizeLayout({
        view: "groups",
        routeOrder: ["/settings", "/signup"],
        groups: [{ id: "g1", name: "Auth", routes: ["/settings"] }],
        pageLabels: {},
      }),
      MANIFEST,
    )

    expect(result.groups[0].pages.map((page) => page.route)).toEqual(["/settings"])
    expect(result.ungrouped.map((page) => page.route)).toEqual(["/signup", "/", "/login"])
  })

  // The numbering is the panel's ONLY numbering now — the flat list that used
  // to carry a global 1..N is gone, and its number was what these rows show
  // from their own section. So the test that used to stand here ("lists its
  // pages as routes, with no number attached", on the grounds that a numbered
  // section would be a second series) is retired rather than adjusted: the
  // section's number IS the panel's number, and there is no second series to
  // collide with. What must hold instead is the numbering's own invariant, and
  // it is asserted with the partition below — every section runs 1, 2, 3 … from
  // 1 with no gap and no repeat — plus the section cases above.

  // The transition the user actually performs: delete a group, and the pages it
  // held come back to the ungrouped section. A page that silently vanishes from
  // the panel is the worst outcome here — nothing on screen says it is still
  // open on the canvas, and there is no affordance to bring it back.
  //
  // This is also the case Task 16 parked as untested: a page that falls back
  // must be RENUMBERED by the place it takes there, and the group that survives
  // must keep its own numbering. The second group is the whole reason this
  // fixture has two: with one group, "each section numbers from 1" and "one
  // counter that happened to start at 1" produce the same result, and only the
  // survivor tells them apart.
  it("renumbers a page that falls back to ungrouped when its group is removed", () => {
    const grouped = layout([
      { id: "g1", name: "Auth", routes: ["/login", "/signup"] },
      { id: "g2", name: "Ops", routes: ["/settings"] },
    ])
    // The state before the removal: /login is "1" inside Auth, and /settings is
    // "1" inside Ops — two sections that both start at 1.
    expect(numbered(groupedPages(grouped, MANIFEST))).toEqual([
      [
        { route: "/login", n: 1 },
        { route: "/signup", n: 2 },
      ],
      [{ route: "/settings", n: 1 }],
      [{ route: "/", n: 1 }],
    ])

    const after = groupedPages(removeGroup(grouped, "g1"), MANIFEST)

    // Auth is gone, so its pages are in the ungrouped section, numbered by
    // where the flow puts them there: /login is "2" rather than the "1" it wore
    // inside Auth. The surviving group is untouched — /settings is still "1" —
    // which is what makes this a renumbering of the removed group's pages
    // rather than a count that ran on.
    expect(after.groups).toEqual([
      { id: "g2", name: "Ops", pages: [{ route: "/settings", n: 1 }] },
    ])
    expect(after.ungrouped).toEqual([
      { route: "/", n: 1 },
      { route: "/login", n: 2 },
      { route: "/signup", n: 3 },
    ])
  })

  // The SAME transition with the other group removed — and the two are not the
  // same case, however much they look it. Removing the FIRST of two groups
  // cannot tell `removeGroup`'s filter apart from "drop the first group": the
  // answer is the surviving group either way, so the test above passes under
  // both. Removing the SECOND can, because the right answer keeps a group the
  // mutation has thrown away. That is the only difference between this fixture
  // and the one above, and it is the whole reason this case exists.
  //
  // The shape it guards is data loss with nothing on screen to say so: a page
  // whose group silently disappears from the panel is still open on the canvas
  // with no row to close it, and its siblings fall into the ungrouped section
  // without ever having been ungrouped.
  //
  // Stated plainly, because it bounds what this is worth: `removeGroup` has NO
  // CALLER today (`git grep removeGroup v2_fe/src` → `lib/design-layout.ts`'s
  // definition and its own unit tests, nothing else). This is coverage of an
  // unwired contract, not a live bug — group delete is still unbuilt.
  it("keeps the FIRST group when the second of two is removed", () => {
    const grouped = layout([
      { id: "g1", name: "Auth", routes: ["/login", "/signup"] },
      { id: "g2", name: "Ops", routes: ["/settings"] },
    ])

    const result = groupedPages(removeGroup(grouped, "g2"), MANIFEST)

    expect(result.groups).toEqual([
      {
        id: "g1",
        name: "Auth",
        pages: [
          { route: "/login", n: 1 },
          { route: "/signup", n: 2 },
        ],
      },
    ])
    // /settings was Ops's only page, so it falls back to the ungrouped section
    // and takes its place there by the flow.
    expect(result.ungrouped).toEqual([
      { route: "/", n: 1 },
      { route: "/settings", n: 2 },
    ])
    expect(listed(result)).toHaveLength(MANIFEST.length)
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

    expect(result.groups[0].pages.map((page) => page.route)).toEqual(["/login"])
    expect(result.groups[1].pages.map((page) => page.route)).toEqual(["/settings"])
  })

  // `createGroup` makes an empty group and `+ Add group` is the only way to do
  // it; dropping empty sections would make the button look like it did nothing.
  it("keeps an empty group as a section, so a just-created group is visible", () => {
    const result = groupedPages(layout([{ id: "g1", name: "Auth", routes: [] }]), MANIFEST)

    expect(result.groups).toEqual([{ id: "g1", name: "Auth", pages: [] }])
    expect(listed(result)).toEqual(["/", "/login", "/signup", "/settings"])
  })

  // The invariant every test above is a special case of, and the panel's
  // headline requirement: the sections partition the manifest, so nothing is
  // dropped and NOTHING IS LISTED TWICE, whatever the document happens to say.
  // A page in two places is what replacing the flat list with per-group lists
  // makes reachable — it would draw two rows writing the same open state.
  //
  // The numbering's own invariant rides along here because it is the same
  // property one level down: every section numbers 1, 2, 3 … from 1, with no
  // gap, no repeat and no number borrowed from another section.
  it("never drops or repeats a page, and numbers each section 1..n", () => {
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

    for (const section of numbered(result)) {
      expect(section.map((page) => page.n)).toEqual(section.map((_, i) => i + 1))
    }
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
  // The flow's own numbering, which the panel no longer DRAWS — a row's number
  // is its place in its section now (`groupedPages`) — but which bounds the
  // row's move controls, because those write a flow move and therefore stop at
  // the flow's ends. Its first-run state: no flow set, so the sequence is the
  // manifest and the numbers are the manifest's positions.
  it("numbers every page 1..N in the flow, which is the pages' own order until one is set", () => {
    expect(numberedPages(layout([]), MANIFEST)).toEqual([
      { route: "/", n: 1 },
      { route: "/login", n: 2 },
      { route: "/signup", n: 3 },
      { route: "/settings", n: 4 },
    ])
  })

  // Once the user has ordered the screens into a flow, a page's position in it
  // is what the move controls are bounded by and what the canvas draws in:
  // "the page at 3" is the third screen of the sequence. The pages the flow does
  // not name keep their own order after the ones it does, so a reorder can never
  // lose a page.
  it("numbers by the flow the user built, then the pages it does not name", () => {
    expect(numberedPages(flowed(["/settings", "/signup"]), MANIFEST)).toEqual([
      { route: "/settings", n: 1 },
      { route: "/signup", n: 2 },
      { route: "/", n: 3 },
      { route: "/login", n: 4 },
    ])
  })

  // The property the numbering was built for, and which survives the change of
  // what the DRAWN number means: assigning a page to a group is a listing edit,
  // not a reorder — `assignRoute` does not touch `routeOrder` — so it cannot
  // move a page in the flow or renumber it there. What can is an explicit move,
  // and nothing else.
  it("does not renumber a page when it is grouped, only when it is moved", () => {
    const grouped = layout([{ id: "g1", name: "Auth", routes: ["/settings", "/signup"] }])
    const sections = groupedPages(grouped, MANIFEST)

    // The group lists the manifest's LAST two pages first, and the flow still
    // puts them at 3 and 4 — which is where the arrows say they are — while the
    // numbers the ROWS show are the group's own 1 and 2.
    expect(sections.groups[0].pages).toEqual([
      { route: "/signup", n: 1 },
      { route: "/settings", n: 2 },
    ])
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
  // had different pages. A page it does not name must still have a position — a
  // page missing from the sequence has no row and no bounds — and a page it
  // names that is gone must not be numbered at all.
  it("numbers every page it is given, and only those, when the stored flow is stale", () => {
    const pages = numberedPages(flowed(["/ghost", "/signup"]), MANIFEST)

    expect(pages.map((page) => page.route)).toEqual(["/signup", "/", "/login", "/settings"])
    expect(pages.map((page) => page.n)).toEqual([1, 2, 3, 4])
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
