import { describe, expect, it } from "vitest"

import { gridDotOpacity, resolveLive, transformCss } from "./canvas-paint"
import { MAX_SCALE, MIN_SCALE } from "./canvas-zoom"

describe("transformCss", () => {
  it("formats the canvas layer's transform", () => {
    expect(transformCss({ x: 40, y: 40, scale: 0.6 })).toBe("translate(40px, 40px) scale(0.6)")
  })

  it("keeps the sign and the fraction of a negative/zoomed transform", () => {
    // Panned up-left and zoomed in: the imperative painter and the JSX have to
    // agree character for character, and a rounded or absolute-valued
    // coordinate would put the canvas back at the origin the moment a gesture
    // settled.
    expect(transformCss({ x: -12.5, y: 7, scale: 1.25 })).toBe(
      "translate(-12.5px, 7px) scale(1.25)",
    )
  })

  it("round-trips both ends of the zoom range", () => {
    // The clamp lives in design-canvas; this only asserts the string it builds
    // at the ends of the range those constants define.
    expect(transformCss({ x: 0, y: 0, scale: MIN_SCALE })).toBe("translate(0px, 0px) scale(0.25)")
    expect(transformCss({ x: 0, y: 0, scale: MAX_SCALE })).toBe("translate(0px, 0px) scale(2)")
  })
})

describe("gridDotOpacity", () => {
  it("keeps the grid fully up at and above 50% zoom", () => {
    expect(gridDotOpacity(1)).toBe(0.55)
    // The threshold is inclusive: 0.5 must NOT be treated as the fade's start,
    // or the grid dims one step early and never quite reaches full.
    expect(gridDotOpacity(0.5)).toBe(0.55)
  })

  it("fades the grid out between 50% and 30%", () => {
    expect(gridDotOpacity(0.4)).toBeCloseTo(0.18, 5)
    expect(gridDotOpacity(0.3)).toBe(0)
  })

  it("never goes negative below the fade's floor", () => {
    // A raw extrapolation is negative here, and a negative opacity is a
    // rendering-invalid value: the element would keep whatever the last valid
    // value was instead of disappearing.
    //
    // MIN_SCALE is the point that matters: it is the deepest zoom the user can
    // reach, so "the grid is gone at the bottom of the range" is a claim about
    // the canvas and not about one number.
    expect(gridDotOpacity(MIN_SCALE)).toBe(0)
    expect(gridDotOpacity(0)).toBe(0)
  })
})

type T = { x: number; y: number; scale: number }

describe("resolveLive", () => {
  // The canvas holds a gesture's transform in a ref and paints it directly; the
  // `transform` prop carries only the COMMITTED value. This rule decides which
  // of the two the next render paints, and it is a function with a test rather
  // than an `if` inside the canvas's layout effect because it is the part that
  // was got wrong once: the snap-back below was found by walking render
  // sequences by hand, which is exactly the evidence a rule needs to be pinned
  // by a test instead.

  it("adopts the prop when nothing is pending", () => {
    // Fit, a zoom button, a viewport restored from Dexie: each arrives as a new
    // prop with no gesture in flight, and the live ref has to follow it or the
    // next gesture pans from a position the canvas is not at — and the visible
    // correction snaps the view back to the old one.
    const live: T = { x: 0, y: 0, scale: 1 }
    const prop: T = { x: 40, y: 40, scale: 0.6 }
    expect(resolveLive(false, prop, live)).toBe(prop)
  })

  it("keeps the live value while a gesture is pending, when the prop is stale", () => {
    // THE SNAP-BACK. React writes this render's prop onto the layer element
    // itself, so any unrelated re-render mid-gesture — a Space press, a comment
    // arriving over SSE, a selection rect — re-asserts the PRE-gesture value
    // while the finger is still moving. Adopting the prop here drags the canvas
    // back to where the gesture started and holds it there until the settle.
    const live: T = { x: 120, y: -30, scale: 1.25 }
    const prop: T = { x: 0, y: 0, scale: 1 }
    expect(resolveLive(true, prop, live)).toBe(live)
  })

  it("keeps the live value while a gesture is pending, even for a foreign write", () => {
    // The other half of that decision, and the one a reader will question: this
    // prop is a REAL new value (Fit clicked from the keyboard, a hydration
    // write, a commit from somewhere else) and it is still not adopted. Yielding
    // would yank the canvas to another place under a moving finger — and worse,
    // the gesture's own accumulator (the pan anchor, the wheel's live scale)
    // would continue from a position the hand never chose. The external write is
    // left to the settle instead, which lands within 120ms and commits the
    // gesture. What that can cost is recorded at the canvas: a Fit/zoom press
    // windows into a momentum wheel tail, and (rarer) a hydrated viewport.
    const live: T = { x: 10, y: 10, scale: 0.8 }
    const prop: T = { x: 999, y: 999, scale: 1.4 }
    expect(resolveLive(true, prop, live)).toBe(live)
  })

  it("returns the object the two already share", () => {
    // The agreed case: a render that adopted the prop earlier left the ref
    // holding the very object the prop is, so there is nothing to adopt and
    // nothing to change — pending or not.
    const t: T = { x: 4, y: 4, scale: 1 }
    expect(resolveLive(false, t, t)).toBe(t)
    expect(resolveLive(true, t, t)).toBe(t)
  })

  it("adopts a distinct object that happens to equal the live value when idle", () => {
    // The comparison is identity, not value. A `setTransform({ ...t })` that
    // equals the live value still counts as the new truth when nothing is
    // pending and it is THAT object that comes back. It costs nothing (the
    // values agree) and it is what keeps the rule free of a deep compare on
    // every render.
    const live: T = { x: 4, y: 4, scale: 1 }
    const prop: T = { x: 4, y: 4, scale: 1 }
    expect(resolveLive(false, prop, live)).toBe(prop)
  })
})
