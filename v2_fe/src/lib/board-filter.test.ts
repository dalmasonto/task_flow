import { describe, it, expect } from "vitest"
import { matchesBoardSearch, filterBoardTasks, ALL_PRIORITIES } from "./board-filter"

const tasks = [
  { id: "12", title: "Fix the board", priority: "high", owner: "dalmas", operatorName: "Claude", tags: ["ui"] },
  { id: "13", title: "Chat chips", priority: "normal", owner: "dalmas", operatorName: "Claude", tags: ["chat", "markdown"] },
  { id: "21", title: "Session timer", priority: "critical", owner: "monto", operatorName: "Claude", tags: [] },
]

describe("matchesBoardSearch", () => {
  it("matches everything on empty query", () => {
    expect(matchesBoardSearch(tasks[0], "  ")).toBe(true)
  })
  it("matches the task id, with or without a hash", () => {
    expect(matchesBoardSearch(tasks[2], "#21")).toBe(true)
    expect(matchesBoardSearch(tasks[2], "21")).toBe(true)
  })
  it("matches title, owner, and tags (case-insensitive)", () => {
    expect(matchesBoardSearch(tasks[0], "BOARD")).toBe(true)
    expect(matchesBoardSearch(tasks[2], "monto")).toBe(true)
    expect(matchesBoardSearch(tasks[1], "markdown")).toBe(true)
  })
  it("rejects a non-match", () => {
    expect(matchesBoardSearch(tasks[0], "python")).toBe(false)
  })
})

describe("filterBoardTasks", () => {
  it("filters by priority", () => {
    expect(filterBoardTasks(tasks, { search: "", priority: "critical" })).toEqual([tasks[2]])
  })
  it("ALL_PRIORITIES disables the priority filter", () => {
    expect(filterBoardTasks(tasks, { search: "", priority: ALL_PRIORITIES })).toHaveLength(3)
  })
  it("combines priority and search (AND)", () => {
    expect(filterBoardTasks(tasks, { search: "chips", priority: "normal" })).toEqual([tasks[1]])
    expect(filterBoardTasks(tasks, { search: "chips", priority: "high" })).toEqual([])
  })
})
