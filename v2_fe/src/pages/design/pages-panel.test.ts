import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { DesignManifest, RouteEntry } from "@/lib/design-api"
import { normalizeLayout, type LayoutDoc } from "@/lib/design-layout"
import { PagesPanel } from "./pages-panel"

// The panel's own rules, at the level `pages-order.test.ts` cannot reach: what
// the JSX actually DRAWS. `groupedPages`, `numberedPages` and `selectAllState`
// decide the sections, the numbers and the bulk control's state, and their tests
// pin those — but nothing there would notice a row drawn under the WRONG group,
// a number that skipped, a group with no move controls, a group picker showing
// `g1` where the group is called Auth, or the bulk control missing from a panel
// with pages. This file covers exactly those.
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
// editor, an arrow's write, the bulk control's write — stay untested, as they
// were. What the arrows can be pinned to in markup is the state they are drawn
// in, and that is what the reorder tests below assert. Two things are out of
// reach here for a second reason: the dialog's popup and the Select's items
// live in client-only portals (`@base-ui/react`'s FloatingPortal renders
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

/// The panel's section headings, in the order drawn. Matched on the `<h3>` and
/// its TEXT, deliberately not on the class — a heading that is restyled is still
/// this heading, and a test that pinned the class string would fail on every
/// styling tweak while saying nothing about the list.
const headings = (html: string) =>
  [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1])

/// The panel split into the blocks a heading starts: each `<h3>` section and
/// each `<h4>` group, with everything drawn under it up to the next heading.
///
/// This is what makes "the row is under ITS group" assertable rather than
/// inferred from the whole panel's row order, which cannot tell nesting from
/// sequence: a row that drifted into the wrong group — or out of every group
/// into the tail — fails here and passes a flat scan.
const blocks = (html: string) => {
  const marks = [...html.matchAll(/<h([34])[^>]*>([^<]*)<\/h\1>/g)].map((match) => ({
    level: Number(match[1]),
    text: match[2],
    at: match.index ?? 0,
  }))
  return marks.map((mark, i) => ({
    level: mark.level,
    text: mark.text,
    /// Everything from this heading to the next one — so a group's block holds
    /// its own move controls and its own rows, and nothing of the next group.
    body: html.slice(mark.at, marks[i + 1]?.at ?? html.length),
  }))
}

/// One button's drawn state, found by the aria-label the panel gives it, and
/// read from the ATTRIBUTE — a bare `disabled=""`, which is what React renders —
/// rather than from the word, because the control's class list carries
/// Tailwind's `disabled:` variants and a test that matched those would pass over
/// a control that is never disabled. `null` for a control the block does not
/// draw, which is a state worth seeing rather than skipping.
///
/// The label is ESCAPED before it becomes a pattern: the group arrows are
/// labelled with the group's NAME, which is text the user typed (`Auth (v2)` is
/// a legal name and a pattern that throws), so an unescaped interpolation would
/// make this helper fail on the fixture rather than on the markup.
const control = (body: string, label: string) => {
  const pattern = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const attrs = new RegExp(`<button[^>]*aria-label="${pattern}"([^>]*)>`).exec(body)
  return attrs === null ? null : { disabled: / disabled(?:=""|\s|$)/.test(attrs[1]) }
}

/// Every row of the panel, in document order. Rows are found by their canvas
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

/// One group's HEADER LINE, read structurally: `li > div > h4` and everything up
/// to that div's close — the name, the group's own open/close control and its
/// two arrows. The rows are drawn in a `<ul>` OUTSIDE that div, so "in the
/// group's header" becomes a claim about the markup's nesting rather than about
/// the order of a flat scan: a control drawn over the rows, or under the next
/// group's heading, fails on this slice.
///
/// The heading is ESCAPED for the reason `control` escapes the arrows' labels —
/// a group is named by the user, and a name is pattern syntax ("Auth (v2)").
/// `null` when the panel draws no such heading, which is a state worth seeing.
const headerOf = (html: string, heading: string) => {
  const pattern = new RegExp(
    `<li[^>]*><div[^>]*><h4[^>]*>${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h4>([\\s\\S]*?)</div>`,
  )
  return pattern.exec(html)?.[1] ?? null
}

/// A group's OWN bulk control: the box in its header and the word beside it,
/// found by the aria-label the panel gives it, which carries the action AND the
/// group's name ("Select group Auth", "Deselect Auth") — so a control that
/// drifted onto another group's header fails here rather than passing quietly.
/// The word is read back from the drawn TEXT, not from the pattern: the box and
/// the word are one control, and a label that disagreed with its own text would
/// not match at all.
///
/// `null` for the state an empty group is in — no control — which is asserted
/// rather than skipped, for the reason `control` returns `null` too.
const groupSelect = (header: string | null, name: string) => {
  if (header === null) return null
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(
    `<input[^>]*aria-label="(?:Select group|Deselect) ${escaped}"([^>]*)>([^<]*)`,
  ).exec(header)
  return match === null ? null : { label: match[2], checked: match[1].includes("checked") }
}

/// The panel's GROUPS as drawn, in document order: each group's numbered name,
/// the move controls beside it, the group's own bulk control, and the rows under
/// it. Built on `blocks`, so a group's rows are the ones between its heading and
/// the next heading — the nesting, asserted rather than assumed. The control is
/// read from the group's header (`headerOf`) and not from its whole block, so
/// where it sits is asserted with it.
const groupBlocks = (html: string) =>
  blocks(html)
    .filter((block) => block.level === 4)
    .map((block) => {
      /// The heading carries the group's POSITION as well as its name ("1.
      /// Auth"); the controls' aria-labels carry the name alone, which is what
      /// the panel names them by.
      const name = block.text.replace(/^\d+\. /, "")
      return {
        heading: block.text,
        up: control(block.body, `Move group ${name} up`),
        down: control(block.body, `Move group ${name} down`),
        select: groupSelect(headerOf(html, block.text), name),
        rows: rows(block.body),
      }
    })

/// The rows of the Ungrouped section — the `<h3>` block that carries them.
/// `undefined` when the panel draws no such section, which is a state worth
/// asserting rather than skipping.
const ungroupedRows = (html: string) => {
  const block = blocks(html).find((entry) => entry.text === "Ungrouped")
  return block === undefined ? undefined : rows(block.body)
}

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

/// The left inset a class list asks for, in px — the one `pl-*` / `px-*` step
/// the panel's markup carries on an element (Tailwind's `1` is 4px).
///
/// This is the only place in this file that reads a class, and it is not a style
/// assertion. "A group's rows are nested under their group" is a claim about
/// where things SIT, the rework's review MEASURED it in pixels, and there is no
/// CSS engine in this environment to measure with. Reading the steps back out of
/// the classes is that same measurement. What is asserted is the RELATION — each
/// level further in than the one above it — so a restyle that keeps the ladder
/// passes, and only flattening it fails.
const inset = (classes: string) => {
  const step = /(?:^|\s)(?:pl|px)-(\d+)(?=\s|$)/.exec(classes)
  return step ? Number(step[1]) * 4 : 0
}

/// The nesting, as the four left insets that draw it: the sections' `<h3>`, a
/// group's `<h4>` (the block, the heading row and the heading itself), that
/// group's rows (the block, their `<ul>` and a row), and the ungrouped section's
/// rows. Read out of the markup's own structure — `li > div > h4` and
/// `li > ul > li` — so it is the nesting being measured, not four class strings
/// that happen to be somewhere on the page. `null` when the fixture has no group
/// or no ungrouped row, which is a state a fixture avoids rather than a shape to
/// compare against.
const nesting = (html: string) => {
  const section = /<h3[^>]*class="([^"]*)"[^>]*>Groups<\/h3>/.exec(html)
  const group =
    /<li[^>]*class="([^"]*)"[^>]*><div[^>]*class="([^"]*)"[^>]*><h4[^>]*class="([^"]*)"[^>]*>[\s\S]*?<ul[^>]*class="([^"]*)"[^>]*><li[^>]*class="([^"]*)"/.exec(
      html,
    )
  const ungrouped =
    /<h3[^>]*class="([^"]*)"[^>]*>Ungrouped<\/h3>[\s\S]*?<ul[^>]*class="([^"]*)"[^>]*><li[^>]*class="([^"]*)"/.exec(
      html,
    )
  if (!section || !group || !ungrouped) return null
  return {
    section: inset(section[1]),
    groupHeading: inset(group[1]) + inset(group[2]) + inset(group[3]),
    groupRow: inset(group[1]) + inset(group[4]) + inset(group[5]),
    ungroupedRow: inset(ungrouped[2]) + inset(ungrouped[3]),
  }
}

/// The move up/down controls, one PAIR per row, read from the aria-labels the
/// panel gives them rather than from a class. Parsed the way `rows` is — split
/// on the canvas checkbox — because the controls live inside the row and must
/// be read with the route they move; a control that drifted onto the wrong row
/// fails here rather than passing quietly. The GROUPS' own arrows carry a
/// different label (`Move group …`) and so cannot be picked up by this one.
const moves = (html: string) =>
  html
    .split(/<input/)
    .slice(1)
    .flatMap((chunk) => {
      const route = /aria-label="Show ([^"]*) on the canvas"/.exec(chunk)?.[1]
      if (!route) return []
      return [
        {
          route,
          up: control(chunk, `Move ${route} up`),
          down: control(chunk, `Move ${route} down`),
        },
      ]
    })

describe("PagesPanel", () => {
  it("nests every page under its group, numbered within it, with Ungrouped last", () => {
    const html = render(
      layout({
        groups: [
          // Assignment order reversed against the manifest, so "Sign up before
          // Preferences" is the flow's order and not this array's.
          { id: "g1", name: "Auth", routes: ["/settings", "/signup"] },
          // A page and an entry that is not one: `/ghost` spends no row, and
          // `/login` is numbered 1 here while it is the project's SECOND page.
          { id: "g2", name: "Ops", routes: ["/ghost", "/login"] },
          // Named so that a name sort would put it FIRST: "Admin" < "Auth". The
          // document order is the only order the user set, so it is the order.
          // Empty, because that is the state right after `+ Add group`.
          { id: "g3", name: "Admin", routes: [] },
        ],
        pageLabels: { "/settings": "Preferences" },
      }),
      { open: ["/"] },
    )

    // Three sections, in the order the user confirmed: the groups, the bulk
    // control, then Ungrouped LAST. The last line reads the ungrouped ROWS,
    // which are drawn below that control and nowhere else.
    expect(headings(html), `rendered markup:\n${html}`).toEqual(["Groups", "Ungrouped"])
    expect(html.indexOf("Groups")).toBeLessThan(html.indexOf("Select all"))
    expect(html.indexOf("Select all")).toBeLessThan(html.indexOf(">Ungrouped<"))
    expect(html.indexOf(">Ungrouped<")).toBeLessThan(html.indexOf("Show / on the canvas"))

    // Each group with ITS pages beneath it, numbered 1..n inside the group —
    // the user's own example: a two-screen group reads "1, 2" — in the flow's
    // order (the pages' own order here, since this document has set no flow),
    // with the group's position number in the heading and its move controls
    // beside it, disabled at the ends of the GROUP list.
    expect(groupBlocks(html), `rendered markup:\n${html}`).toEqual([
      {
        heading: "1. Auth",
        up: { disabled: true },
        down: { disabled: false },
        // Every group with pages carries its own open/close control ("the
        // feature", in full, in the test below); the only page open in this
        // fixture is the ungrouped `/`, so both groups read the action.
        select: { label: "Select group", checked: false },
        rows: [
          {
            route: "/signup",
            open: false,
            n: "1.",
            name: "Sign up",
            group: { route: "/signup", label: "Auth" },
          },
          {
            route: "/settings",
            open: false,
            n: "2.",
            name: "Preferences",
            group: { route: "/settings", label: "Auth" },
          },
        ],
      },
      {
        heading: "2. Ops",
        up: { disabled: false },
        down: { disabled: false },
        select: { label: "Select group", checked: false },
        rows: [
          {
            route: "/login",
            open: false,
            n: "1.",
            name: "Sign in",
            group: { route: "/login", label: "Ops" },
          },
        ],
      },
      // An empty group keeps its heading, its position and its arrows: it is
      // what `+ Add group` makes, and its row is where its arrows live. It gets
      // NO open/close control — nothing to select — which is the one thing about
      // that control that is not the same for every group.
      {
        heading: "3. Admin",
        up: { disabled: false },
        down: { disabled: true },
        select: null,
        rows: [],
      },
    ])

    // The ungrouped section numbers ITSELF from 1 rather than continuing, and
    // holds only the pages no group claims.
    expect(ungroupedRows(html)).toEqual([
      { route: "/", open: true, n: "1.", name: "Home", group: { route: "/", label: "—" } },
    ])

    // The partition: every page of the manifest is listed EXACTLY ONCE, here or
    // under a group. A page listed twice is what this restructure could have
    // introduced — the flat list is replaced, not kept beside the groups — and
    // it would be silent: two rows writing one `openRoutes` entry.
    for (const route of MANIFEST) {
      const shown = html.split(`Show ${route.path} on the canvas`).length - 1
      expect(shown, `${route.path} in:\n${html}`).toBe(1)
    }

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
    // and it would then pass while the title was on screen. In THIS markup no
    // attribute carries the manifest title (the rows' `title=` attributes hold
    // the raw ROUTE), and there are no `placeholder=` attributes at all, since
    // no `LabelInput` mounts server-side — so the two forms are equivalent here,
    // and this is the one that keeps being true when that changes.
    expect(html).not.toContain("Settings")
    // The group picker shows the group's NAME. This is the failure the app's
    // Base UI `Select` has by default — an `items` value→label map that goes
    // missing makes every row read `g1` — and the only place it can be caught is
    // here, in the markup.
    expect(html).not.toContain(">g1<")
    expect(html).not.toContain(">g2<")
    // A group entry that is not a page spends no row. This is reachable without
    // a server bug: the manifest and the layout are two separate fetches, and
    // `normalizeLayout` keeps whatever a group names.
    expect(html).not.toContain("/ghost")

    // The nesting is a LIST structure, not only a heading above a run of rows:
    // one `<ul>` for the groups, one per group for its pages, one for the
    // ungrouped section — 1 + 3 + 1 here. Counted on the tags alone, so a
    // restyle is not a failure and losing the structure is: the first version of
    // this restructure dropped it silently, and heading levels were the only
    // thing left carrying the shape.
    expect(html.match(/<ul/g)).toHaveLength(5)
    // One item per group, and one per row: three groups (Auth, Ops, the empty
    // Admin) and four rows (Auth's two, Ops' one, the ungrouped one).
    expect(html.match(/<li/g)).toHaveLength(3 + 4)
  })

  // The nesting CUE, which the review measured rather than eyeballed: a group's
  // rows sat 4px LEFT of their own heading, and the `<h4>` shared an x with the
  // section `<h3>`s — so nothing on screen said the rows under a heading belonged
  // to it. The heading LEVEL was always right (`<h4>` inside a `<h3>` section),
  // which is exactly why a test that reads only tags and text could not see this
  // and a test that reads the insets can.
  it("indents a group's heading inside the section, and its rows inside that", () => {
    const html = render(layout({ groups: [{ id: "g1", name: "Auth", routes: ["/login"] }] }), {
      open: ["/"],
    })
    const at = nesting(html)
    expect(at, `rendered markup:\n${html}`).not.toBeNull()

    // Each level further in than the one above it. The group heading was level
    // with the section heading, and the rows were 4px left of their heading —
    // both inversions of this ladder, and this is what would catch either
    // coming back.
    expect(at!.groupHeading).toBeGreaterThan(at!.section)
    expect(at!.groupRow).toBeGreaterThan(at!.groupHeading)
    // The ungrouped section has no group to nest under, so its rows only have to
    // not start left of their own heading's text.
    expect(at!.ungroupedRow).toBeGreaterThanOrEqual(at!.section)
  })

  // A group's NAME is the user's own text — `groupNameProblem` refuses only
  // blank, over-long and duplicate — and the group arrows are labelled with it,
  // so a name is also pattern syntax. `Auth (v2)` is a legal name and, in an
  // UNESCAPED pattern, a silent non-match: `(v2)` reads as a capture group, so
  // `control` returns `null` and every group assertion in this file instead
  // reads "the panel draws no such arrow" — the helper failing on the FIXTURE
  // and saying nothing about the markup. (A name whose bracket is unbalanced,
  // `Auth (v2`, makes `new RegExp` throw outright: the same defect, louder.) The
  // escape in `control` is what keeps this file's reading of the arrows about
  // the panel rather than about the name someone gave a group.
  it("reads a group's arrows when the group's own name is pattern syntax", () => {
    const html = render(
      layout({ groups: [{ id: "g1", name: "Auth (v2)", routes: ["/login"] }] }),
      { open: ["/"] },
    )

    expect(groupBlocks(html), `rendered markup:\n${html}`).toEqual([
      {
        heading: "1. Auth (v2)",
        up: { disabled: true },
        down: { disabled: true },
        // The group's own control is found the same way, and it is the same
        // hazard: the aria-label carries the NAME, so an unescaped pattern here
        // reads "the panel draws no control" for a group anyone could have named.
        select: { label: "Select group", checked: false },
        rows: [
          {
            route: "/login",
            open: false,
            n: "1.",
            name: "Sign in",
            group: { route: "/login", label: "Auth (v2)" },
          },
        ],
      },
    ])
  })

  // An empty group in the MIDDLE, which is the case a heading-based parse of
  // this markup can get wrong in a way no other fixture shows: if the empty
  // group's block ran on to the next heading, it would take the following
  // group's rows with it — and the groups after it would still be numbered
  // correctly, so nothing else here would notice.
  it("draws an empty group in its place, holding no rows and taking none from the next", () => {
    const html = render(
      layout({
        groups: [
          { id: "g1", name: "Auth", routes: ["/login"] },
          { id: "g2", name: "Empty", routes: [] },
          { id: "g3", name: "Ops", routes: ["/settings"] },
        ],
      }),
      { open: ["/"] },
    )

    expect(groupBlocks(html).map((group) => [group.heading, group.rows.map((row) => row.route)])).toEqual([
      ["1. Auth", ["/login"]],
      ["2. Empty", []],
      ["3. Ops", ["/settings"]],
    ])
  })

  it("draws the Groups header, the only way to make a group, and an Ungrouped section with nothing grouped yet", () => {
    const html = render(layout({}))

    // The header is drawn even with no groups at all, because `+ Add group`
    // lives in it now: a section that vanished until something was grouped would
    // take the only way to group anything with it. Ungrouped is drawn too — it
    // is where every page starts, and it is the list the bulk control sits
    // above.
    expect(headings(html)).toEqual(["Groups", "Ungrouped"])
    expect(groupBlocks(html)).toEqual([])
    expect(html).toContain("+ Add group")
    expect(ungroupedRows(html)!.map((row) => [row.n, row.name, row.group.label])).toEqual([
      ["1.", "Home", "—"],
      ["2.", "Sign in", "—"],
      ["3.", "Sign up", "—"],
      ["4.", "Settings", "—"],
    ])
  })

  // The reorder affordance: one pair per row, in the row, beside the number it
  // changes. Disabled where `moveRoute` refuses — the ends of the FLOW, not of
  // the manifest and not of a group's list (see the test below) — so a click
  // that got through anyway cannot wrap a page round the sequence. The disabled
  // state is read from the markup because nothing here can click: the panel's
  // interactions are out of reach in this environment (see the header), and what
  // CAN be pinned is that the control is drawn, on the right row, in the state
  // the flow puts it in.
  it("lists the ungrouped section in the flow, numbered by its place there, disabled at the flow's ends", () => {
    const html = render(layout({ routeOrder: ["/settings", "/signup"] }), { open: ["/"] })

    expect(rows(html).map((row) => [row.n, row.route])).toEqual([
      ["1.", "/settings"],
      ["2.", "/signup"],
      ["3.", "/"],
      ["4.", "/login"],
    ])
    expect(moves(html)).toEqual([
      { route: "/settings", up: { disabled: true }, down: { disabled: false } },
      { route: "/signup", up: { disabled: false }, down: { disabled: false } },
      { route: "/", up: { disabled: false }, down: { disabled: false } },
      { route: "/login", up: { disabled: false }, down: { disabled: true } },
    ])
  })

  /// Where the arrows STOP, pinned in the markup because nothing here can click
  /// (`moveRouteInSection`'s own tests carry what a click MEANS). A move is a
  /// flow edit whatever its distance, so the ends are the FLOW's and not a
  /// group's: `/signup` leads Auth and is 3rd of 4 in the flow, so its "up" is
  /// ENABLED — and since Auth has no other page, that click is the flow's own one
  /// place, which changes no number here (the number stays 1; in `groups` view no
  /// column moves either) while `rows` view shows the board move up one.
  ///
  /// That enabled-and-invisible click is the bounded residue, and the reason it
  /// is kept is the one thing a section-local-only move cannot do: a page alone
  /// in its section has no section neighbour, so both its arrows would be
  /// disabled for ever and its place in the flow would be unreachable from this
  /// panel. It is NOT justified by saying the alternative "pushes other groups'
  /// pages along the flow" — an earlier version of this comment said that, and it
  /// is false as a distinction: this very click moves `/login`, which is in no
  /// group and which the user never touched, one place back, because any move
  /// crosses what it passes. What is left is the row about which "order the
  /// screens in this group" has nothing to say: the section's first page has
  /// nothing above it in its group.
  it("disables the ends of the FLOW, not the ends of a group's list", () => {
    const html = render(
      layout({
        groups: [
          { id: "g1", name: "Auth", routes: ["/signup"] },
          { id: "g2", name: "Ops", routes: ["/settings"] },
        ],
      }),
      { open: ["/"] },
    )

    expect(moves(html), `rendered markup:\n${html}`).toEqual([
      // Auth's only page: first in its group, and still enabled.
      { route: "/signup", up: { disabled: false }, down: { disabled: false } },
      // Ops' only page: the flow's LAST page, so its "down" is the dead one.
      { route: "/settings", up: { disabled: false }, down: { disabled: true } },
      // The ungrouped section's own first and last.
      { route: "/", up: { disabled: true }, down: { disabled: false } },
      { route: "/login", up: { disabled: false }, down: { disabled: false } },
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

  // The group's own bulk control: the middle granularity between one row's box
  // and the Select all above, so a user can open a few screens of a big project
  // without opening all of them. What a CLICK writes is `pages-order.test.ts`'s
  // (`selectGroupState.next`, page by page, and its agreement with
  // `selectAllState`), because nothing here can click; what this file can pin is
  // the state each group's control is DRAWN in, over the right group, in the
  // right place — and that is what these three tests do.
  it("scopes each group's control to that group, and reads the same verdict the global control does", () => {
    const groups = [
      { id: "g1", name: "Auth", routes: ["/login", "/signup"] },
      { id: "g2", name: "Ops", routes: ["/settings"] },
      { id: "g3", name: "Admin", routes: [] },
    ]
    // Auth is HALF open — its first page is on the canvas, its second is not.
    // Ops is fully open. `/` is ungrouped and closed.
    const html = render(layout({ groups }), { open: ["/login", "/settings"] })

    expect(
      groupBlocks(html).map((group) => [group.heading, group.select]),
      `rendered markup:\n${html}`,
    ).toEqual([
      // Partly open reads the ACTION, not the state: "Select group" — the same
      // verdict the global control reaches for the same situation, which reads
      // "Select all" below. A box that said "Deselect" here (checked because
      // ANY of the group's pages was open) would be offering to close a page the
      // user still wants, and would contradict the row checkbox beside it.
      ["1. Auth", { label: "Select group", checked: false }],
      // Fully open: the box is checked and the word is the action that would
      // undo it, exactly as the global control's is when every page is open.
      ["2. Ops", { label: "Deselect", checked: true }],
      // No pages, no control: a checked "Deselect" over an empty group would
      // offer to close nothing — the call the panel already makes for a project
      // with no pages at all.
      ["3. Admin", null],
    ])

    // The agreement, read off the markup: with one page open of four, the two
    // controls say the same KIND of thing about their own scopes, neither
    // claiming "all open". The exact form of this property — a group whose scope
    // is the whole project writing the very list the global control writes — is
    // asserted in `pages-order.test.ts`, where both helpers can be called.
    expect(bulk(html), `rendered markup:\n${html}`).toEqual({ checked: false, label: "Select all" })

    // ...and in the other direction, too: with everything open, both read the
    // action that would close their own scope.
    const allOpen = render(layout({ groups }), {
      open: MANIFEST.map((route) => route.path),
    })
    expect(
      groupBlocks(allOpen).map((group) => [group.heading, group.select]),
      `rendered markup:\n${allOpen}`,
    ).toEqual([
      ["1. Auth", { label: "Deselect", checked: true }],
      ["2. Ops", { label: "Deselect", checked: true }],
      ["3. Admin", null],
    ])
    expect(bulk(allOpen)).toEqual({ checked: true, label: "Deselect" })
  })

  // WHERE the control is drawn is part of the feature rather than styling: the
  // header is the only thing that scopes a control to "this group's pages", and
  // the user's mental model is literally "hit select group X". `headerOf` reads
  // `li > div > h4` forward to that div's close, so both halves of this are
  // structural — the control and BOTH arrows are inside the header div, and the
  // group's rows are not.
  it("draws the group's control in the header, beside the arrows that move it", () => {
    const html = render(layout({ groups: [{ id: "g1", name: "Auth", routes: ["/login"] }] }), {
      open: [],
    })
    const header = headerOf(html, "1. Auth")

    expect(header, `rendered markup:\n${html}`).not.toBeNull()
    expect(groupBlocks(html)[0].select).toEqual({ label: "Select group", checked: false })
    expect(control(header!, "Move group Auth up")).not.toBeNull()
    expect(control(header!, "Move group Auth down")).not.toBeNull()
    // No ROW is in this slice: the group's own rows are drawn in the `<ul>`
    // after the header, so the slice is the header and nothing else — which is
    // what makes the two lines above a statement about where the control sits
    // rather than about everything the group draws.
    expect(rows(header!)).toEqual([])
    // The block it was sliced out of does draw the row, so the header is a
    // proper part of the group rather than the whole of it.
    const group = blocks(html).find((block) => block.level === 4)!
    expect(rows(group.body).map((row) => row.route), `rendered markup:\n${html}`).toEqual(["/login"])
  })

  // An empty group, and a group whose only entry is not a page. Neither has a
  // row to act on, so neither gets a control — and the second fixture is why the
  // rule is stated over the PAGES this panel lists rather than over the group's
  // own `routes` array, which is non-empty there. (The same rule reaches the
  // loading state, where the groups are known and their pages are not: see the
  // test below.)
  it("draws no control over a group with no pages, however the group is written", () => {
    const html = render(
      layout({
        groups: [
          { id: "g1", name: "Empty", routes: [] },
          { id: "g2", name: "Stale", routes: ["/ghost"] },
        ],
      }),
      { open: ["/login"] },
    )

    expect(html).not.toContain("/ghost")
    expect(
      groupBlocks(html).map((group) => [group.heading, group.select, group.rows]),
      `rendered markup:\n${html}`,
    ).toEqual([
      ["1. Empty", null, []],
      ["2. Stale", null, []],
    ])
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
    // listed with their arrows and no rows, because their pages come from the
    // manifest that has not arrived. A group drawn as a result rather than as a
    // heading would be the loading state pretending to be an answer.
    // ...and no control either, for the same reason there are no rows: the group
    // is scoped to the PAGES the panel lists, and the manifest that lists them
    // has not arrived. A control here would be a box over pages nothing knows the
    // route of yet.
    expect(groupBlocks(html)).toEqual([
      {
        heading: "1. Auth",
        up: { disabled: true },
        down: { disabled: true },
        select: null,
        rows: [],
      },
    ])
    expect(ungroupedRows(html)).toEqual([])
  })
})
