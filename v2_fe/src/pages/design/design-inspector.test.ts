import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { readJson } from "@/lib/auth-api"
import type { DesignComment } from "@/lib/design-api"
import { sanitizeSelection, type SelectionState } from "./design-selection"
import { DesignInspector } from "./design-inspector"

// What the selection LIST draws — the two things the user asked for by name:
// every row says which page it is on ("during select we need to identify and
// say which route"), and a row says whether it has already been commented on.
// `selection-list.test.ts` holds the operations underneath it (the dedupe, the
// removal, the active index); nothing there would notice if a row's route label
// moved to another row or vanished, or if a badge counted the wrong row — which
// is what this file covers, on the real component's SSR markup.
//
// It renders the REAL component — `createElement(DesignInspector, props)` and
// `renderToStaticMarkup`, never `DesignInspector(props)` called as a function —
// for the reason `pages-panel.test.ts` gives: a direct call skips React's
// element boundary, and the first hook added to the component turns every such
// call into "Invalid hook call" rather than a render.
//
// `renderToStaticMarkup` runs in the default node environment: no jsdom, no
// Testing Library, no new dependency. A `.ts` and not a `.tsx` because
// `vite.config.ts` collects only `src/**/*.test.ts` — a `.tsx` here would never
// run — and `createElement` needs no JSX syntax.
//
// SCOPE — what this does NOT cover: nothing here clicks. The row's activate and
// remove controls, the panel's ✕, and the canvas following an activation are
// all handlers, and no handler runs without jsdom and an event. Nor does it
// cover the badge filling in after a comment is created (that is the page's
// `refreshComments`), or the canvas overlay that draws the ACTIVE selection.

/// One click, sanitized the way `handleSelect` does it — the fixtures are the
/// wire, as in `selection-list.test.ts`.
function pick(route: string, elementPath: string, over: Record<string, unknown> = {}): SelectionState {
  const clean = sanitizeSelection(
    { type: "design:select", component: null, elementPath, tag: "div", ...over },
    route,
    "iphone-16-pro",
  )
  if (!clean) throw new Error("fixture must sanitize")
  return clean
}

/// The case this feature exists for: the SAME element path on two different
/// routes — two components to comment on, two rows that must not swallow each
/// other. The tags differ so the form's own tag line can be told from a row's.
const PRICING = pick("/pricing", "nav:nth-child(3)", { tag: "pricing-nav" })
const SETTINGS = pick("/settings", "nav:nth-child(3)", { tag: "settings-nav" })

/// A page-name resolver as the surface builds it (`pageLabel` over the shared
/// layout + the manifest's titles). Renamed pages are load-bearing here: the
/// label the human reads and the raw path the agent is sent are two different
/// strings, and a row that drew only one of them would pass a test that only
/// looked for the other.
const labelFor = (route: string) =>
  ({ "/pricing": "Pricing", "/settings": "Preferences" })[route] ?? route

/// Comments as `/api/design/{id}/comments` sends them: ORM column names,
/// through the real `readJson`, so a mis-spelled read is a failing test rather
/// than a badge that is silently always zero (see `design-comments.test.ts`).
const comments = (rows: { id: number; route: string; path: string }[]): Promise<DesignComment[]> =>
  readJson<DesignComment[]>(
    new Response(
      JSON.stringify(rows.map((r) => ({ id: r.id, page_path: r.route, element_path: r.path }))),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )

const render = (props: {
  selections?: SelectionState[]
  activeIndex?: number
  comments?: DesignComment[]
}) =>
  renderToStaticMarkup(
    createElement(DesignInspector, {
      selections: props.selections ?? [],
      activeIndex: props.activeIndex ?? -1,
      manifest: null,
      projectId: 1,
      labelFor,
      comments: props.comments ?? [],
      onActivate: () => {},
      onRemove: () => {},
      onClear: () => {},
      onCommentsChanged: () => {},
      onWiden: () => {},
      onFocusComment: () => {},
    }),
  )

/// Every row's page as drawn, in document order: the label and the raw path it
/// sits beside, which the row draws as two ADJACENT spans (label first, path
/// second — the path is what starts with `/` here, since no other span in the
/// panel holds a route). Matched on the span and its TEXT and not on the class,
/// deliberately: a restyled row is still this row, and a test pinned to the
/// class string would fail on every styling tweak while saying nothing about
/// the list. The pairing is the point — it is what a row that drew its
/// neighbour's route, or dropped its own, fails.
const pagePairs = (html: string) =>
  [...html.matchAll(/<span[^>]*>([^<]*)<\/span><span[^>]*>(\/[^<]*)<\/span>/g)].map(
    (m) => [m[1], m[2]] as const,
  )

/// Which selection the form is editing, read off the scope radios' group name
/// (`scope-<route>-<elementPath>`) — the form's own identifier for one
/// selection, which no row draws. `null` when no form rendered.
const formTarget = (html: string) => html.match(/name="scope-([^"]*)"/)?.[1] ?? null

/// Every badge's count, in document order, read off the badge's own title —
/// its user-facing text rather than a class string, so a restyle does not fail
/// it and a badge that stopped being drawn does.
const badges = (html: string) =>
  [...html.matchAll(/title="(\d+) comments? on this selection"/g)].map((m) => m[1])

describe("DesignInspector — the selection list", () => {
  it("draws one row per selection, each naming its own page, and ONE form for the active row", () => {
    const html = render({ selections: [PRICING, SETTINGS], activeIndex: 1 })

    // One pair per row, in the order the human picked them, each row carrying
    // its OWN label and its OWN path. What has to change to fail: dropping
    // `labelFor` (the label becomes the raw path — which also collapses the two
    // spans into one and the row disappears from this list), dropping the raw
    // path, or reading the label/path from any row but the one being drawn.
    expect(pagePairs(html)).toEqual([
      ["Pricing", "/pricing"],
      ["Preferences", "/settings"],
    ])

    // Exactly one row is marked as the one being commented on. What has to
    // change to fail: marking by index 0 (the first row is always "active"), or
    // marking every row.
    expect(html.match(/aria-current="true"/g) ?? []).toHaveLength(1)

    // The form edits the ACTIVE row — the second one here. What has to change
    // to fail: rendering the form from `selections[0]`, or from anything that
    // is not the active row, and the human comments on a component they did not
    // pick. (The two radios are one form's scope pair; a second form would make
    // this four.)
    expect(html.match(/name="scope-/g) ?? []).toHaveLength(2)
    expect(formTarget(html)).toContain("/settings")
    expect(formTarget(html)).not.toContain("/pricing")
  })

  it("follows the active row when it changes", () => {
    // The same two rows, the other one active. The form moves and the mark
    // moves with it — so this cannot pass by accident of row order.
    const html = render({ selections: [PRICING, SETTINGS], activeIndex: 0 })
    expect(formTarget(html)).toContain("/pricing")
    expect(formTarget(html)).not.toContain("/settings")
    expect(html.match(/aria-current="true"/g) ?? []).toHaveLength(1)
    expect(pagePairs(html)).toEqual([
      ["Pricing", "/pricing"],
      ["Preferences", "/settings"],
    ])
  })

  it("badges each row with its OWN comments, by page and element", async () => {
    const html = render({
      selections: [PRICING, SETTINGS],
      activeIndex: 0,
      // Two on the first row's exact target; one on a different element of the
      // same page; one on the same element path of the OTHER page.
      comments: await comments([
        { id: 1, route: "/pricing", path: "nav:nth-child(3)" },
        { id: 2, route: "/pricing", path: "nav:nth-child(3)" },
        { id: 3, route: "/pricing", path: "header:nth-child(1)" },
        { id: 4, route: "/settings", path: "nav:nth-child(3)" },
      ]),
    })

    // What has to change to fail: matching on the route alone (the first row
    // would read 3, and a comment on another element of the same page would
    // count), on the element path alone (both rows 3, and the identically-named
    // element on the other page would look covered here), or reading the
    // comment's column names by the selection's spelling (no badge at all —
    // silently, since `undefined` compares as nothing).
    expect(badges(html)).toEqual(["2", "1"])
  })

  it("draws the Comments list from the SAME list the badges count, not a second fetch", async () => {
    // One question — "which of these have I already commented on?" — and until
    // now it had two answers: the badge counted the page's LIVE list (SSE + a
    // refetch on create), while the list below fetched its own copy once per
    // project and never refreshed. Commenting therefore raised a badge over a
    // list that still showed nothing, and the human cannot tell "not mapped yet"
    // from "not loaded yet" — so they comment a second time. The row's badge and
    // the list it sits above have to be the same list.
    //
    // SSR is what makes this provable here, and it is why this case can be a
    // test at all: the section's own fetch lives in an effect and effects do not
    // run under `renderToStaticMarkup`, so a Comments title in this markup can
    // only have come from the prop it was handed.
    const html = render({
      selections: [PRICING, SETTINGS],
      activeIndex: 0,
      comments: await comments([
        { id: 1, route: "/pricing", path: "nav:nth-child(3)" },
        { id: 2, route: "/settings", path: "nav:nth-child(3)" },
      ]),
    })

    // What has to change to fail: not passing the list down (the section renders
    // nothing at all — its `Comments (…)` title is drawn by the section and
    // nowhere else), or drawing it from a different list (the count is this
    // list's).
    expect(html).toContain("Comments (2)")
  })

  it("draws the empty state, and no rows, when nothing is selected", () => {
    const html = render({ selections: [], activeIndex: -1 })

    // `-1` is the empty list's active index — the convention `selection-list`
    // maintains and the surface passes straight through. What has to change to
    // fail: reading `selections[activeIndex]` without resolving that convention
    // (the rows would render with a form for `undefined`), or rendering the
    // list from a separate flag that can disagree with the index.
    expect(html).toContain("click any element")
    expect(pagePairs(html)).toEqual([])
    expect(formTarget(html)).toBeNull()
    expect(html.match(/aria-current="true"/g) ?? []).toHaveLength(0)
  })
})

describe("DesignInspector — the breadcrumb", () => {
  /// A click carrying a chain, as the frame sends one: the labels, the paths and
  /// the per-crumb component all describe the same window, so they are handed
  /// over together.
  const chain = (labels: string[], paths: string[]) =>
    pick("/settings", paths[paths.length - 1], {
      tag: "main",
      ancestors: labels,
      ancestorPaths: paths,
      ancestorComponents: labels.map(() => null),
    })
  const LABELS = ["div", "main"]
  const PATHS = ["div:nth-child(1)", "div:nth-child(1) > main:nth-child(2)"]

  it("offers a crumb as a control only when it can be both named AND widened to", () => {
    // The guard has two halves and both are load-bearing, which is why they are
    // asserted side by side. A crumb is a BUTTON when the frame sent a path for
    // it — a label alone cannot be turned back into an element — AND when there
    // is a label to put on it: the label is `dataset.component || tagName` off
    // the wire, and `""` is reachable for it (the sanitizer turns a non-string
    // into `""`, and the frame's own chain can hand over an element with neither
    // a component nor a tag). Without the second half, that crumb renders a live
    // button wearing the tooltip `Widen selection to ` — a control that names
    // nothing to widen to, which is the dead-control shape this breadcrumb was
    // fixed for once already. Without the first, the named crumb below stops
    // being clickable and the test passes on a panel that cannot widen at all:
    // each half alone is satisfied by a broken panel.
    const named = render({ selections: [chain(LABELS, PATHS)], activeIndex: 0 })
    expect(named).toContain('title="Widen selection to div"')

    const blank = render({ selections: [chain(["", "main"], PATHS)], activeIndex: 0 })
    expect(blank).not.toContain("Widen selection to")
    // The blank crumb is not a control — and the one below it is still drawn as
    // the current element, so the chain is on screen either way.
    expect(blank).toContain('title="Selected element"')
  })

  it("offers no crumb at all when the frame sent no paths", () => {
    // The other way a crumb is not a control: nothing to widen TO. A frame from
    // before the chain existed sends labels and no paths, and every crumb is
    // then plain text — the panel degrades to a read-only breadcrumb rather
    // than to buttons that cannot be honoured.
    const html = render({
      selections: [
        pick("/settings", "div:nth-child(1) > main:nth-child(2)", {
          tag: "main",
          ancestors: LABELS,
          ancestorPaths: undefined,
          ancestorComponents: undefined,
        }),
      ],
      activeIndex: 0,
    })
    expect(html).not.toContain("Widen selection to")
    expect(html).toContain("main")
  })
})
