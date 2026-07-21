import { describe, it, expect } from "vitest"
import { splitTaskRefs, hasTaskRef } from "./task-refs"

describe("splitTaskRefs", () => {
  it("splits a reference out of surrounding text", () => {
    expect(splitTaskRefs("See TASK#10 please")).toEqual([
      { type: "text", value: "See " },
      { type: "task", id: 10, raw: "TASK#10" },
      { type: "text", value: " please" },
    ])
  })

  it("handles multiple references", () => {
    expect(splitTaskRefs("TASK#1 and TASK#22")).toEqual([
      { type: "task", id: 1, raw: "TASK#1" },
      { type: "text", value: " and " },
      { type: "task", id: 22, raw: "TASK#22" },
    ])
  })

  it("returns a lone text segment when there are no references", () => {
    expect(splitTaskRefs("nothing here")).toEqual([{ type: "text", value: "nothing here" }])
  })

  it("does not match TASK# without a number", () => {
    expect(splitTaskRefs("TASK# alone")).toEqual([{ type: "text", value: "TASK# alone" }])
  })

  it("returns an empty array for empty input", () => {
    expect(splitTaskRefs("")).toEqual([])
  })

  it("also matches a bare #<n> and lowercase task#<n>", () => {
    expect(splitTaskRefs("see #31 now")).toEqual([
      { type: "text", value: "see " },
      { type: "task", id: 31, raw: "#31" },
      { type: "text", value: " now" },
    ])
    expect(splitTaskRefs("task#5")).toEqual([{ type: "task", id: 5, raw: "task#5" }])
  })

  it("keeps the full TASK#<n> raw rather than matching the inner #<n>", () => {
    // The combined pattern must consume "TASK#10" whole, not leave "TASK" + "#10".
    expect(splitTaskRefs("TASK#10")).toEqual([{ type: "task", id: 10, raw: "TASK#10" }])
  })
})

describe("hasTaskRef", () => {
  it("detects a reference regardless of the regex's stateful lastIndex", () => {
    expect(hasTaskRef("look at TASK#3")).toBe(true)
    // Called twice to prove the /g lastIndex is reset each call.
    expect(hasTaskRef("look at TASK#3")).toBe(true)
    expect(hasTaskRef("no refs")).toBe(false)
  })
})
