import { describe, expect, it } from "vitest"

import { rememberOffset } from "./use-scroll-memory"

describe("rememberOffset (#1093)", () => {
  it("keeps the latest offset per history entry", () => {
    const store = new Map<string, number>()
    rememberOffset("a", 10, store)
    rememberOffset("a", 420, store)
    expect(store.get("a")).toBe(420)
  })
  it("stays bounded, dropping the oldest entry", () => {
    const store = new Map<string, number>()
    for (let i = 0; i < 205; i++) rememberOffset(`k${i}`, i, store)
    expect(store.size).toBe(200)
    expect(store.has("k0")).toBe(false)
    expect(store.get("k204")).toBe(204)
  })
})
