import { describe, expect, it } from "vitest"

import { expiresLine, roleArticle, githubStatusLine, trackingWarning, avatarFileError, AVATAR_MAX_BYTES } from "./account-logic"

describe("roleArticle", () => {
  it("picks the article", () => {
    expect(roleArticle("Member")).toBe("a member")
    expect(roleArticle("admin")).toBe("an admin")
    expect(roleArticle("Owner")).toBe("an owner")
  })
})

describe("expiresLine", () => {
  const now = new Date(2026, 10, 8, 15).getTime()
  it("counts calendar days", () => {
    expect(expiresLine(new Date(2026, 10, 14, 9).toISOString(), now)).toBe("Expires in 6 days")
    expect(expiresLine(new Date(2026, 10, 9, 1).toISOString(), now)).toBe("Expires tomorrow")
    expect(expiresLine(new Date(2026, 10, 8, 23).toISOString(), now)).toBe("Expires today")
    expect(expiresLine(new Date(2026, 10, 8, 10).toISOString(), now)).toBe("Expired")
    expect(expiresLine(null, now)).toBeNull()
  })
})

describe("passwordError", () => {
  it("checks in order", async () => {
    const { passwordError } = await import("./account-logic")
    expect(passwordError("", "longenough", "longenough")).toMatch(/current/)
    expect(passwordError("old", "short", "short")).toMatch(/8 characters/)
    expect(passwordError("samesame1", "samesame1", "samesame1")).toMatch(/different/)
    expect(passwordError("old", "longenough", "longenougx")).toMatch(/match/)
    expect(passwordError("old", "longenough", "longenough")).toBeNull()
  })
})

describe("describeAgent", () => {
  it("names common browsers and the CLI", async () => {
    const { describeAgent } = await import("./account-logic")
    expect(describeAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36")).toBe("Chrome on Linux")
    expect(describeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile Safari/604.1")).toBe("Safari on iOS")
    expect(describeAgent("Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Windows")
    expect(describeAgent("node")).toBe("TaskFlow CLI or script")
    expect(describeAgent(null)).toBeNull()
  })
})

describe("profilePatch", () => {
  it("sends only what changed, normalised", async () => {
    const { profilePatch } = await import("./account-logic")
    const was = { full_name: null, username: "dalmas", email: "d@x.com" }
    expect(profilePatch(was, { full_name: "", username: "dalmas", email: "d@x.com" })).toEqual({})
    expect(profilePatch(was, { full_name: " Dalmas O ", username: "Dalmas", email: "D@X.com" })).toEqual({ full_name: "Dalmas O" })
    expect(profilePatch(was, { full_name: "", username: "newname", email: "new@x.com" })).toEqual({ username: "newname", email: "new@x.com" })
  })
})

describe("GitHub connection (#1135)", () => {
  const now = Date.parse("2026-11-08T12:00:00Z")
  it("says who and when, like the design", () => {
    expect(githubStatusLine({ connected: true, login: "dalmasonto", connected_at: "2026-07-23T10:00:00Z" }, now)).toBe("Connected as @dalmasonto on 23 July")
    expect(githubStatusLine({ connected: true, login: null, connected_at: "2026-07-23T10:00:00Z" }, now)).toBe("Connected on 23 July")
    expect(githubStatusLine({ connected: true, login: "a", connected_at: "2025-03-02T10:00:00Z" }, now)).toBe("Connected as @a on 2 March 2025")
    expect(githubStatusLine({ connected: true }, now)).toBe("Connected")
    expect(githubStatusLine({ connected: false }, now)).toMatch(/^Not connected/)
  })
  it("warns about the projects whose issue sync uses the connection", () => {
    expect(trackingWarning([])).toBeNull()
    expect(trackingWarning(undefined)).toBeNull()
    expect(trackingWarning([{ name: "Matchday" }])).toBe("Issue sync for Matchday uses your connection. It stops until someone in that project reconnects GitHub.")
    expect(trackingWarning([{ name: "A" }, { name: "B" }, { name: "C" }])).toBe("Issue sync for A, B and C uses your connection. It stops until someone in each reconnects GitHub.")
  })
})

describe("avatarFileError (#1135)", () => {
  it("accepts the four image types up to 1 MB, refuses the rest", () => {
    expect(avatarFileError({ size: 2000, type: "image/webp" })).toBeNull()
    expect(avatarFileError({ size: AVATAR_MAX_BYTES, type: "image/jpeg" })).toBeNull()
    expect(avatarFileError({ size: AVATAR_MAX_BYTES + 1, type: "image/png" })).toMatch(/over 1 MB/)
    expect(avatarFileError({ size: 2000, type: "image/svg+xml" })).toMatch(/PNG, JPEG, WebP or GIF/)
    expect(avatarFileError({ size: 0, type: "image/png" })).toBe("That file is empty.")
  })
})
