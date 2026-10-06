import { describe, expect, it } from "vitest"
import {
  INSTRUCTION_TEMPLATES,
  agentInstructionsOf,
  insertTemplate,
  instructionsChanged,
  instructionsSnippet,
  latestInstructions,
  normalizeInstructions,
} from "./agent-instructions"

describe("INSTRUCTION_TEMPLATES", () => {
  it("offers Reviewer, Designer, Backend and Frontend, each a real role", () => {
    expect(INSTRUCTION_TEMPLATES.map((t) => t.id)).toEqual(["reviewer", "designer", "backend", "frontend"])
    expect(INSTRUCTION_TEMPLATES.map((t) => t.label)).toEqual(["Reviewer", "Designer", "Backend", "Frontend"])
    for (const t of INSTRUCTION_TEMPLATES) {
      expect(t.markdown.startsWith("## Role:"), t.id).toBe(true)
      expect(t.markdown, t.id).toContain("### Responsibilities")
      expect(t.markdown, t.id).toContain("### Conventions")
    }
  })
})

describe("normalizeInstructions", () => {
  it("turns blank text into null (a clear) and keeps real text verbatim", () => {
    expect(normalizeInstructions("")).toBeNull()
    expect(normalizeInstructions("  \n\t ")).toBeNull()
    expect(normalizeInstructions("  ## Role\n")).toBe("  ## Role\n")
  })
})

describe("instructionsChanged", () => {
  it("is false for an untouched draft, blank counting as none", () => {
    expect(instructionsChanged(null, "")).toBe(false)
    expect(instructionsChanged(undefined, "   ")).toBe(false)
    expect(instructionsChanged("same", "same")).toBe(false)
  })

  it("is true when text is added, edited or cleared", () => {
    expect(instructionsChanged(null, "x")).toBe(true)
    expect(instructionsChanged("a", "b")).toBe(true)
    expect(instructionsChanged("a", "")).toBe(true)
  })
})

describe("insertTemplate", () => {
  it("fills an empty editor with the template", () => {
    expect(insertTemplate("  ", "T")).toBe("T")
  })

  it("appends below existing text instead of replacing it", () => {
    expect(insertTemplate("mine\n\n", "T")).toBe("mine\n\nT")
  })
})

describe("instructionsSnippet", () => {
  it("is null without instructions", () => {
    expect(instructionsSnippet(null)).toBeNull()
    expect(instructionsSnippet(" \n")).toBeNull()
  })

  it("uses the first non-empty line without markdown markers", () => {
    expect(instructionsSnippet("\n## Role: Reviewer\n- x")).toBe("Role: Reviewer")
    expect(instructionsSnippet("- first bullet")).toBe("first bullet")
  })

  it("truncates long lines with an ellipsis", () => {
    const snippet = instructionsSnippet("a".repeat(200), 20)!
    expect(snippet).toHaveLength(20)
    expect(snippet.endsWith("…")).toBe(true)
  })
})

describe("latestInstructions", () => {
  const row = { markdown: "row", updated_at: "2026-10-06T10:00:00Z" }

  it("uses the row when nothing was saved here", () => {
    expect(latestInstructions(row, undefined)).toBe(row)
  })

  it("prefers a local save newer than the row", () => {
    const local = { markdown: "local", updated_at: "2026-10-06T11:00:00Z" }
    expect(latestInstructions(row, local)).toBe(local)
  })

  it("does not let an older local save mask a newer row", () => {
    const local = { markdown: "local", updated_at: "2026-10-06T09:00:00Z" }
    expect(latestInstructions(row, local)).toBe(row)
  })

  it("uses the local save when the row was never stamped", () => {
    const local = { markdown: "local", updated_at: "2026-10-06T09:00:00Z" }
    expect(latestInstructions({ markdown: null, updated_at: null }, local)).toBe(local)
  })
})

describe("agentInstructionsOf", () => {
  it("reads the two agent columns, a missing column counting as null", () => {
    expect(agentInstructionsOf({ instructions_markdown: "x", instructions_updated_at: "t" })).toEqual({
      markdown: "x",
      updated_at: "t",
    })
    expect(agentInstructionsOf({})).toEqual({ markdown: null, updated_at: null })
  })
})
