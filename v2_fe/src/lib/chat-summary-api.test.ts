import { afterEach, describe, expect, it, vi } from "vitest"

const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json" } })

describe("chat summary reads (#5983)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it("an older server's 404 (no handler error) answers null and isn't asked again", async () => {
    const f = vi.fn(async () => json(404, "<!doctype html>Not found"))
    vi.stubGlobal("fetch", f)
    const { fetchRoomSummaries } = await import("./chat-summary-api")
    expect(await fetchRoomSummaries(2)).toBeNull()
    expect(await fetchRoomSummaries(2)).toBeNull()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("a not-a-member 404 answers null but asks again next time", async () => {
    const f = vi.fn(async () => json(404, { error: "not_found" }))
    vi.stubGlobal("fetch", f)
    const { fetchFollowedThreads } = await import("./chat-summary-api")
    expect(await fetchFollowedThreads(9)).toBeNull()
    await fetchFollowedThreads(9)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it("returns the rows, and throws a sentence on a server error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, [{ channel: 1, mentions: 2 }])))
    const { fetchRoomSummaries } = await import("./chat-summary-api")
    expect(await fetchRoomSummaries(2)).toEqual([{ channel: 1, mentions: 2 }])
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "internal" })))
    await expect(fetchRoomSummaries(2)).rejects.toThrow("Couldn't load unread counts (500).")
  })
})
