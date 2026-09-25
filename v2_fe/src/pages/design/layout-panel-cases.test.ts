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
import { normalizeLayout, resolveRouteOrder, type LayoutDoc } from "@/lib/design-layout"
import { groupedPages } from "./pages-order"

type PanelCase = {
  name: string
  manifest: string[]
  doc: unknown
  expect: {
    flow: string[]
    groups: { id: string; name: string; routes: string[] }[]
    ungrouped: string[]
  }
}

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
/// the two resolvers the panel itself calls.
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
  }
}

describe("the panel's resolution against the shared case table", () => {
  it("carries cases", () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(5)
  })

  for (const panelCase of table.cases) {
    it(panelCase.name, () => {
      expect(resolve(panelCase.doc, panelCase.manifest)).toEqual(panelCase.expect)
    })
  }
})
