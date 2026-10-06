import { describe, expect, it } from "vitest"

import { colourControl } from "./token-swatch"

const ok = () => true

describe("colourControl", () => {
  it("uses the picker for 6-digit hex", () => {
    expect(colourControl("#aabbcc", undefined, ok)).toEqual({ kind: "picker", hex: "#aabbcc" })
  })
  it("uses a swatch for oklch", () => {
    expect(colourControl("oklch(0.97 0 0)", undefined, ok)).toEqual({ kind: "swatch", color: "oklch(0.97 0 0)" })
  })
  it("falls back to the inherited placeholder when empty", () => {
    expect(colourControl("", "oklch(0.5 0.1 200)", ok)).toEqual({ kind: "swatch", color: "oklch(0.5 0.1 200)" })
    expect(colourControl("", "#112233", ok)).toEqual({ kind: "picker", hex: "#112233" })
  })
  it("gives an undefined colour for unsafe or empty values", () => {
    expect(colourControl("url(x)", undefined, ok)).toEqual({ kind: "swatch", color: undefined })
    expect(colourControl("", undefined, ok)).toEqual({ kind: "swatch", color: undefined })
    expect(colourControl("oklch(1 0 0)", undefined, () => false)).toEqual({ kind: "swatch", color: undefined })
  })
})
