import { afterEach, describe, expect, it, vi } from "vitest"

import { createTaskflowTaskActivity } from "./taskflow-api"

afterEach(() => vi.unstubAllGlobals())

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("window", { localStorage: { getItem: () => "tok" } })
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
  vi.stubGlobal("fetch", fetch)
  return fetch
}

describe("createTaskflowTaskActivity (#1138)", () => {
  it("posts only the action and body to the task's route", async () => {
    const fetch = stubFetch(201, { id: 1, action: "commented" })
    await expect(createTaskflowTaskActivity(42, { action: "commented", body_markdown: "Looks good" })).resolves.toMatchObject({ id: 1 })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/taskflow\/tasks\/42\/activity$/)
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({ action: "commented", body_markdown: "Looks good" })
  })

  it("says what went wrong", async () => {
    stubFetch(400, { error: "invalid", detail: "A comment needs some text." })
    await expect(createTaskflowTaskActivity(1, { action: "commented", body_markdown: "" })).rejects.toThrow("needs some text")
    stubFetch(404, { error: "not_found" })
    await expect(createTaskflowTaskActivity(1, { action: "timer_started" })).rejects.toThrow("isn't in a project")
  })
})
