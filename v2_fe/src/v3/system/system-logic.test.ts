import { describe, expect, it } from "vitest"

import { connectionNotice, isChunkLoadError } from "./system-logic"

describe("isChunkLoadError", () => {
  it("recognises each browser's wording", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/a.js"))).toBe(true)
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true)
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true)
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/b.css"))).toBe(true)
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})

describe("connectionNotice", () => {
  it("prefers the browser, ignores blips", () => {
    expect(connectionNotice(false, "live", 0)).toBe("offline")
    expect(connectionNotice(true, "reconnecting", 3_000)).toBeNull()
    expect(connectionNotice(true, "reconnecting", 12_000)).toBe("unreachable")
    expect(connectionNotice(true, "live", 99_000)).toBeNull()
  })
})
