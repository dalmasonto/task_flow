import { afterEach, describe, it, expect, vi } from "vitest"
import { fetchCurrentUser, parseOAuthRedirect, takeOAuthError } from "./auth-api"

describe("parseOAuthRedirect", () => {
  it("extracts a bearer token from the fragment", () => {
    expect(parseOAuthRedirect("#token=abc123&token_type=Bearer", "")).toEqual({
      kind: "token",
      token: "abc123",
    })
  })
  it("tolerates a fragment with no leading #", () => {
    expect(parseOAuthRedirect("token=abc123", "")).toEqual({ kind: "token", token: "abc123" })
  })
  it("surfaces an error from the fragment", () => {
    expect(parseOAuthRedirect("#error=access_denied", "")).toEqual({
      kind: "error",
      message: "access_denied",
    })
  })
  it("surfaces an error from the query string too", () => {
    expect(parseOAuthRedirect("", "?error=access_denied")).toEqual({
      kind: "error",
      message: "access_denied",
    })
  })
  it("prefers a token over a stray error param", () => {
    expect(parseOAuthRedirect("#token=abc&error=whatever", "")).toEqual({
      kind: "token",
      token: "abc",
    })
  })
  it("reports none for an ordinary page load", () => {
    expect(parseOAuthRedirect("", "")).toEqual({ kind: "none" })
    expect(parseOAuthRedirect("#section=1", "?page=2")).toEqual({ kind: "none" })
  })
})

describe("takeOAuthError", () => {
  it("reads and clears the stored error exactly once", () => {
    const store = new Map<string, string>([["taskflow.oauth.error", "access_denied"]])
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    }
    expect(takeOAuthError(storage)).toBe("access_denied")
    expect(takeOAuthError(storage)).toBeNull()
  })
  it("returns null when there is nothing stored", () => {
    const storage = { getItem: () => null, removeItem: () => {} }
    expect(takeOAuthError(storage)).toBeNull()
  })
})

describe("fetchCurrentUser", () => {
  const user = { id: 9, username: "probe", email: "p@example.com", is_staff: false, is_superuser: false }
  function stub(respond: () => Promise<Response>) {
    const store = new Map<string, string>([
      ["taskflow.auth.token", "umbral_x"],
      ["taskflow.auth.user", JSON.stringify(user)],
    ])
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    vi.stubGlobal("window", { localStorage, location: { origin: "http://localhost" } })
    vi.stubGlobal("fetch", vi.fn(respond))
    return store
  }
  afterEach(() => vi.unstubAllGlobals())

  it("signs out when the server rejects the token", async () => {
    const store = stub(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
    expect(await fetchCurrentUser()).toBeNull()
    expect(store.has("taskflow.auth.token")).toBe(false)
  })
  it("keeps the session through a network drop or an aborted check", async () => {
    const store = stub(() => Promise.reject(new TypeError("Failed to fetch")))
    expect(await fetchCurrentUser()).toEqual(user)
    expect(store.get("taskflow.auth.token")).toBe("umbral_x")
  })
  it("keeps the session through a server error or rate limit", async () => {
    for (const status of [429, 500, 502]) {
      const store = stub(async () => new Response("busy", { status }))
      expect(await fetchCurrentUser()).toEqual(user)
      expect(store.get("taskflow.auth.token")).toBe("umbral_x")
    }
  })
})
