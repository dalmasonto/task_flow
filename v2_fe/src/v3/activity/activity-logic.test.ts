import { describe, expect, it } from "vitest"

import type { TaskflowTaskActivity } from "@/api/client"

import { groupByDay, liveRowFits, matchesSearch, mergeActivity, verbOf } from "./activity-logic"

const row = (id: number, at: string, over: Partial<TaskflowTaskActivity> = {}): TaskflowTaskActivity => ({
  id,
  project: 2,
  task: 7,
  actor_kind: "agent",
  actor_user: null,
  actor_agent_id: 1,
  actor_label: "Claude (main)",
  action: "status_changed",
  body_markdown: "In progress → Review",
  metadata_json: null,
  created_at: at,
  ...over,
})

describe("mergeActivity", () => {
  it("dedupes by id, prefers the live copy, newest first", () => {
    const out = mergeActivity([row(1, "2026-11-08T10:00:00Z"), row(2, "2026-11-08T11:00:00Z")], [row(2, "2026-11-08T11:00:00Z", { body_markdown: "live" }), row(3, "2026-11-08T12:00:00Z")])
    expect(out.map((r) => r.id)).toEqual([3, 2, 1])
    expect(out[1].body_markdown).toBe("live")
  })
})

describe("liveRowFits", () => {
  const r = row(5, "2026-11-08T10:00:00Z")
  it("follows the project, actor and action filters", () => {
    expect(liveRowFits(r, 2, "all", null, null)).toBe(true)
    expect(liveRowFits(r, 3, "all", null, null)).toBe(false)
    expect(liveRowFits(r, 2, "user", null, null)).toBe(false)
    expect(liveRowFits(r, 2, "agent", "claimed", null)).toBe(false)
  })
  it("leaves out rows older than the loaded window", () => {
    expect(liveRowFits(r, 2, "all", null, "2026-11-08T11:00:00Z")).toBe(false)
  })
})

describe("matchesSearch", () => {
  it("searches actor, action, body, title and #id", () => {
    const r = row(1, "2026-11-08T10:00:00Z")
    expect(matchesSearch(r, "Fix login", "login")).toBe(true)
    expect(matchesSearch(r, undefined, "#7")).toBe(true)
    expect(matchesSearch(r, undefined, "review")).toBe(true)
    expect(matchesSearch(r, undefined, "codex")).toBe(false)
    expect(matchesSearch(r, undefined, "  ")).toBe(true)
  })
})

describe("groupByDay", () => {
  it("buckets into Today, Yesterday and dated days", () => {
    const now = new Date(2026, 10, 8, 15, 0).getTime()
    const g = groupByDay(
      [row(3, new Date(2026, 10, 8, 9).toISOString()), row(2, new Date(2026, 10, 7, 20).toISOString()), row(1, new Date(2026, 10, 1, 8).toISOString())],
      now,
    )
    expect(g.map((x) => x.label.split(",")[0])).toEqual(["Today", "Yesterday", expect.any(String)])
    expect(g[2].label).not.toBe("Today")
    expect(g.map((x) => x.rows.length)).toEqual([1, 1, 1])
  })
})

describe("verbOf", () => {
  it("reads task events and flags tool calls", () => {
    expect(verbOf("claimed")).toEqual({ verb: "claimed", tool: false })
    expect(verbOf("design_write_page")).toEqual({ verb: "design write page", tool: true })
  })
})
