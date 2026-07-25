import { describe, it, expect } from "vitest"
import { formatWorkedTime, barModel, fillDaySeries } from "./dashboard-stats"

describe("formatWorkedTime", () => {
  it("renders zero as 0m", () => { expect(formatWorkedTime(0)).toBe("0m") })
  it("renders sub-hour as minutes", () => { expect(formatWorkedTime(40 * 60)).toBe("40m") })
  it("renders hours and minutes", () => { expect(formatWorkedTime(12 * 3600 + 40 * 60)).toBe("12h 40m") })
  it("renders whole hours without stray minutes", () => { expect(formatWorkedTime(3 * 3600)).toBe("3h 0m") })
  it("rounds seconds down to the nearest minute", () => { expect(formatWorkedTime(59)).toBe("0m") })
})

describe("barModel", () => {
  it("scales each row to a pct of the max value", () => {
    const rows = [{ n: 10 }, { n: 5 }, { n: 0 }]
    const out = barModel(rows, (r) => r.n)
    expect(out[0].pct).toBe(100)
    expect(out[1].pct).toBe(50)
    expect(out[2].pct).toBe(0)
  })
  it("is safe when every value is zero (no divide-by-zero)", () => {
    const out = barModel([{ n: 0 }, { n: 0 }], (r) => r.n)
    expect(out.every((r) => r.pct === 0)).toBe(true)
  })
})

describe("fillDaySeries", () => {
  it("fills missing days in the range with zero, in order", () => {
    // 3-day window ending at a fixed 'now'; only the middle day has data.
    const now = Date.parse("2026-07-22T12:00:00Z")
    const out = fillDaySeries([{ day: "2026-07-21", count: 4 }], "7d", now)
    const map = Object.fromEntries(out.map((d) => [d.day, d.count]))
    expect(map["2026-07-21"]).toBe(4)
    expect(map["2026-07-20"]).toBe(0)
    // ascending, contiguous
    const days = out.map((d) => d.day)
    expect([...days].sort()).toEqual(days)
  })
})
