import { describe, expect, it } from "vitest"

import { isIsoDate, longDate, todayIn } from "./daily-logic"

describe("longDate", () => {
  it("formats a calendar date without shifting it", () => {
    const s = longDate("2026-11-01", new Date(2026, 10, 8))
    expect(s).toContain("1")
    expect(s).toMatch(/Sunday|Sun/)
    expect(s).not.toContain("2026")
  })
  it("adds the year for another year, and passes junk through", () => {
    expect(longDate("2025-03-02", new Date(2026, 0, 1))).toContain("2025")
    expect(longDate("yesterday")).toBe("yesterday")
  })
})

describe("todayIn", () => {
  it("uses the project's timezone", () => {
    const now = new Date("2026-11-08T22:30:00Z")
    expect(todayIn("Africa/Nairobi", now)).toBe("2026-11-09")
    expect(todayIn("UTC", now)).toBe("2026-11-08")
  })
  it("falls back on an unknown zone", () => {
    expect(isIsoDate(todayIn("Not/AZone"))).toBe(true)
  })
})
