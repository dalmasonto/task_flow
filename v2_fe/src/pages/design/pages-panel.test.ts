import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { DesignManifest, RouteEntry } from "@/lib/design-api"
import { normalizeLayout, type LayoutDoc } from "@/lib/design-layout"
import { PagesPanel } from "./pages-panel"

// The panel's own rules, at the level `pages-order.test.ts` cannot reach: what
// the JSX actually DRAWS. `groupedPages` decides the order and the numbers, and
// its test pins those — but nothing there would notice if the number slot moved
// to the right of the name, or if "Ungrouped" were drawn above a list where
// nothing is grouped. This file covers exactly those, plus the row a group entry
// that is not a page must not produce.
//
// It renders the REAL component — `createElement(PagesPanel, props)` and
// `renderToStaticMarkup` — never `PagesPanel(props)` called as a function. A
// direct call skips React's element boundary, which happens to work only because
// the panel has no hooks today; the first `useState` added to it would turn every
// such call into an "Invalid hook call" instead of a render.
//
// `renderToStaticMarkup` runs in the default node environment: no jsdom, no
// Testing Library, no new dependency. It is a `.ts` and not a `.tsx` because
// `vite.config.ts` collects only `src/**/*.test.ts` — a `.tsx` here would never
// run — and `createElement` needs no JSX syntax.
//
// Scope: this is the SSR MARKUP only. Nothing here clicks or types, so the
// panel's interactions — the select's commit, the rename box's blur/Escape, the
// `+ New group` prompt — stay untested, as they were.

/// A layout document as `/api/design/{id}/layout` sends it, through the same
/// read path `fetchLayout` uses — the fixtures are the wire, as in
/// `pages-order.test.ts`.
const layout = (raw: Partial<Record<keyof LayoutDoc, unknown>>): LayoutDoc =>
  normalizeLayout({ view: "groups", routeOrder: [], groups: [], pageLabels: {}, ...raw })

/// A manifest as `/api/design/{id}/manifest` sends it. The panel reads only
/// `routes`; the rest is spelled out because the prop is the whole document,
/// and a test that narrowed the type would stop compiling the day the panel
/// reads one more field.
const manifest = (routes: RouteEntry[]): DesignManifest => ({
  project: 1,
  routes,
  components: [],
  tokens: [],
  revision: 1,
  resources: [],
})

const MANIFEST: RouteEntry[] = [
  { path: "/", file: "src/pages/Home.tsx", title: "Home" },
  { path: "/login", file: "src/pages/Login.tsx", title: "Sign in" },
  { path: "/signup", file: "src/pages/Signup.tsx", title: "Sign up" },
  { path: "/settings", file: "src/pages/Settings.tsx", title: "Settings" },
]

/// The rendered markup as one static string. The props are the panel's whole
/// contract; the two callbacks never run here (nothing is clicked), which is why
/// they can be no-ops in an environment with no `window` behind them. A `null`
/// manifest is the panel's own load state, not a special case of the test.
const render = (doc: LayoutDoc, routes: RouteEntry[] | null = MANIFEST) =>
  renderToStaticMarkup(
    createElement(PagesPanel, {
      manifest: routes ? manifest(routes) : null,
      openRoutes: ["/"],
      onToggleRoute: () => {},
      layout: doc,
      onLayoutChange: () => {},
    }),
  )

/// The section headings, in the order they are drawn. Matched on the `<h3>` and
/// its TEXT, deliberately not on the class — a heading that is restyled is still
/// this heading, and a test that pinned the class string would fail on every
/// styling tweak while saying nothing about the list.
const headings = (html: string) =>
  [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1])

/// Each row's number and page name as drawn, in document order. A pair is a
/// digits-only span with the page's name span IMMEDIATELY after it — which is
/// the panel's own rule (the number sits in a fixed-width slot to the LEFT of
/// the name), so a number moved to the right of the name breaks the pairing and
/// the assertion below reports it. Nothing else in the panel's markup has that
/// shape: the route span that follows the name holds a path, not digits.
const numbered = (html: string) =>
  [...html.matchAll(/<span[^>]*>\s*(\d+)\s*<\/span>\s*<span[^>]*>([^<]*)<\/span>/g)].map(
    (m) => [m[1], m[2]] as const,
  )

describe("PagesPanel", () => {
  it("draws the sections in order, numbered by displayed position, with no row for a non-page", () => {
    const html = render(
      layout({
        groups: [
          // Assignment order reversed against the manifest, so "signup before
          // settings" is the manifest's order and not this array's.
          { id: "g1", name: "Auth", routes: ["/settings", "/signup"] },
          // "Admin" names no page at all — it keeps its heading and draws
          // nothing. `/ghost` is an entry that is not in the manifest.
          { id: "g2", name: "Admin", routes: ["/ghost"] },
        ],
        pageLabels: { "/settings": "Preferences" },
      }),
    )

    // Document order, NOT alphabetical ("Admin" sorts before "Auth"), and the
    // tail last, named only because something above it is grouped.
    expect(headings(html)).toEqual(["Auth", "Admin", "Ungrouped"])

    // 1..4 over the whole sequence and in ONE series: the group claims the
    // manifest's LAST two pages and still draws them first. Numbering by
    // manifest index would give Sign up=3, Preferences=4, Home=1, Sign in=2.
    // The markup rides in the message because the likeliest break is a change
    // to the row's shape, which is exactly the case where this list comes back
    // empty and says nothing about why.
    expect(numbered(html), `rendered markup:\n${html}`).toEqual([
      ["1", "Sign up"],
      ["2", "Preferences"],
      ["3", "Home"],
      ["4", "Sign in"],
    ])

    // The rename resolver wins over the manifest title: the page's own title
    // must not be drawn as well.
    expect(html).not.toContain(">Settings<")
    // A group entry that is not a page spends no row and no number. This is
    // reachable without a server bug: the manifest and the layout are two
    // separate fetches, and `normalizeLayout` keeps whatever a group names.
    expect(html).not.toContain("/ghost")
  })

  it("draws no headings at all when nothing is grouped", () => {
    const html = render(layout({}))

    // With no groups every page is ungrouped, and a lone "Ungrouped" above the
    // whole list names the entire panel rather than a section of it.
    expect(headings(html)).toEqual([])
    expect(html).not.toContain("Ungrouped")
    expect(numbered(html), `rendered markup:\n${html}`).toEqual([
      ["1", "Home"],
      ["2", "Sign in"],
      ["3", "Sign up"],
      ["4", "Settings"],
    ])
  })

  it("draws no sections while the manifest is still loading", () => {
    // The layout can arrive before the manifest does, and the panel is mounted
    // for the whole load. Headings stacked above "No pages yet." would draw the
    // loading state as if it were the result — and "Ungrouped" would be a
    // section name for nothing at all.
    const html = render(
      layout({ groups: [{ id: "g1", name: "Auth", routes: ["/login"] }] }),
      null,
    )

    expect(headings(html)).toEqual([])
    expect(html).not.toContain("Ungrouped")
    expect(html).toContain("No pages yet.")
  })
})
