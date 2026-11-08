import { describe, expect, it } from "vitest"

import { timeAgo } from "./time"

const now = Date.parse("2026-11-08T12:00:00Z")
const ago = (ms: number) => new Date(now - ms).toISOString()

describe("timeAgo", () => {
  it("reads like a person would say it", () => {
    expect(timeAgo(ago(10_000), now)).toBe("just now")
    expect(timeAgo(ago(2 * 60_000), now)).toBe("2m ago")
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe("3h ago")
    expect(timeAgo(ago(26 * 3_600_000), now)).toBe("Yesterday")
    expect(timeAgo(ago(4 * 86_400_000), now)).toBe("4d ago")
  })
  it("handles missing, bad and future timestamps", () => {
    expect(timeAgo(null, now)).toBeNull()
    expect(timeAgo("not a date", now)).toBeNull()
    expect(timeAgo(new Date(now + 60_000).toISOString(), now)).toBe("just now")
  })
})
