import { describe, expect, it } from "vitest"

import { readJson } from "@/lib/auth-api"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function htmlResponse(status = 200): Response {
  return new Response("<!doctype html><html><head><title>Login</title></head></html>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

describe("readJson", () => {
  it("parses a JSON body on the success path", async () => {
    const data = await readJson<{ id: number; name: string }>(
      jsonResponse({ id: 7, name: "Wall Sit" }),
    )
    expect(data).toEqual({ id: 7, name: "Wall Sit" })
  })

  it("returns undefined for a 204 No Content response", async () => {
    const data = await readJson(new Response(null, { status: 204 }))
    expect(data).toBeUndefined()
  })

  it("throws a clear, actionable error when the server returns HTML instead of JSON", async () => {
    // This is the real-world case: a relative/misconfigured API base URL or an
    // unproxied path makes the SPA host answer with index.html (200 + text/html).
    await expect(readJson(htmlResponse(200))).rejects.toThrow(/expected json/i)
    // It must NOT surface the opaque native parser message.
    await expect(readJson(htmlResponse(200))).rejects.not.toThrow(/unexpected token/i)
  })

  it("names the status so an HTML error page is diagnosable", async () => {
    await expect(readJson(htmlResponse(502))).rejects.toThrow(/502/)
  })

  it("throws a clear error when the content type claims JSON but the body is malformed", async () => {
    const broken = new Response("<!doctype html>not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    await expect(readJson(broken)).rejects.toThrow(/expected json/i)
    await expect(readJson(broken)).rejects.not.toThrow(/unexpected token/i)
  })
})
