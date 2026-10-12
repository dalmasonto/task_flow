import { describe, it, expect } from "vitest"
import { dropMissingRoutes, shouldSeedRoutes } from "./design-view"

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

describe("dropMissingRoutes", () => {
  it("drops a route the manifest no longer lists — a page someone deleted", () => {
    // #681: the board would otherwise keep rendering a deleted page — a 404
    // inside a frame, which is the "empty broken screen" the owner reported.
    expect(dropMissingRoutes(["/", "/gone", "/kept"], ["/", "/kept"])).toEqual(["/", "/kept"])
  })

  it("keeps the SAME array when nothing is missing", () => {
    // The caller is a `useState` updater: returning a fresh array every time
    // would re-render the canvas (and re-persist the viewport) on every
    // manifest refetch, for nothing.
    const open = ["/", "/kept"]
    expect(dropMissingRoutes(open, ["/kept", "/", "/new"])).toBe(open)
  })

  it("keeps the open ORDER of what survives", () => {
    // Open routes are in manifest order by construction; dropping must not be
    // the writer that reorders them.
    expect(dropMissingRoutes(["/c", "/a", "/gone", "/b"], ["/a", "/b", "/c"])).toEqual([
      "/c",
      "/a",
      "/b",
    ])
  })

  it("drops everything when the manifest lists nothing", () => {
    expect(dropMissingRoutes(["/a", "/b"], [])).toEqual([])
  })
})
