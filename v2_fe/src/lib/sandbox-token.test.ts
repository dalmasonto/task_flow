import { describe, expect, it, vi } from "vitest"
import { sandboxTokenExpiry, sandboxTokenIsFresh, sandboxTokenSource, TOKEN_REFRESH_MARGIN_SECS } from "./sandbox-token"

// `{project}.{expiry hex}.{signature}` — 0x6ab988b0 is 1790544048.
const TOKEN = "13.6ab988b0.73413c8916d39badd2b7e147f7d42168"
const EXPIRY = 1790544048

describe("sandboxTokenExpiry", () => {
  it("reads the expiry second out of the token's middle part", () => {
    expect(sandboxTokenExpiry(TOKEN)).toBe(EXPIRY)
  })
  it("is null for anything that is not a token", () => {
    expect(sandboxTokenExpiry("")).toBeNull()
    expect(sandboxTokenExpiry("13")).toBeNull()
    expect(sandboxTokenExpiry("13.zz.sig")).toBeNull()
    expect(sandboxTokenExpiry("13..sig")).toBeNull()
  })
})

describe("sandboxTokenIsFresh", () => {
  it("is fresh with more than the margin left, stale within it, stale past it", () => {
    expect(sandboxTokenIsFresh(TOKEN, EXPIRY - TOKEN_REFRESH_MARGIN_SECS - 1)).toBe(true)
    expect(sandboxTokenIsFresh(TOKEN, EXPIRY - TOKEN_REFRESH_MARGIN_SECS)).toBe(false)
    expect(sandboxTokenIsFresh(TOKEN, EXPIRY - 1)).toBe(false)
    expect(sandboxTokenIsFresh(TOKEN, EXPIRY + 100)).toBe(false)
  })
  it("treats an unreadable token as stale", () => {
    expect(sandboxTokenIsFresh("junk", 0)).toBe(false)
  })
})

describe("sandboxTokenSource", () => {
  const fresh = (at: number) => `13.${at.toString(16)}.sig`

  it("hands back the token it has while that is fresh, without minting", async () => {
    const mint = vi.fn(async () => fresh(2_000_000))
    const get = sandboxTokenSource(fresh(1_000_000), mint, () => 1_000_000 - 600)
    expect(await get()).toBe(fresh(1_000_000))
    expect(await get()).toBe(fresh(1_000_000))
    expect(mint).not.toHaveBeenCalled()
  })

  it("mints once the token is within the margin, and keeps the new one", async () => {
    let now = 1_000_000 - 30
    const mint = vi.fn(async () => fresh(now + 600))
    const get = sandboxTokenSource(fresh(1_000_000), mint, () => now)
    expect(await get()).toBe(fresh(1_000_000 + 570))
    expect(mint).toHaveBeenCalledTimes(1)
    now += 10
    expect(await get()).toBe(fresh(1_000_000 + 570))
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it("mints once for concurrent asks, and starts from nothing", async () => {
    const mint = vi.fn(async () => fresh(5_000))
    const get = sandboxTokenSource(null, mint, () => 0)
    const [a, b] = await Promise.all([get(), get()])
    expect(a).toBe(fresh(5_000))
    expect(b).toBe(fresh(5_000))
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it("tells the caller about every token it mints", async () => {
    const seen: string[] = []
    const get = sandboxTokenSource(null, async () => fresh(5_000), () => 0, (t) => seen.push(t))
    await get()
    expect(seen).toEqual([fresh(5_000)])
  })
})
