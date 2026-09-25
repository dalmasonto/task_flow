import { describe, expect, it } from "vitest"

import { sanitizeSelection, widenSelection, type SelectionState } from "./design-selection"

// What the breadcrumb can silently get wrong: a crumb click rebuilds a
// `SelectionState` from a postMessage payload, and every field it derives
// wrongly pins the comment to a DIFFERENT element than the one the human
// pointed at. Nothing throws — the comment saves, dispatches, and the agent
// edits the wrong place — which is why `widenSelection` is a pure function in
// `design-selection.ts` rather than an expression inside the crumb's onClick.
//
// The fixture below is the WIRE, deliberately: a hand-copy of the message the
// picker runtime in `composer.rs` posts for one click, for the tree
//
//   body
//   └─ div:nth-child(1)                       (the page shell — no component)
//      └─ main:nth-child(2)
//         └─ header:nth-child(1)  [data-component="app-header"]
//            └─ nav:nth-child(3)
//               └─ img:nth-child(1)            ← the element clicked
//
// `ancestors` is that chain's labels (`dataset.component || tagName`), and
// `ancestorPaths` / `ancestorComponents` are the same chain's paths
// (`pathTo`, which stops AT a `[data-component]` host) and, per ancestor, what
// the message's own `component` field would be if that element had been clicked
// (`closest('[data-component]')`). All three are built from ONE kept window in
// the frame, so index i has to mean the same element in all three — a test that
// only checked them separately would miss the whole failure mode.
//
// A HAND-COPY, and nothing more: no check ties this fixture to the runtime, so a
// field the frame renames or moves leaves every test below passing on a premise
// `composer.rs` no longer holds. The guard for that is a pointer on the RUNTIME
// side naming this file, which `composer.rs` does not carry — the reciprocal
// note here can only help someone already reading the tests.
const CLICKED = {
  type: "design:select",
  component: "app-header",
  elementPath: "header:nth-child(1) > nav:nth-child(3) > img:nth-child(1)",
  // A real one, not a null: `data-src="{file}:{line}"` is stamped from the file
  // an element came from, so the `img` inside `app-header` is stamped from the
  // component's own file — which is exactly what makes this value WRONG for any
  // crumb above the component (see the widen tests below).
  src: "components/app-header.js:7",
  tag: "img",
  text: "avatar",
  rect: { x: 10, y: 20, w: 30, h: 40 },
  snippet: '<img class="avatar">',
  ancestors: ["div", "main", "app-header", "nav", "img"],
  ancestorPaths: [
    "div:nth-child(1)",
    "div:nth-child(1) > main:nth-child(2)",
    "header:nth-child(1)",
    "header:nth-child(1) > nav:nth-child(3)",
    "header:nth-child(1) > nav:nth-child(3) > img:nth-child(1)",
  ],
  ancestorComponents: [null, null, "app-header", "app-header", "app-header"],
}

/** The click above, sanitized the way the canvas does it. */
const selection = (): SelectionState => {
  const clean = sanitizeSelection(CLICKED, "/settings", "iphone-16-pro")
  if (!clean) throw new Error("fixture must sanitize")
  return clean
}

describe("sanitizeSelection — the ancestor chain it carries", () => {
  it("keeps the three per-crumb arrays aligned, index for index", () => {
    const s = selection()
    // Same element at every index: the label, the path's own last tag, and the
    // containing component all have to describe ONE element per index.
    expect(s.ancestors).toEqual(["div", "main", "app-header", "nav", "img"])
    expect(s.ancestorPaths[2]).toBe("header:nth-child(1)")
    expect(s.ancestorPaths[4]).toBe(s.elementPath)
    expect(s.ancestorComponents).toEqual(["", "", "app-header", "app-header", "app-header"])
    // The last crumb IS the clicked element, so its component is the message's
    // own `component` — the two are computed by the same `closest()` rule.
    expect(s.ancestorComponents[s.ancestorComponents.length - 1]).toBe(s.component)
  })

  it("clamps all three arrays to the same last-six window", () => {
    const chain = Array.from({ length: 9 }, (_, i) => `d${i}`)
    const s = sanitizeSelection(
      {
        ...CLICKED,
        ancestors: chain,
        ancestorPaths: chain.map((t) => `${t}:nth-child(1)`),
        ancestorComponents: chain.map(() => null),
      },
      "/",
      "desktop",
    )
    expect(s?.ancestors).toEqual(chain.slice(-6))
    expect(s?.ancestorPaths).toEqual(chain.slice(-6).map((t) => `${t}:nth-child(1)`))
    // A null component is "inside none", and it stays an index-aligned hole
    // rather than being filtered out — dropping it would shift every crumb
    // after it onto its neighbour's path.
    expect(s?.ancestorComponents).toEqual(chain.slice(-6).map(() => ""))
  })

  it("never lets a hostile payload put a non-string in the chain", () => {
    const s = sanitizeSelection(
      {
        ...CLICKED,
        ancestors: [1, { toString: () => "<img src=x onerror=alert(1)>" }, "main"],
        ancestorPaths: [null, "div:nth-child(1) > main:nth-child(2)", 7],
        ancestorComponents: [{ nope: true }, "app-header", null],
      },
      "/",
      "desktop",
    )
    expect(s?.ancestors).toEqual(["", "", "main"])
    expect(s?.ancestorPaths).toEqual(["", "div:nth-child(1) > main:nth-child(2)", ""])
    expect(s?.ancestorComponents).toEqual(["", "app-header", ""])
  })

  it("accepts a frame that predates the chain and widens to nothing", () => {
    // The fields are additive: an older runtime's message still sanitizes, it
    // just cannot be widened past (there is no path to widen TO).
    const s = sanitizeSelection({ ...CLICKED, ancestorPaths: undefined, ancestorComponents: undefined }, "/", "desktop")
    expect(s?.ancestors).toEqual(["div", "main", "app-header", "nav", "img"])
    expect(s?.ancestorPaths).toEqual([])
    expect(s?.ancestorComponents).toEqual([])
    expect(s && widenSelection(s, 0)).toBeNull()
  })

  it("refuses to widen a chain whose three arrays disagree on length", () => {
    // Three independent `slice(-6)`s are not three views of one window: a frame
    // can send five labels beside three paths, and then index 2 names `main` in
    // one array and `app-header` in the other. This is the assertion for the
    // guard, and it is stated on BOTH sides of the seam — the sanitizer drops
    // the pair (so the panel cannot offer a crumb for a label it has no path
    // for) AND widening to any index is refused, rather than the two arrays
    // being zipped up by index and the comment pinned to whatever fell out.
    const s = sanitizeSelection(
      {
        ...CLICKED,
        ancestors: ["div", "main", "app-header", "nav", "img"],
        ancestorPaths: ["div:nth-child(1)", "div:nth-child(1) > main:nth-child(2)", "header:nth-child(1)"],
        ancestorComponents: ["", "", "app-header", "app-header", "app-header"],
      },
      "/settings",
      "desktop",
    )
    // The labels survive — the breadcrumb draws them, and there is nothing
    // hostile about a label — but they render as plain text: `canWiden` needs a
    // path at that index, and there are none.
    expect(s?.ancestors).toEqual(["div", "main", "app-header", "nav", "img"])
    expect(s?.ancestorPaths).toEqual([])
    expect(s?.ancestorComponents).toEqual([])
    expect(s && widenSelection(s, 0)).toBeNull()
    expect(s && widenSelection(s, 2)).toBeNull()
  })

  it("keeps the click's own component when the frame stamps no component anywhere", () => {
    // `ancestorComponents` is `closest('[data-component]')` per ancestor, so a
    // chain with no component host above it — or one that stamps nothing — is a
    // row of nulls, and the innermost crumb is the one crumb whose component the
    // message already answered: its `component` field IS that `closest()` read.
    // The fallback is therefore not a second rule about which component an
    // element is in; it is the same rule, forwarded. What has to change to
    // fail: dropping `selection.component` from the innermost crumb's fallback
    // (the round trip then reports no component at all, and the agent is sent to
    // the page file for an element that lives in the component's) — or widening
    // the fallback to every crumb, which would claim `app-header` for `div`.
    const s = sanitizeSelection(
      { ...CLICKED, ancestorComponents: [null, null, null, null, null] },
      "/settings",
      "desktop",
    )
    if (!s) throw new Error("fixture must sanitize")
    expect(s.ancestorComponents).toEqual(["", "", "", "", ""])
    const clicked = widenSelection(s, s.ancestors.length - 1)
    expect(clicked?.component).toBe("app-header")
    expect(clicked?.elementPath).toBe("header:nth-child(1) > nav:nth-child(3) > img:nth-child(1)")
    // A crumb ABOVE the click is inside no component the frame could name, and
    // "" is what it says — not the click's component, and not the label.
    const outer = widenSelection(s, 0)
    expect(outer?.component).toBeNull()
  })
})

describe("widenSelection — a crumb click rebuilds the selection", () => {
  it("widens to the outermost crumb", () => {
    const w = widenSelection(selection(), 0)
    expect(w?.elementPath).toBe("div:nth-child(1)")
    expect(w?.component).toBeNull()
    expect(w?.tag).toBe("div")
    // The breadcrumb now shows this crumb as the current element, so the chain
    // it renders is the crumb's own upward path — nothing above it.
    expect(w?.ancestors).toEqual(["div"])
    expect(w?.ancestorPaths).toEqual(["div:nth-child(1)"])
  })

  it("widens to a component crumb: the label names the component, the path names the tag", () => {
    const w = widenSelection(selection(), 2)
    expect(w?.elementPath).toBe("header:nth-child(1)")
    // `app-header` is the component (the label); the element's tag is NOT
    // unknown — the crumb's own path ends with it.
    expect(w?.component).toBe("app-header")
    expect(w?.tag).toBe("header")
    expect(w?.ancestors).toEqual(["div", "main", "app-header"])
    expect(w?.ancestorComponents).toEqual(["", "", "app-header"])
  })

  it("widens to an element INSIDE a component, which is still that component's", () => {
    // The subtle one: `nav` is not itself a host, so a rule that read
    // "label has no hyphen ⇒ no component" would lose `app-header` and send the
    // agent to the page file instead of the component's.
    const w = widenSelection(selection(), 3)
    expect(w?.component).toBe("app-header")
    expect(w?.tag).toBe("nav")
  })

  it("widening to the clicked element itself is the selection it started from", () => {
    const s = selection()
    const w = widenSelection(s, s.ancestors.length - 1)
    expect(w?.elementPath).toBe(s.elementPath)
    expect(w?.component).toBe(s.component)
    expect(w?.tag).toBe(s.tag)
    expect(w?.ancestors).toEqual(s.ancestors)
    expect(w?.ancestorPaths).toEqual(s.ancestorPaths)
    expect(w?.ancestorComponents).toEqual(s.ancestorComponents)
  })

  it("refuses a stale index instead of pinning the comment somewhere else", () => {
    const s = selection()
    expect(widenSelection(s, s.ancestors.length)).toBeNull()
    expect(widenSelection(s, -1)).toBeNull()
    expect(widenSelection(s, 1.5)).toBeNull()
    // A chain that disagrees with itself — more paths than labels, which is what
    // a hostile frame can send and what `!elementPath` alone cannot catch: there
    // IS a path at that index, so only the bound on `ancestors` keeps the click
    // from naming an element the breadcrumb cannot show.
    const ragged = { ...s, ancestorPaths: [...s.ancestorPaths, "div:nth-child(9)"] }
    expect(widenSelection(ragged, s.ancestors.length)).toBeNull()
  })

  it("carries the captured artifacts a crumb cannot re-derive, and leaves the original untouched", () => {
    const s = selection()
    const before = JSON.parse(JSON.stringify(s)) as SelectionState
    const w = widenSelection(s, 1)
    // Rect/route/viewport are not re-derivable from a crumb: the chrome cannot
    // measure or re-read a cross-origin element, so the capture stays the
    // click's — the pin still marks the spot the human pointed at.
    expect(w?.rect).toEqual(s.rect)
    expect(w?.route).toBe("/settings")
    expect(w?.viewport).toBe("iphone-16-pro")
    expect(s).toEqual(before)
  })

  it("drops the two captures that name the wrong element when the crumb is not the click", () => {
    // `snippet` is the clicked `img`'s markup and `srcRef` is the file IT was
    // stamped from — `components/app-header.js`, because that is the file the
    // `img` came from. Widening to `main:nth-child(2)` re-anchors the target to
    // an element in the PAGE and tells the agent `file: pages/settings.html`,
    // while a kept `src` would still name a component file and a kept snippet
    // would show an element the target does not contain. Nothing in the
    // dispatch marks which of the two fields is authoritative, so they go. What
    // has to change to fail: dropping the `isClicked` condition (the innermost
    // crumb loses its own captures — the case below), or keeping them
    // unconditionally (this test).
    const s = selection()
    const w = widenSelection(s, 1)
    expect(w?.srcRef).toBeNull()
    expect(w?.snippet).toBe("")
    // The crumb's own identity is NOT part of this: the path, the component and
    // the tag are all still the ancestor's.
    expect(w?.elementPath).toBe("div:nth-child(1) > main:nth-child(2)")
    expect(w?.component).toBeNull()
    expect(w?.tag).toBe("main")
  })

  it("keeps both captures when the crumb IS the click", () => {
    // The innermost crumb is the element that was clicked, so its snippet and
    // src_ref describe the target exactly — the file the agent is sent to is
    // the one the markup came from, and the snippet is that markup. Dropping
    // them here would throw away the only copy the chrome has (the frame is
    // cross-origin and cannot be re-read).
    const s = selection()
    const w = widenSelection(s, s.ancestors.length - 1)
    expect(w?.srcRef).toBe("components/app-header.js:7")
    expect(w?.snippet).toBe('<img class="avatar">')
  })
})
