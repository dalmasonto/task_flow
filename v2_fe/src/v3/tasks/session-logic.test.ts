import { describe, expect, it } from "vitest"

import type { TaskflowTaskSession } from "@/api/client"

import { sessionElapsed, splitSessions } from "./session-logic"

const now = Date.parse("2026-11-08T12:00:00Z")
const s = (id: number, state: TaskflowTaskSession["state"], started: string, extra: Partial<TaskflowTaskSession> = {}) =>
  ({ id, state, started_at: started, ended_at: null, duration_seconds: null, ...extra }) as TaskflowTaskSession

describe("sessions", () => {
  it("counts a running session live and trusts the server's total otherwise", () => {
    expect(sessionElapsed(s(1, "running", "2026-11-08T11:00:00Z"), now)).toBe(3600)
    expect(sessionElapsed(s(2, "paused", "2026-11-08T10:00:00Z", { duration_seconds: 900 }), now)).toBe(900)
    expect(sessionElapsed(s(3, "stopped", "2026-11-08T09:00:00Z", { ended_at: "2026-11-08T09:30:00Z" }), now)).toBe(1800)
  })
  it("puts running before paused, and the newest finished first", () => {
    const { active, history } = splitSessions([
      s(1, "paused", "2026-11-08T08:00:00Z"),
      s(2, "running", "2026-11-08T07:00:00Z"),
      s(3, "stopped", "2026-11-07T07:00:00Z", { ended_at: "2026-11-07T08:00:00Z" }),
      s(4, "failed", "2026-11-08T06:00:00Z", { ended_at: "2026-11-08T06:10:00Z" }),
    ])
    expect(active.map((x) => x.id)).toEqual([2, 1])
    expect(history.map((x) => x.id)).toEqual([4, 3])
  })
})
