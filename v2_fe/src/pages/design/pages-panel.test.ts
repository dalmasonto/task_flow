import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { DesignManifest, RouteEntry } from "@/lib/design-api"
import { normalizeLayout, type LayoutDoc } from "@/lib/design-layout"
import { PagesPanel } from "./pages-panel"

// The panel's own rules, at the level `pages-order.test.ts` cannot reach: what
// the JSX actually DRAWS. `groupedPages`, `numberedPages` and `selectAllState`
// decide the sections, the numbers and the bulk control's state, and their tests
// pin those — but nothing there would notice a number drawn to the RIGHT of the
// name, a bullet that grew a number of its own, a group picker showing `g1`
// where the group is called Auth, or the bulk control missing from a panel with
// pages. This file covers exactly those.
//
// It renders the REAL component — `createElement(PagesPanel, props)` and
// `renderToStaticMarkup` — never `PagesPanel(props)` called as a function. A
// direct call skips React's element boundary, and the panel HAS hooks now (the
// `+ Add group` dialog's open state), so such a call would be an "Invalid hook
// call" instead of a render: this file's idiom is the only one that works.
//
// `renderToStaticMarkup` runs in the default node environment: no jsdom, no
// Testing Library, no new dependency. It is a `.ts` and not a `.tsx` because
// `vite.config.ts` collects only `src/**/*.test.ts` — a `.tsx` here would never
// run — and `createElement` needs no JSX syntax.
//
// Scope: this is the SSR MARKUP only. Nothing here clicks or types, so the
// panel's interactions — the select's commit, clicking a name into its label
// editor, the bulk control's write — stay untested, as they were. Two things are
// out of reach here for a second reason: the dialog's popup and the Select's
// items live in client-only portals (`@base-ui/react`'s FloatingPortal renders
// nothing on the server), so only the row's own markup exists until a browser
// mounts them.

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
/// contract; the callbacks never run here (nothing is clicked), which is why
/// they can be no-ops in an environment with no `window` behind them. A `null`
/// manifest is the panel's own load state, not a special case of the test, and
/// `openRoutes` is a parameter because it is what the two bulk states are.
const render = (
  doc: LayoutDoc,
  options: { routes?: RouteEntry[] | null; open?: string[] } = {},
) => {
  const routes = options.routes === undefined ? MANIFEST : options.routes
  return renderToStaticMarkup(
    createElement(PagesPanel, {
      manifest: routes ? manifest(routes) : null,
      openRoutes: options.open ?? ["/"],
      onToggleRoute: () => {},
      onOpenRoutesChange: () => {},
      layout: doc,
      onLayoutChange: () => {},
    }),
  )
}

/// The section heading, in the order drawn. Matched on the `<h3>` and its TEXT,
/// deliberately not on the class — a heading that is restyled is still this
/// heading, and a test that pinned the class string would fail on every styling
/// tweak while saying nothing about the list.
const headings = (html: string) =>
  [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1])

/// The Groups section as drawn: each group's numbered name, then the bullets
/// under it. Split on the group headings, so a group's bullets are the `<li>`s
/// between its heading and the next one — and the flat list, whose rows are
/// divs, cannot leak into them. The bullets are asserted as plain names, so a
/// number that grew one would fail here rather than pass unnoticed.
const groupList = (html: string) =>
  html
    .split(/<h4/)
    .slice(1)
    .map((block) => ({
      name: block.slice(block.indexOf(">") + 1, block.indexOf("</h4>")),
      bullets: [...block.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((m) => m[1]),
    }))

/// Every row of the flat list, in document order. Rows are found by their canvas
/// checkbox — the control the sketch draws first — and each is then read as the
/// shape the sketch lays out: the number, the name, and the group its select
/// shows. Splitting on the checkbox is what keeps the parse one row long: the
/// chunk between two checkboxes cannot reach another row's select. Each control
/// is anchored on the aria-label the panel gives it (`Show <route> …`,
/// `Label for <route>`, `Group for <route>`), never on a class string, and the
/// select's own route comes back with its label, so a select that drifted onto
/// the wrong row fails rather than passing quietly.
const rows = (html: string) =>
  html
    .split(/<input/)
    .slice(1)
    .flatMap((chunk) => {
      // The split consumed the opening tag, so the chunk STARTS with the
      // checkbox's own attributes. (`<input` also opens each Select's hidden
      // input, which is what bounds a row from the right — it carries no
      // `Show …` label and is dropped a line below.)
      const box = /^([^>]*)>/.exec(chunk)?.[1] ?? ""
      const route = /aria-label="Show ([^"]*) on the canvas"/.exec(box)?.[1]
      // The bulk control is a checkbox too, and it is not a row.
      if (!route) return []
      const number = /<span[^>]*>(\d+\.)<\/span>/.exec(chunk)
      const name = /<button[^>]*aria-label="Label for ([^"]*)"[^>]*>([^<]*)<\/button>/.exec(chunk)
      const group = /aria-label="Group for ([^"]*)"[^>]*>\s*<span[^>]*>([^<]*)<\/span>/.exec(chunk)
      return [
        {
          route,
          open: box.includes("checked"),
          n: number?.[1] ?? null,
          name: name?.[2] ?? null,
          group: { route: group?.[1] ?? null, label: group?.[2] ?? null },
        },
      ]
    })

/// The bulk control: its own box, and the word beside it. `null` when the panel
/// draws no such control, which is a state worth asserting rather than skipping.
///
/// It matches the panel's only `<label>` around exactly one checkbox plus text —
/// the bulk control, whose word IS its label. The dialog's field is a `<label>`
/// too, but it lives in a portal the server never renders.
const bulk = (html: string) => {
  const match = /<label[^>]*><input([^>]*)>([^<]*)<\/label>/.exec(html)
  return match ? { checked: match[1].includes("checked"), label: match[2] } : null
}

/// The move up/down controls, one PAIR per row, read from the aria-labels the
/// panel gives them rather than from a class. Parsed the way `rows` is — split
/// on the canvas checkbox — because the controls live inside the row and must
/// be read with the route they move; a control that drifted onto the wrong row
/// fails here rather than passing quietly.
///
/// `null` for a control the row does not draw, which is a state worth seeing
/// rather than skipping. `disabled` is read from the ATTRIBUTE — a bare
/// `disabled=""`, which is what React renders — rather than from the word,
/// because the control's class list carries Tailwind's `disabled:` variants and
/// a test that matched those would pass over a control that is never disabled.
const moves = (html: string) =>
  html
    .split(/<input/)
    .slice(1)
    .flatMap((chunk) => {
      const route = /aria-label="Show ([^"]*) on the canvas"/.exec(chunk)?.[1]
      if (!route) return []
      const control = (dir: "up" | "down") => {
        const attrs = new RegExp(`<button[^>]*aria-label="Move ${route} ${dir}"([^>]*)>`).exec(chunk)
        return attrs === null ? null : { disabled: / disabled(?:=""|\s|$)/.test(attrs[1]) }
      }
      return [{ route, up: control("up"), down: control("down") }]
    })

describe("PagesPanel", () => {
  it("draws the group overview, the bulk control, then every page numbered by its place in the flow", () => {
    const html = render(
      layout({
        groups: [
          // Assignment order reversed against the manifest, so "Sign up before
          // Preferences" is the manifest's order and not this array's.
          { id: "g1", name: "Auth", routes: ["/settings", "/signup"] },
          // "Admin" names no page at all — it keeps its heading and draws
          // nothing. `/ghost` is an entry that is not in the manifest.
          { id: "g2", name: "Admin", routes: ["/ghost"] },
        ],
        pageLabels: { "/settings": "Preferences" },
      }),
      { open: ["/"] },
    )

    // Three sections, in the order the sketch draws them.
    expect(html.indexOf("Groups")).toBeLessThan(html.indexOf("Select all"))
    expect(html.indexOf("Select all")).toBeLessThan(html.indexOf("Show / on the canvas"))
    expect(headings(html)).toEqual(["Groups"])

    // The Groups section: document order, NOT alphabetical ("Admin" sorts
    // before "Auth"), each group numbered by its own position, its pages as
    // bullets beneath it in the flow's order — the pages' own, in a document
    // that has set none — and the bullets are NAMES, with no number of their
    // own, so a page has exactly one number and it is the one beside its row
    // below.
    expect(groupList(html)).toEqual([
      { name: "1. Auth", bullets: ["Sign up", "Preferences"] },
      { name: "2. Admin", bullets: [] },
    ])

    // The flat list: every page, 1..4 in the order the flow puts them in —
    // which is the pages' own order here, since this document has set no flow —
    // even though the group above lists Sign up and Preferences FIRST.
    // Numbering by that position would give Sign up=1, Preferences=2, Home=3,
    // Sign in=4. The markup rides in the message because the likeliest break is
    // a change to the row's shape, which is exactly the case where this list
    // comes back empty and says nothing about why.
    expect(rows(html), `rendered markup:\n${html}`).toEqual([
      { route: "/", open: true, n: "1.", name: "Home", group: { route: "/", label: "—" } },
      {
        route: "/login",
        open: false,
        n: "2.",
        name: "Sign in",
        group: { route: "/login", label: "—" },
      },
      {
        route: "/signup",
        open: false,
        n: "3.",
        name: "Sign up",
        group: { route: "/signup", label: "Auth" },
      },
      {
        route: "/settings",
        open: false,
        n: "4.",
        name: "Preferences",
        group: { route: "/settings", label: "Auth" },
      },
    ])

    // A click on a page's NAME must not toggle the canvas checkbox beside it,
    // and the one construct that would make it is a `<label>` spanning the two:
    // a label forwards a click on its text to its control. The panel has exactly
    // one, the bulk control above, whose own click is supposed to hit its box.
    expect(html.match(/<label/g)).toHaveLength(1)
    // The rename resolver wins over the manifest title: the page's own title
    // must not be drawn as well. The absence is asserted of the STRING, not of
    // the text node (`>Settings<`): the text-node form stops covering the title
    // the moment it can reach an attribute instead — a `title=`, a
    // `placeholder=` (which is what `LabelInput` puts the resolved name in) —
    // and it would then pass while the title was on screen. This markup carries
    // neither today (no `LabelInput` is mounted server-side, so there are no
    // `placeholder=` attributes at all), which is why the two forms are
    // equivalent HERE and this one is the one that keeps being true.
    expect(html).not.toContain("Settings")
    // The group picker shows the group's NAME. This is the failure the app's
    // Base UI `Select` has by default — an `items` value→label map that goes
    // missing makes every row read `g1` — and the only place it can be caught is
    // here, in the markup.
    expect(html).not.toContain(">g1<")
    expect(html).not.toContain(">g2<")
    // A group entry that is not a page spends no row and no bullet. This is
    // reachable without a server bug: the manifest and the layout are two
    // separate fetches, and `normalizeLayout` keeps whatever a group names.
    expect(html).not.toContain("/ghost")
  })

  it("draws the Groups header, and the only way to make a group, with nothing grouped yet", () => {
    const html = render(layout({}))

    // The header is drawn even with no groups at all, because `+ Add group`
    // lives in it now: a section that vanished until something was grouped would
    // take the only way to group anything with it.
    expect(headings(html)).toEqual(["Groups"])
    expect(groupList(html)).toEqual([])
    expect(html).toContain("+ Add group")
    expect(rows(html).map((row) => [row.n, row.name, row.group.label])).toEqual([
      ["1.", "Home", "—"],
      ["2.", "Sign in", "—"],
      ["3.", "Sign up", "—"],
      ["4.", "Settings", "—"],
    ])
  })

  // The reorder affordance: one pair per row, in the row, beside the number it
  // changes. Disabled at the ends of the list — the same rule `moveRoute`
  // enforces one layer down, so a click that got through anyway cannot wrap a
  // page round the list. The disabled state is read from the markup because
  // nothing here can click: the panel's interactions are out of reach in this
  // environment (see the header), and what CAN be pinned is that the control is
  // drawn, on the right row, in the state the flow puts it in.
  it("draws a move up/down control on every row, disabled at the ends of the flow", () => {
    const html = render(layout({}), { open: ["/"] })

    expect(moves(html)).toEqual([
      { route: "/", up: { disabled: true }, down: { disabled: false } },
      { route: "/login", up: { disabled: false }, down: { disabled: false } },
      { route: "/signup", up: { disabled: false }, down: { disabled: false } },
      { route: "/settings", up: { disabled: false }, down: { disabled: true } },
    ])
  })

  // The ends move with the flow, not with the manifest: `/settings` leads this
  // flow, so ITS up control is the disabled one. A panel that disabled the
  // manifest's first and last rows would offer a dead control on the page the
  // user is most likely to want to move.
  it("disables the ends of the FLOW when one has been set", () => {
    const html = render(layout({ routeOrder: ["/settings", "/signup"] }), { open: ["/"] })

    expect(moves(html)).toEqual([
      { route: "/settings", up: { disabled: true }, down: { disabled: false } },
      { route: "/signup", up: { disabled: false }, down: { disabled: false } },
      { route: "/", up: { disabled: false }, down: { disabled: false } },
      { route: "/login", up: { disabled: false }, down: { disabled: true } },
    ])
  })

  it("lists the pages in the flow, numbered by their place in it", () => {
    const html = render(layout({ routeOrder: ["/settings", "/signup"] }), { open: ["/"] })

    // The list IS the sequence the user built — the number is the page's place
    // in it, the arrows sit beside that number, and the pages the flow does not
    // name follow in their own order. The canvas draws its boards in this same
    // order (`boardsForView`), which is the whole point of the two agreeing.
    expect(rows(html).map((row) => [row.n, row.route])).toEqual([
      ["1.", "/settings"],
      ["2.", "/signup"],
      ["3.", "/"],
      ["4.", "/login"],
    ])
  })

  it("reads Select all while a page is closed, and Deselect when every page is open", () => {
    // The box reflects EVERY page, and the word beside it is the action rather
    // than a second name for the same state: the control is one entry point to
    // `openRoutes`, in bulk.
    expect(bulk(render(layout({}), { open: ["/"] }))).toEqual({
      checked: false,
      label: "Select all",
    })
    expect(bulk(render(layout({}), { open: MANIFEST.map((route) => route.path) }))).toEqual({
      checked: true,
      label: "Deselect",
    })
  })

  it("draws no rows and no bulk control while the manifest is still loading", () => {
    // The layout can arrive before the manifest does, and the panel is mounted
    // for the whole load. Nothing to list means nothing to select: a bulk
    // checkbox over an empty project is a control that would do nothing, and a
    // checked one beside "No pages yet." is worse than nothing.
    const html = render(layout({ groups: [{ id: "g1", name: "Auth", routes: ["/login"] }] }), {
      routes: null,
    })

    expect(rows(html)).toEqual([])
    expect(bulk(html)).toBeNull()
    expect(html).toContain("No pages yet.")
    // The groups are the layout document's, which may already be in: they are
    // listed, with no bullets, because their pages come from the manifest that
    // has not arrived. A group drawn as a result rather than as a heading would
    // be the loading state pretending to be an answer.
    expect(groupList(html)).toEqual([{ name: "1. Auth", bullets: [] }])
  })
})
