import { describe, expect, it } from "vitest"

import type { UsageBucket } from "./usage-api"
import { cacheHitRate, change, dailySeries, toCsv, toMicros, windows } from "./usage-logic"

const b = (over: Partial<UsageBucket> = {}): UsageBucket => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 0, unpriced_reports: 0, reports: 0, ...over })

describe("windows", () => {
  it("makes a same-length previous window", () => {
    const w = windows("14d", new Date("2026-11-08T12:00:00Z"))
    expect(w.to.getTime() - w.from.getTime()).toBe(14 * 86_400_000)
    expect(w.prevTo.getTime()).toBe(w.from.getTime())
    expect(w.from.getTime() - w.prevFrom.getTime()).toBe(14 * 86_400_000)
    expect(w.days).toBe(14)
  })
  it("starts this month on the 1st", () => {
    const w = windows("month", new Date(2026, 10, 8, 12))
    expect(w.from.getDate()).toBe(1)
    expect(w.from.getMonth()).toBe(10)
  })
})

describe("dailySeries", () => {
  it("fills every day, zero when missing", () => {
    const s = dailySeries([{ key: "2026-11-07", usage: b({ input_tokens: 10, output_tokens: 5, cost_micros: 7 }) }], new Date("2026-11-06T10:00:00Z"), new Date("2026-11-08T10:00:00Z"))
    expect(s).toEqual([
      { day: "2026-11-06", tokens: 0, cost: 0 },
      { day: "2026-11-07", tokens: 15, cost: 7 },
      { day: "2026-11-08", tokens: 0, cost: 0 },
    ])
  })
})

describe("cacheHitRate and change", () => {
  it("computes the cache share", () => {
    expect(cacheHitRate(b({ input_tokens: 30, cache_read_tokens: 70 }))).toBe(0.7)
    expect(cacheHitRate(b())).toBeNull()
  })
  it("describes a change", () => {
    expect(change(112, 100)).toBe("12% more")
    expect(change(92, 100)).toBe("8% less")
    expect(change(101, 100)).toBe("About the same")
    expect(change(5, 0)).toBeNull()
  })
})

describe("toCsv and toMicros", () => {
  it("escapes labels and writes dollars", () => {
    const csv = toCsv("agent", [{ key: "1", label: 'Claude "main", v2', usage: b({ input_tokens: 3, cost_micros: 1_500_000, reports: 1 }) }])
    expect(csv.split("\n")[1]).toBe('"Claude ""main"", v2",3,0,0,0,1.500000,0,1')
  })
  it("parses dollars", () => {
    expect(toMicros("$150")).toBe(150_000_000)
    expect(toMicros("5.5")).toBe(5_500_000)
    expect(toMicros("")).toBeNull()
    expect(toMicros("abc")).toBeNull()
    expect(toMicros("-1")).toBeNull()
  })
})
