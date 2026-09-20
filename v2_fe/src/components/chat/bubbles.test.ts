import { describe, expect, it } from "vitest"
import { designRefChipLabel, shouldShowDesignBadge } from "./bubbles"

describe("shouldShowDesignBadge", () => {
  it("shows the badge when enabled and the message is design", () => {
    expect(shouldShowDesignBadge(true, true)).toBe(true)
  })

  it("hides the badge when showDesignBadge is false (design rail)", () => {
    expect(shouldShowDesignBadge(false, true)).toBe(false)
  })

  it("hides the badge when the message is not design", () => {
    expect(shouldShowDesignBadge(true, false)).toBe(false)
  })

  it("is false-safe when both inputs are undefined", () => {
    expect(shouldShowDesignBadge(undefined, undefined)).toBe(false)
  })
})

describe("designRefChipLabel", () => {
  it("returns null when there is no design ref", () => {
    expect(designRefChipLabel(null)).toBeNull()
    expect(designRefChipLabel(undefined)).toBeNull()
  })

  it("prefers componentName over pagePath", () => {
    expect(designRefChipLabel({ componentName: "Header", pagePath: "pages/home.js" })).toBe("Header")
  })

  it("falls back to pagePath when componentName is absent", () => {
    expect(designRefChipLabel({ pagePath: "pages/home.js" })).toBe("pages/home.js")
  })

  it('falls back to "element" when neither componentName nor pagePath is present', () => {
    expect(designRefChipLabel({ elementPath: "div > span" })).toBe("element")
  })

  it("appends srcRef when present", () => {
    expect(designRefChipLabel({ pagePath: "pages/home.js", srcRef: "Home.tsx:42" })).toBe(
      "pages/home.js · Home.tsx:42",
    )
  })
})
