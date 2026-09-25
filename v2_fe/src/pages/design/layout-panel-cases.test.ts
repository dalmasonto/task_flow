/// The panel's arrangement rules, pinned against the SERVER's by a shared table.
///
/// The same file is read by `layout_doc.rs`'s
/// `the_panels_resolution_matches_the_shared_case_table` through `include_str!`,
/// running `resolve_route_order` + `panel_sections` over the same cases. The two
/// implementations exist on purpose — this app resolves the arrangement locally
/// because the Pages panel draws optimistically, before any round trip, and the
/// server resolves it because `design_read_layout` has to answer with the
/// arrangement rather than the document — but they must not DRIFT, and both rule
/// sets have changed once already (`pages-order.ts` records a wrong earlier
/// version of the move rule and a changed section-drawing rule). Prose naming
/// the other implementation cannot fail when the two disagree; this can.
///
/// It reads the file rather than importing it so the fixture stays one artifact
/// in one place — a copy under `src/` would be a second table, which is the
/// state this exists to prevent.

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import type { RouteEntry } from "@/lib/design-api"
import {
  normalizeLayout,
  pageLabel,
  resolveRouteOrder,
  type LayoutDoc,
} from "@/lib/design-layout"
import { groupedPages } from "./pages-order"

type PanelCase = {
  name: string
  manifest: string[]
  doc: unknown
  expect: {
    flow: string[]
    groups: { id: string; name: string; routes: string[] }[]
    ungrouped: string[]
    names: Record<string, string>
  }
}

/// The cases this table is pinned to carry, by NAME.
///
/// A floor (`length >= 5` against a table of six) held nothing: delete a case
/// and both readers stayed green, so the guard could be retired by removing the
/// thing it guards — which is what a reviewer did, with the client drift it was
/// there to catch still live. Names also fail a case that was REPLACED rather
/// than deleted, because the old name is then absent.
///
/// `layout_doc.rs` carries the same list: neither reader can derive it from the
/// other, and a name is what makes the two tables provably the same table.
/// Adding a case is a deliberate edit HERE as well — that is the point.
const PANEL_CASE_NAMES: string[] = [
  "a fresh project lists every page ungrouped, in manifest order",
  "the stored flow orders the pages it names, and every page it does not name is appended in manifest order",
  "a group's pages are listed in flow order, not in the order its own routes array holds",
  "groups keep the document's order, and the ungrouped pages are the complement",
  "a route two groups claim lists under the first of them, and an empty group keeps its section",
  "a hand-edited document naming a page that is gone, and naming one twice, keeps its grouping and drops what it cannot place",
  "a page reads as its label where it has one, and as the manifest title where it does not",
]

/// Four levels up from `src/pages/design/` is the repository root.
const CASES_URL = new URL(
  "../../../../backend/plugins/taskflow-design/tests/fixtures/layout_panel_cases.json",
  import.meta.url,
)

const table = JSON.parse(readFileSync(CASES_URL, "utf8")) as { cases: PanelCase[] }

/// The manifest as the panel receives it. `groupedPages` reads `path` and
/// nothing else, so the file and title are here only to make the entries the
/// shape the app really passes.
const entries = (paths: string[]): RouteEntry[] =>
  paths.map((path) => ({ path, file: `pages${path === "/" ? "/index" : path}.html`, title: path }))

/// The panel's answer for one case, in the table's shape: the document through
/// the real read path (`fetchLayout` normalises every response this way), then
/// the resolvers the panel itself calls.
const resolve = (raw: unknown, manifest: string[]) => {
  const doc: LayoutDoc = normalizeLayout(raw)
  const routes = entries(manifest)
  const { groups, ungrouped } = groupedPages(doc, routes)
  return {
    flow: resolveRouteOrder(doc, manifest),
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      routes: group.pages.map((page) => page.route),
    })),
    ungrouped: ungrouped.map((page) => page.route),
    // The label-or-title composite, through the same resolver the panel names
    // its rows with — and past `normalizeLayout`, so the table catches a client
    // that loses or ignores `pageLabels` on the way in. Every page of the
    // manifest, not only the labelled ones: naming only those would make a
    // resolver that ignores labels entirely look correct.
    //
    // `entries` gives each page the ROUTE as its title (the fixture says why),
    // so this pins the CHOICE between label and title, not a title's derivation.
    names: Object.fromEntries(
      manifest.map((route) => [route, pageLabel(doc, route, route)]),
    ),
  }
}

describe("the panel's resolution against the shared case table", () => {
  it("carries exactly the cases it is pinned to", () => {
    const names = table.cases.map((panelCase) => panelCase.name)
    const missing = PANEL_CASE_NAMES.filter((name) => !names.includes(name))
    const extra = names.filter((name) => !PANEL_CASE_NAMES.includes(name))
    expect(
      { missing, extra },
      `the shared case table no longer matches the names this reader is pinned to; it ` +
        `carries: ${names.join(" | ")}. A case is not deleted to make a suite pass — fix ` +
        `the rule it caught, and a deliberate addition updates PANEL_CASE_NAMES in BOTH ` +
        `readers.`,
    ).toEqual({ missing: [], extra: [] })
  })

  for (const panelCase of table.cases) {
    it(panelCase.name, () => {
      expect(resolve(panelCase.doc, panelCase.manifest)).toEqual(panelCase.expect)
    })
  }
})
