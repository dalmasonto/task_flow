import { describe, expect, it } from "vitest"

import type { RouteEntry } from "@/lib/design-api"
import { normalizeLayout, removeGroup } from "@/lib/design-layout"
import { groupedPages, type GroupedPages } from "./pages-order"

// The panel these helpers exist for is the Pages tab, and what it can silently
// get wrong is a row the user cannot find: a page missing from the list, listed
// twice under two different numbers, or numbered by something other than the
// position it is drawn in. None of those throws.
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

/// What the user reads, top to bottom: every section in display order, then the
/// tail. Assertions go through this rather than through `result.ungrouped` so a
/// test cannot pass while the page it names is drawn somewhere unexpected.
const sequence = (grouped: GroupedPages) => [
  ...grouped.groups.flatMap((section) => section.pages),
  ...grouped.ungrouped,
]

describe("groupedPages", () => {
  // The first-run state: every project before anyone opens the group picker.
  it("puts every page in ungrouped, numbered 1..N, when there are no groups", () => {
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
    expect(result.ungrouped).toEqual([{ route: "/", n: 4 }])
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

    expect(result.groups[0].pages).toEqual([
      { route: "/login", n: 1 },
      { route: "/signup", n: 2 },
    ])
  })

  // One 1..N series over the whole displayed sequence. Restarting per section
  // would print two different pages as "1", which is worse than no number: the
  // number's only job is to say where the page sits in the list.
  it("numbers continuously across the sections", () => {
    const result = groupedPages(
      layout([
        { id: "g1", name: "Auth", routes: ["/login"] },
        { id: "g2", name: "Admin", routes: ["/settings"] },
      ]),
      MANIFEST,
    )

    expect(sequence(result)).toEqual([
      { route: "/login", n: 1 },
      { route: "/settings", n: 2 },
      { route: "/", n: 3 },
      { route: "/signup", n: 4 },
    ])
  })

  // The same rule from the other side: the number is the DISPLAY slot, not the
  // page's index in the manifest. Here a group claims the manifest's last two
  // pages, and they are still the first two the user reads.
  it("numbers by displayed position, not by manifest position", () => {
    const result = groupedPages(
      layout([{ id: "g1", name: "Auth", routes: ["/settings", "/signup"] }]),
      MANIFEST,
    )

    expect(sequence(result)).toEqual([
      { route: "/signup", n: 1 },
      { route: "/settings", n: 2 },
      { route: "/", n: 3 },
      { route: "/login", n: 4 },
    ])
  })

  // The transition the user actually performs: delete a group, and the pages it
  // held come back to the tail. A page that silently vanishes from the panel is
  // the worst outcome here — nothing on screen says it is still open on the
  // canvas, and there is no affordance to bring it back.
  it("falls back to ungrouped when the group a page was in has been removed", () => {
    const grouped = layout([{ id: "g1", name: "Auth", routes: ["/login", "/signup"] }])
    const result = groupedPages(removeGroup(grouped, "g1"), MANIFEST)

    expect(result.groups).toEqual([])
    expect(sequence(result)).toEqual([
      { route: "/", n: 1 },
      { route: "/login", n: 2 },
      { route: "/signup", n: 3 },
      { route: "/settings", n: 4 },
    ])
  })

  // A group entry that is not a page at all — the manifest and the layout are
  // two separate fetches, and `normalizeLayout` keeps whatever routes a group
  // names (only the server's `filter_to_known` drops them, and it does that
  // against the manifest it read at that moment). Walking the group's `routes`
  // instead of the manifest would draw a row for a page that does not exist and
  // spend a number on it.
  it("ignores a group entry that is not a page in the manifest", () => {
    const result = groupedPages(
      layout([{ id: "g1", name: "Auth", routes: ["/ghost", "/login"] }]),
      MANIFEST,
    )

    expect(sequence(result)).toEqual([
      { route: "/login", n: 1 },
      { route: "/", n: 2 },
      { route: "/signup", n: 3 },
      { route: "/settings", n: 4 },
    ])
  })

  // The server refuses a document that puts one page in two groups, but the
  // client reads whatever it is sent, and the row's own picker resolves its
  // group with `groupOf` — a `find`, i.e. the FIRST group that names the route.
  // Listing a page under both would draw it twice, with two numbers, neither of
  // which matches the group the picker shows.
  it("lists a route two groups both claim once, under the first", () => {
    const result = groupedPages(
      layout([
        { id: "g1", name: "Auth", routes: ["/login"] },
        { id: "g2", name: "Admin", routes: ["/login", "/settings"] },
      ]),
      MANIFEST,
    )

    expect(result.groups[0].pages).toEqual([{ route: "/login", n: 1 }])
    expect(result.groups[1].pages).toEqual([{ route: "/settings", n: 2 }])
  })

  // `createGroup` makes an empty group and `+ New group` is the only way to do
  // it; dropping empty sections would make the button look like it did nothing.
  it("keeps an empty group as a section, so a just-created group is visible", () => {
    const result = groupedPages(layout([{ id: "g1", name: "Auth", routes: [] }]), MANIFEST)

    expect(result.groups).toEqual([{ id: "g1", name: "Auth", pages: [] }])
    expect(sequence(result).map((page) => page.n)).toEqual([1, 2, 3, 4])
  })

  // The invariant every test above is a special case of: the sections partition
  // the manifest. Nothing is dropped, nothing is repeated, and the numbers are
  // 1..N with no gap — whatever the document happens to say.
  it("never drops or repeats a page — the sections partition the manifest", () => {
    const result = groupedPages(
      layout([
        { id: "g1", name: "Auth", routes: ["/login"] },
        { id: "g2", name: "Admin", routes: ["/settings", "/ghost"] },
      ]),
      MANIFEST,
    )

    const shown = sequence(result)
    expect([...shown.map((page) => page.route)].sort()).toEqual(
      MANIFEST.map((route) => route.path).sort(),
    )
    expect(shown).toHaveLength(MANIFEST.length)
    expect(shown.map((page) => page.n)).toEqual([1, 2, 3, 4])
  })
})
