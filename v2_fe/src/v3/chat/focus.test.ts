import { describe, expect, it } from "vitest"

import { canTakeFocus } from "./focus"

describe("canTakeFocus", () => {
  const calm = { selecting: false, overlayOpen: false, inOtherField: false }
  it("takes focus when nothing is in the way", () => {
    expect(canTakeFocus(calm)).toBe(true)
  })
  it("never interrupts a selection, an overlay, or another field", () => {
    expect(canTakeFocus({ ...calm, selecting: true })).toBe(false)
    expect(canTakeFocus({ ...calm, overlayOpen: true })).toBe(false)
    expect(canTakeFocus({ ...calm, inOtherField: true })).toBe(false)
  })
})
