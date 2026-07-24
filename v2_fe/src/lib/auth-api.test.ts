import { describe, it, expect } from "vitest"
import { parseOAuthRedirect, takeOAuthError } from "./auth-api"

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
