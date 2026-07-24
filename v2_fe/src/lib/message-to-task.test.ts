import { describe, it, expect } from "vitest"
import { messageToTask, TASK_TITLE_MAX } from "./message-to-task"

describe("messageToTask", () => {
  it("uses the first line as the title and the rest as the body", () => {
    expect(messageToTask("Add access rights to Member X\nAsk ops for the role first")).toEqual({
      title: "Add access rights to Member X",
      description: "Ask ops for the role first",
    })
  })

  it("leaves the body empty for a single-line message", () => {
    expect(messageToTask("Set up a staging environment")).toEqual({
      title: "Set up a staging environment",
      description: "",
    })
  })

  it("keeps the remaining lines intact, including blank ones between them", () => {
    const { description } = messageToTask("Title here\n\nfirst para\n\nsecond para")!
    expect(description).toBe("first para\n\nsecond para")
  })

  it("ignores leading blank lines when finding the title", () => {
    expect(messageToTask("\n\n  Real title\nbody")!.title).toBe("Real title")
  })

  // Splitting at a fixed character count lands mid-word; the line break is the
  // natural boundary, and the cap is only a fallback for a wall of text that has
  // none.
  it("falls back to a character cap when the first line is very long", () => {
    const long = "x".repeat(TASK_TITLE_MAX + 40)
    const { title, description } = messageToTask(long)!
    expect(title.length).toBeLessThanOrEqual(TASK_TITLE_MAX + 1) // +1 for the ellipsis
    // Nothing is lost: what the title dropped is still in the body.
    expect(description).toContain("x".repeat(20))
  })

  it("breaks the fallback on a word boundary rather than mid-word", () => {
    const words = "alpha beta gamma delta ".repeat(20)
    const { title } = messageToTask(words)!
    expect(title.endsWith(" ")).toBe(false)
    // The cut must not leave a half word before the ellipsis.
    expect(title.replace(/…$/, "").trimEnd()).toMatch(/(alpha|beta|gamma|delta)$/)
  })

  it("returns nothing usable for an empty or whitespace-only message", () => {
    expect(messageToTask("")).toBeNull()
    expect(messageToTask("   \n  \n ")).toBeNull()
  })

  it("trims trailing whitespace off the title", () => {
    expect(messageToTask("Trailing spaces here   \nbody")!.title).toBe("Trailing spaces here")
  })
})
