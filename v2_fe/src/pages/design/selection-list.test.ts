import { describe, expect, it } from "vitest"

import { readJson } from "@/lib/auth-api"
import type { DesignComment } from "@/lib/design-api"
import { sanitizeSelection, type SelectionState } from "./design-selection"
import {
  addSelection,
  commentsForSelection,
  removeSelection,
  replaceSelection,
  selectionName,
} from "./selection-list"

// The multi-selection list is where "pick several components, on several pages"
// can go wrong INVISIBLY: a duplicate row (from a double click, or from the
// breadcrumb widening a row onto one already there), a lost entry, and an
// `active` that points past the end after a removal — which does not throw, it
// makes the Inspector's form silently vanish, or worse, edit a component the
// human did not pick. So the operations are pure functions here with the tests
// below, rather than inline `setSelections` bodies in a 1200-line page.
//
// The fixtures go through the real `sanitizeSelection` for the reason
// `design-selection.test.ts` gives: a hand-typed `SelectionState` literal would
// be checked against the very type under test, so it could only fail to compile
// or be quietly re-spelled to match.

/// One click, sanitized the way `handleSelect` does it. `over` exists to vary
/// the two fields `selectionName` reads.
function pick(route: string, elementPath: string, over: Record<string, unknown> = {}): SelectionState {
  const clean = sanitizeSelection(
    {
      type: "design:select",
      component: null,
      elementPath,
      tag: "div",
      rect: { x: 1, y: 2, w: 3, h: 4 },
      ...over,
    },
    route,
    "iphone-16-pro",
  )
  if (!clean) throw new Error("fixture must sanitize")
  return clean
}

const paths = (list: SelectionState[]) => list.map((s) => `${s.route}${s.elementPath}`)

describe("addSelection", () => {
  it("appends the new row and makes IT the active one", () => {
    const a = pick("/", "main:nth-child(1)")
    const b = pick("/settings", "img:nth-child(1)")

    const first = addSelection([], a)
    expect(paths(first.list)).toEqual(["/main:nth-child(1)"])
    expect(first.active).toBe(0)

    const second = addSelection(first.list, b)
    // Order is the order the human picked in — the row they just made is last.
    expect(paths(second.list)).toEqual(["/main:nth-child(1)", "/settingsimg:nth-child(1)"])
    // What has to change to fail: prepending the row, or returning any `active`
    // but the new row's index — the Inspector's form would go on editing the
    // component clicked BEFORE this one.
    expect(second.active).toBe(1)
  })

  it("yields ONE row when the same element is clicked twice", () => {
    const a = pick("/settings", "nav:nth-child(3) > img:nth-child(1)")
    const twice = addSelection(
      addSelection([], a).list,
      pick("/settings", "nav:nth-child(3) > img:nth-child(1)"),
    )

    // What has to change to fail: dropping the search for an equivalent row —
    // the list would show the same component twice, and removing one would
    // leave a twin behind that still looks uncommented.
    expect(twice.list).toHaveLength(1)
    expect(twice.active).toBe(0)
  })

  it("re-clicking an existing selection ACTIVATES it where it sits, without reordering", () => {
    const list = [
      pick("/", "main:nth-child(1)"),
      pick("/login", "form:nth-child(2)"),
      pick("/settings", "nav:nth-child(3)"),
    ]
    const again = addSelection(list, pick("/login", "form:nth-child(2)"))

    // What has to change to fail: remove-then-append (the row jumps to the
    // bottom of the list while the human watches), or leaving `active` where it
    // was (the form keeps editing the row that was picked before).
    expect(paths(again.list)).toEqual([
      "/main:nth-child(1)",
      "/loginform:nth-child(2)",
      "/settingsnav:nth-child(3)",
    ])
    expect(again.active).toBe(1)
  })

  it("keeps the SAME element path on two different routes as two rows", () => {
    // The case this whole feature exists for: `nav > img` on the home page and
    // the same markup on /settings are two different places to comment, on two
    // different pages, and neither may swallow the other.
    const home = pick("/", "nav:nth-child(3) > img:nth-child(1)")
    const settings = pick("/settings", "nav:nth-child(3) > img:nth-child(1)")
    const both = addSelection(addSelection([], home).list, settings)

    // What has to change to fail: deduping on `elementPath` alone. The second
    // page's click would activate the first page's row, and the element on
    // /settings could never be selected at all. (Deduping on `route` alone
    // fails the test above instead.)
    expect(both.list.map((s) => s.route)).toEqual(["/", "/settings"])
    expect(both.active).toBe(1)
  })
})

describe("removeSelection", () => {
  it("leaves the active row active when the removed row was NOT it", () => {
    // The active row is deliberately NOT the last one here. With a last-row
    // active, the clamp at the end of `removeSelection` lands on the same row
    // whether or not the shift happened, so a test written that way passes
    // against an implementation that forgets the shift entirely (this fixture
    // started out that way, and the mutation run is what caught it).
    const list = [
      pick("/", "main:nth-child(1)"),
      pick("/login", "form:nth-child(2)"),
      pick("/settings", "nav:nth-child(3)"),
      pick("/about", "footer:nth-child(4)"),
    ]
    const after = removeSelection({ list, active: 2 }, 0)

    // The removal takes the whole `{list, active}` for this assertion and no
    // other reason: `active` must name the SAME selection it named before, and
    // a function handed only `(list, index)` cannot see which one that was. The
    // best it could return is "the index the removal landed on" — right by
    // accident when the removed row happened to be the active one, and wrong
    // (the form silently re-targets another component) whenever it is not.
    expect(paths(after.list)).toEqual([
      "/loginform:nth-child(2)",
      "/settingsnav:nth-child(3)",
      "/aboutfooter:nth-child(4)",
    ])
    // What has to change to fail: dropping the `index < active` shift — the
    // active index would stay at 2 and silently name `/about`, a component the
    // human never picked.
    expect(after.active).toBe(1)
    expect(after.list[after.active]?.route).toBe("/settings")

    // The boundary on the other side: a removal AFTER the active row moves it
    // not at all. (`shifted` is the plain `active` either way, so this one is
    // documentation rather than a trap — the assertion above is the one that
    // bites.)
    const later = removeSelection({ list, active: 1 }, 3)
    expect(later.active).toBe(1)
    expect(later.list[later.active]?.route).toBe("/login")
  })

  it("hands the slot to the row that followed when the ACTIVE row is removed", () => {
    const list = [
      pick("/", "main:nth-child(1)"),
      pick("/login", "form:nth-child(2)"),
      pick("/settings", "nav:nth-child(3)"),
    ]
    const after = removeSelection({ list, active: 1 }, 1)

    // What has to change to fail: `active - 1`, which would hand the form to
    // the row ABOVE — a different component than the one the human was on. (An
    // unclamped index lands on the same row here; the clamp is what the next
    // test holds.)
    expect(after.list).toHaveLength(2)
    expect(after.active).toBe(1)
    expect(after.list[after.active]?.elementPath).toBe("nav:nth-child(3)")
  })

  it("clamps when the removed row was the LAST one, active or not", () => {
    const list = [pick("/", "main:nth-child(1)"), pick("/login", "form:nth-child(2)")]
    const after = removeSelection({ list, active: 1 }, 1)

    // What has to change to fail: returning the removed row's index (1) against
    // a one-row list — `list[1]` is `undefined`, and a form rendered from it
    // would draw nothing at all, with no error anywhere.
    expect(after.list).toHaveLength(1)
    expect(after.active).toBe(0)
    expect(after.list[after.active]?.elementPath).toBe("main:nth-child(1)")
  })

  it("leaves an empty list with active at -1 when the last row goes", () => {
    const after = removeSelection({ list: [pick("/", "main:nth-child(1)")], active: 0 }, 0)

    // What has to change to fail: keeping `active` at 0 (or at any index) with
    // nothing left to point at. -1 is the one value the Inspector reads as
    // "no selection" — anything else is a row lookup that misses.
    expect(after.list).toEqual([])
    expect(after.active).toBe(-1)
  })

  it("refuses an index that names no row rather than removing a neighbour", () => {
    const state = { list: [pick("/", "main:nth-child(1)"), pick("/login", "form:nth-child(2)")], active: 1 }

    // What has to change to fail: `list.filter((_, i) => i !== index)` with no
    // bound check (a stale index is simply dropped, and the list keeps both
    // rows — the caller is told nothing), or a `splice` guard that removes the
    // wrong row. Nothing here reaches a user today; it is the seam a stale
    // render would come through.
    expect(removeSelection(state, 2)).toEqual(state)
    expect(removeSelection(state, -1)).toEqual(state)
    expect(removeSelection(state, 1.5)).toEqual(state)
  })
})

describe("replaceSelection", () => {
  it("keeps the widened row where it was and makes it the active one", () => {
    // Widening is the second way into the list (the breadcrumb re-anchors the
    // ACTIVE selection to an ancestor), and the row must not jump to the bottom
    // while the human watches it happen.
    const list = [
      pick("/", "main:nth-child(1)"),
      pick("/login", "header:nth-child(1) > nav:nth-child(3)"),
      pick("/settings", "nav:nth-child(3)"),
    ]
    const widened = pick("/login", "header:nth-child(1)")
    const after = replaceSelection(list, 1, widened)

    // What has to change to fail: remove-then-add (`/login` would end up last),
    // or returning the OLD index — those are different rows once a duplicate
    // below has been dropped.
    expect(paths(after.list)).toEqual([
      "/main:nth-child(1)",
      "/loginheader:nth-child(1)",
      "/settingsnav:nth-child(3)",
    ])
    expect(after.active).toBe(1)
  })

  it("drops the row the widened selection now duplicates", () => {
    // "One row per target" is the list's invariant, and widening is the second
    // way to break it: widening the deeper selection onto the ancestor the row
    // above already holds leaves two rows naming the same element — the same
    // duplicate the click path dedupes, reached through the breadcrumb instead.
    const outer = pick("/settings", "header:nth-child(1)")
    const inner = pick("/settings", "header:nth-child(1) > nav:nth-child(3)")
    const after = replaceSelection([outer, inner], 1, pick("/settings", "header:nth-child(1)"))

    // What has to change to fail: a plain `map` replace. Both rows would render
    // with the same page and the same name, and removing either would leave the
    // other one looking uncommented.
    expect(after.list).toHaveLength(1)
    expect(after.list[0]?.route).toBe("/settings")
    expect(after.list[0]?.elementPath).toBe("header:nth-child(1)")
    expect(after.active).toBe(0)
  })
})

describe("selectionName", () => {
  it("names the component when there is one, and the tag when there is not", () => {
    // What has to change to fail: reading `tag` first. Every row inside a
    // component would be named by its element (`header`), and the component —
    // the thing being mapped across pages — would appear nowhere in the list.
    expect(
      selectionName(pick("/", "header:nth-child(1)", { component: "app-header", tag: "header" })),
    ).toBe("app-header")
    expect(selectionName(pick("/", "main:nth-child(2)", { component: null, tag: "main" }))).toBe("main")
  })

  it("still names something when the frame sent neither", () => {
    // Hostile, but reachable: `sanitizeSelection` clamps rather than rejects, so
    // a payload with no component and no tag arrives as two empty strings. A
    // blank row is a row with nothing to click.
    expect(selectionName(pick("/", "div:nth-child(1)", { component: null, tag: "" }))).toBe("element")
  })
})

// The badge: which of the rows the human has already commented on. A comment
// row arrives with its COLUMN names (`page_path`, `element_path`), so the
// fixture is the WIRE — JSON through the real `readJson`, as in
// `design-comments.test.ts` — because reading `page_path` as `route` is
// `undefined`, not an error: every badge would silently read zero.
const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const wireComments = () =>
  readJson<DesignComment[]>(
    jsonRes([
      { id: 1, page_path: "/", element_path: "nav:nth-child(3) > img:nth-child(1)" },
      { id: 2, page_path: "/settings", element_path: "nav:nth-child(3) > img:nth-child(1)" },
      { id: 3, page_path: "/settings", element_path: "header:nth-child(1)" },
    ]),
  )

describe("commentsForSelection", () => {
  it("matches on route AND element path, and nothing looser", async () => {
    const comments = await wireComments()
    const selection = pick("/settings", "nav:nth-child(3) > img:nth-child(1)")

    // What has to change to fail, three ways, one per row above: reading the
    // comment's route by the selection's spelling (`route`, `undefined`) or the
    // selection's path by the comment's (`page_path`, `undefined`) matches
    // nothing at all; matching on the route alone also matches id 3, a comment
    // on a different element of the same page.
    expect(commentsForSelection(comments, selection).map((c) => c.id)).toEqual([2])
  })

  it("answers an empty list rather than throwing on an untouched row", async () => {
    const comments = await wireComments()
    expect(commentsForSelection(comments, pick("/", "main:nth-child(1)"))).toEqual([])
    // A project whose comments have not loaded yet is a badge-less row, not a
    // crash while the Inspector renders.
    expect(commentsForSelection([], pick("/", "main:nth-child(1)"))).toEqual([])
  })
})
