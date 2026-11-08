import { describe, expect, it } from "vitest"

import { columnKeyOf, columnStats, DEFAULT_COLUMNS, isFirstOfKind, keyFor, parseColumns } from "./columns"

const cols = parseColumns({
  version: 3,
  custom: true,
  columns: [
    { key: "todo", label: "To do", kind: "not_started", task_count: 4 },
    { key: "doing", label: "Doing", kind: "in_progress", task_count: 2 },
    { key: "qa", label: "QA", kind: "in_progress", task_count: 1 },
    { key: "x", label: "Bogus", kind: "nope" },
  ],
}).columns

describe("board columns", () => {
  it("defaults to one column per status, archived hidden", () => {
    expect(DEFAULT_COLUMNS.columns.map((c) => c.key)).toEqual(["not_started", "in_progress", "paused", "blocked", "partial_done", "done", "archived"])
    expect(DEFAULT_COLUMNS.columns.filter((c) => c.hidden).map((c) => c.key)).toEqual(["archived"])
  })
  it("parses the server's list and drops unknown kinds", () => {
    expect(cols.map((c) => [c.key, c.count])).toEqual([["todo", 4], ["doing", 2], ["qa", 1]])
    expect(parseColumns({ columns: [] })).toBe(DEFAULT_COLUMNS)
  })
  it("places a task like the server does", () => {
    expect(columnKeyOf(cols, "in_progress", "qa")).toBe("qa")
    expect(columnKeyOf(cols, "in_progress", "todo")).toBe("doing")
    expect(columnKeyOf(cols, "in_progress", null)).toBe("doing")
    expect(columnKeyOf(cols, "paused", null)).toBeNull()
    expect(isFirstOfKind(cols, "doing")).toBe(true)
    expect(isFirstOfKind(cols, "qa")).toBe(false)
  })
  it("makes unique keys from labels", () => {
    expect(keyFor("Code Review!", [])).toBe("code-review")
    expect(keyFor("QA", ["qa", "qa-2"])).toBe("qa-3")
    expect(keyFor("✨", [])).toBe("column")
  })
})

describe("columnStats", () => {
  it("uses the server's count, else the group's when it's the status alone", () => {
    expect(columnStats({ kind: "in_progress", count: 7 }, false, 3, 3, 9)).toEqual({ total: 7, more: true })
    expect(columnStats({ kind: "in_progress", count: null }, false, 3, 3, 9)).toEqual({ total: 9, more: true })
    expect(columnStats({ kind: "paused", count: null }, false, 2, 5, 5)).toEqual({ total: null, more: false })
    expect(columnStats({ kind: "paused", count: null }, false, 2, 5, 8)).toEqual({ total: null, more: true })
    expect(columnStats({ kind: "done", count: 4 }, false, 4, 10, 30)).toEqual({ total: 4, more: false })
  })
})
