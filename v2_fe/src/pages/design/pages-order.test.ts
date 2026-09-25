import { describe, expect, it } from "vitest"

import type { RouteEntry } from "@/lib/design-api"
import { normalizeLayout, removeGroup } from "@/lib/design-layout"
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

  // `assignRoute` APPENDS, so a group's own `routes` array is assignment order —
  // and the canvas's `layoutGroups` renders in exactly that order. The panel
  // lists the project's canonical (manifest) order instead, so assigning a page
  // to a group never reshuffles unrelated rows. The two orders therefore differ
  // on purpose; see the module header.
  it("orders a group's pages by the manifest, not by the order they were assigned", () => {
    const result = groupedPages(
      layout([{ id: "g1", name: "Auth", routes: ["/signup", "/login"] }]),
      MANIFEST,
    )

    expect(result.groups[0].pages).toEqual(["/login", "/signup"])
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
})

describe("numberedPages", () => {
  // The flat list is the manifest and nothing else: no layout document reaches
  // this function, so no grouping edit can move a number. That is the property
  // the whole numbering rests on.
  it("numbers every page 1..N in manifest order", () => {
    expect(numberedPages(MANIFEST)).toEqual([
      { route: "/", n: 1 },
      { route: "/login", n: 2 },
      { route: "/signup", n: 3 },
      { route: "/settings", n: 4 },
    ])
  })

  // The case the sketch implies, from both sides at once: a group lists the
  // manifest's LAST two pages FIRST, and those pages are still numbered 3 and 4
  // — by where they sit in the project's route list, not by where the group
  // lists them. This is the one test that fails if the numbering is ever
  // re-pointed at the sections' sequence, and the panel's own test
  // (`pages-panel.test.ts`) pins the same thing in the markup the user reads.
  it("numbers a page by its manifest position, not by its position in its group", () => {
    const sections = groupedPages(
      layout([{ id: "g1", name: "Auth", routes: ["/settings", "/signup"] }]),
      MANIFEST,
    )

    expect(sections.groups[0].pages).toEqual(["/signup", "/settings"])
    expect(numberedPages(MANIFEST)).toEqual([
      { route: "/", n: 1 },
      { route: "/login", n: 2 },
      { route: "/signup", n: 3 },
      { route: "/settings", n: 4 },
    ])
  })

  it("numbers nothing when the project has no pages", () => {
    expect(numberedPages([])).toEqual([])
  })
})

describe("selectAllState", () => {
  // Bulk open is the SAME `openRoutes` state the rows write, so what it writes
  // is every page, in the order the canvas keeps open routes in — the manifest's.
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
