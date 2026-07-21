import { describe, it, expect } from "vitest"
import { activityTools, matchesActivitySearch, filterActivityEvents, ALL_TOOLS } from "./activity-filter"

const events = [
  { action: "Read", actor: "Claude", detail: "read App.tsx", title: "Board", taskLabel: "Board updates" },
  { action: "Bash", actor: "Claude", detail: "npm run build", title: "Board", taskLabel: null },
  { action: "status_changed", actor: "dalmas", detail: "in_progress → done", title: "Timer", taskLabel: "Timer" },
]

describe("activityTools", () => {
  it("returns the distinct actions, sorted", () => {
    expect(activityTools(events)).toEqual(["Bash", "Read", "status_changed"])
  })
})

describe("matchesActivitySearch", () => {
  it("matches everything on an empty query", () => {
    expect(matchesActivitySearch(events[0], "  ")).toBe(true)
  })
  it("matches across action, actor, detail, title (case-insensitive)", () => {
    expect(matchesActivitySearch(events[1], "NPM")).toBe(true)
    expect(matchesActivitySearch(events[2], "dalmas")).toBe(true)
    expect(matchesActivitySearch(events[0], "board updates")).toBe(true)
  })
  it("rejects a non-match", () => {
    expect(matchesActivitySearch(events[0], "python")).toBe(false)
  })
})

describe("filterActivityEvents", () => {
  it("filters by tool", () => {
    expect(filterActivityEvents(events, { search: "", tool: "Bash" })).toEqual([events[1]])
  })
  it("ALL_TOOLS disables the tool filter", () => {
    expect(filterActivityEvents(events, { search: "", tool: ALL_TOOLS })).toHaveLength(3)
  })
  it("combines tool and search (AND)", () => {
    expect(filterActivityEvents(events, { search: "done", tool: "status_changed" })).toEqual([events[2]])
    expect(filterActivityEvents(events, { search: "done", tool: "Read" })).toEqual([])
  })
})
