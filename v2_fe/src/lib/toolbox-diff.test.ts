import { describe, expect, it } from "vitest"

import { diffSummary, diffText } from "./toolbox-diff"
import { toolboxBadge, type ToolboxIndexEntry } from "./toolbox-api"

describe("diffText", () => {
  it("marks only what changed, and keeps the unchanged lines for context", () => {
    const diff = diffText("a\nb\nc\n", "a\nB\nc\nd\n")
    expect(diff).toEqual([
      { kind: "same", text: "a", left: 1, right: 1 },
      { kind: "remove", text: "b", left: 2 },
      { kind: "add", text: "B", right: 2 },
      { kind: "same", text: "c", left: 3, right: 3 },
      { kind: "add", text: "d", right: 4 },
      // The trailing empty line from the final newline is compared like any
      // other line — a script whose last newline was removed shows it.
      { kind: "same", text: "", left: 4, right: 5 },
    ])
    expect(diffSummary(diff)).toEqual({ added: 2, removed: 1 })
  })

  it("is all context when nothing changed", () => {
    const diff = diffText("same\n", "same\n")
    expect(diff.every((line) => line.kind === "same")).toBe(true)
    expect(diffSummary(diff)).toEqual({ added: 0, removed: 0 })
  })

  it("handles an empty side", () => {
    // From nothing: the two files ("new\n") share only the final empty line.
    expect(diffText("", "new\n").filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["new"])
    expect(diffText("gone\n", "").filter((l) => l.kind === "remove").map((l) => l.text)).toEqual(["gone"])
  })
})

describe("toolboxBadge", () => {
  const entry = (overrides: Partial<ToolboxIndexEntry>): ToolboxIndexEntry =>
    ({
      id: 1,
      kind: "script",
      name: "s",
      title: "S",
      description: "d",
      status: "approved",
      version: 1,
      tags: [],
      language: "bash",
      entrypoint: null,
      requires_env: [],
      last_run_at: null,
      last_run_ok: false,
      run_ok_count: 0,
      run_fail_count: 0,
      author_label: "a",
      updated_at: null,
      ...overrides,
    }) as ToolboxIndexEntry

  it("badges a script whose last run failed, and one that works", () => {
    expect(toolboxBadge(entry({ last_run_at: "2026-10-12T00:00:00Z", last_run_ok: false }))).toEqual({
      label: "failing",
      tone: "bad",
    })
    expect(toolboxBadge(entry({ last_run_at: "2026-10-12T00:00:00Z", last_run_ok: true }))).toEqual({
      label: "working",
      tone: "ok",
    })
  })

  it("says nothing before a script has ever run, and nothing for a memory", () => {
    expect(toolboxBadge(entry({}))).toBeNull()
    expect(toolboxBadge(entry({ kind: "memory", last_run_at: "2026-10-12T00:00:00Z" }))).toBeNull()
  })
})
