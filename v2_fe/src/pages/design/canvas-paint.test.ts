import { describe, expect, it } from "vitest"

import { gridDotOpacity, transformCss } from "./canvas-paint"
import { MAX_SCALE, MIN_SCALE } from "./design-canvas"

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
    expect(gridDotOpacity(MIN_SCALE)).toBe(0)
    expect(gridDotOpacity(0)).toBe(0)
  })
})
