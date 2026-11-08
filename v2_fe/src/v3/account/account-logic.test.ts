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
