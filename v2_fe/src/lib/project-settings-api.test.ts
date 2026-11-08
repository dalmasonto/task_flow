import { afterEach, describe, expect, it, vi } from "vitest"

import { updateTaskflowProject } from "./taskflow-api"

afterEach(() => vi.unstubAllGlobals())

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("window", { localStorage: { getItem: () => "tok" } })
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
  vi.stubGlobal("fetch", fetch)
  return fetch
}

describe("updateTaskflowProject (#1137)", () => {
  it("PATCHes the handler with only the allowlisted fields", async () => {
    const fetch = stubFetch(200, { id: 2, name: "New" })
    // A wider object, as App's form builds it, must not leak other columns.
    const wide = { name: "New", owner: 9, github_linked_by: 9, github_repo: "evil/repo" } as unknown as Parameters<typeof updateTaskflowProject>[1]
    await expect(updateTaskflowProject(2, wide)).resolves.toMatchObject({ name: "New" })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/taskflow\/projects\/2$/)
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(String(init.body))).toEqual({ name: "New" })
  })

  it("says what went wrong", async () => {
    stubFetch(409, { error: "slug_taken" })
    await expect(updateTaskflowProject(2, { slug: "x" })).rejects.toThrow("short name")
    stubFetch(403, { error: "owner_only" })
    await expect(updateTaskflowProject(2, { status: "archived" })).rejects.toThrow("Only an owner")
    stubFetch(403, { error: "owner_or_admin_only" })
    await expect(updateTaskflowProject(2, { name: "x" })).rejects.toThrow("owners and admins")
  })
})
