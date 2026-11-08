import { describe, expect, it } from "vitest"

import { expiresLine, roleArticle } from "./account-logic"

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
