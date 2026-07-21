import { describe, it, expect } from "vitest"
import { firstLine } from "./markdown"

describe("firstLine", () => {
  it("returns the first non-empty line", () => {
    expect(firstLine("Ship the board\nthen the activity page")).toBe("Ship the board")
  })

  it("skips leading blank lines", () => {
    expect(firstLine("\n\n  \nReal content here")).toBe("Real content here")
  })

  it("strips a leading heading marker", () => {
    expect(firstLine("### Project\nDescribe the mission")).toBe("Project")
  })

  it("strips a leading list marker", () => {
    expect(firstLine("- first goal\n- second goal")).toBe("first goal")
    expect(firstLine("* bullet")).toBe("bullet")
  })

  it("strips a leading blockquote marker", () => {
    expect(firstLine("> a quoted mission")).toBe("a quoted mission")
  })

  it("returns an empty string for whitespace-only input", () => {
    expect(firstLine("   \n\n  ")).toBe("")
    expect(firstLine("")).toBe("")
  })
})
