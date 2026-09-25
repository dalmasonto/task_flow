import { describe, expect, it } from "vitest"

import { boardKeyForSource } from "./design-frame-source"

// Bug A, reported from the deployed app, with this console trace:
//
//   Uncaught SecurityError: Failed to read a named property 'name' from
//   'Window': Blocked a frame with origin "https://taskflow.supercodehive.com"
//   from accessing a cross-origin frame. at Array.find (<anonymous>)
//
// `event.source` is the sandbox iframe's WindowProxy, and the sandbox is served
// from a DIFFERENT ORIGIN than the app in every deployment, so reading `name`
// off it throws. That throw escaped the whole `onMessage` handler, so
// `design:select` was never processed: inspect delivered nothing at all. Not an
// edge case — cross-origin is the normal case for these frames.
//
// Why this much scaffolding for one comparison: the repo has no jsdom/RTL, so a
// pure function over plain `{key, win}` pairs is the only way to get a
// regression test onto the line that broke. `win` stands in for
// `iframe.contentWindow`; the one property that matters is modelled by the
// throwing getter in `crossOriginWindowProxy()`.

/// The sender's WindowProxy, as seen from the app's origin. `name` is not
/// merely empty cross-origin — reading it throws, which is why matching by
/// property took down the entire message handler instead of mismatching.
function crossOriginWindowProxy() {
  const win: Record<string, unknown> = {}
  Object.defineProperty(win, "name", {
    get() {
      // The user's own console text, verbatim.
      throw new DOMException(
        `Failed to read a named property 'name' from 'Window': Blocked a frame with origin "https://taskflow.supercodehive.com" from accessing a cross-origin frame.`,
        "SecurityError",
      )
    },
  })
  return win
}

describe("boardKeyForSource", () => {
  it("matches the frame whose WindowProxy sent the message", () => {
    const first = crossOriginWindowProxy()
    const second = crossOriginWindowProxy()
    const frames = [
      { key: "board-a@laptop", win: first },
      { key: "board-b@laptop", win: second },
    ]

    expect(boardKeyForSource(frames, second)).toBe("board-b@laptop")
    expect(boardKeyForSource(frames, first)).toBe("board-a@laptop")
  })

  it("does not read the sender's `name` — reading it throws across origins", () => {
    const source = crossOriginWindowProxy()
    const frames = [{ key: "board-a@laptop", win: source }]

    // The mechanism, asserted directly: this is what the shipped matcher did,
    // and it is what killed inspect.
    expect(() => (source as { name?: string }).name).toThrow(/Blocked a frame/)

    expect(boardKeyForSource(frames, source)).toBe("board-a@laptop")
  })

  it("matches by identity, so a proxy whose `name` disagrees cannot pick another board", () => {
    // Same-origin frames inherit `name` from the attribute, so a disagreement
    // is not the everyday case — but identity is the thing we actually mean,
    // and reading the property is what we cannot do. A property match here
    // silently selects the WRONG board.
    const source = { name: "board-a@laptop" }
    const frames = [
      { key: "board-b@laptop", win: source },
      { key: "board-a@laptop", win: { name: "board-b@laptop" } },
    ]

    expect(boardKeyForSource(frames, source)).toBe("board-b@laptop")
  })

  it("returns null for an unknown sender, a null sender, or a frame with no window", () => {
    const frames = [
      { key: "board-a@laptop", win: null },
      { key: "board-b@laptop", win: crossOriginWindowProxy() },
    ]

    expect(boardKeyForSource(frames, crossOriginWindowProxy())).toBeNull()
    expect(boardKeyForSource(frames, null)).toBeNull()
    expect(boardKeyForSource([], crossOriginWindowProxy())).toBeNull()
  })
})
