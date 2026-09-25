import { describe, it, expect } from "vitest"
import { shouldSeedRoutes } from "./design-view"

describe("shouldSeedRoutes", () => {
  it("seeds from the manifest when nothing was stored", () => {
    expect(shouldSeedRoutes(null, false)).toBe(true)
  })

  it("does NOT seed when a stored viewport exists", () => {
    // The whole point of persistence: reopening the page must not re-open every
    // route the user deliberately closed.
    expect(shouldSeedRoutes({ openRoutes: ["/"] } as never, false)).toBe(false)
  })

  it("seeds a stored viewport that has no routes at all", () => {
    // A user who closed every page on purpose still gets the manifest default
    // rather than an empty canvas they cannot recover from.
    expect(shouldSeedRoutes({ openRoutes: [] } as never, false)).toBe(true)
  })

  it("never seeds twice for the same project", () => {
    expect(shouldSeedRoutes(null, true)).toBe(false)
  })
})
