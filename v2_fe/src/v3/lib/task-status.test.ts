import { describe, expect, it } from "vitest"

import { columnIdFor, normalizeStatus, pageGroupOf, statusOf } from "./task-status"

describe("flat statuses", () => {
  it("keeps paused and archived apart", () => {
    expect(statusOf({ status: "blocked", liveStatus: "paused" })).toBe("paused")
    expect(statusOf({ status: "done", liveStatus: "archived" })).toBe("archived")
    expect(statusOf({ status: "review", liveStatus: "partial_done" })).toBe("partial_done")
  })
  it("trusts a local move over a stale server status", () => {
    expect(statusOf({ status: "in_progress", liveStatus: "paused" })).toBe("in_progress")
    expect(statusOf({ status: "review" })).toBe("partial_done")
  })
  it("maps to v2's pages and moves", () => {
    expect(pageGroupOf("paused")).toBe("blocked")
    expect(pageGroupOf("partial_done")).toBe("review")
    expect(columnIdFor("paused")).toBeNull()
    expect(columnIdFor("partial_done")).toBe("review")
    expect(normalizeStatus("review")).toBe("partial_done")
    expect(normalizeStatus("nope")).toBeNull()
  })
})
