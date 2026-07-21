import { describe, it, expect } from "vitest"
import { detectMention } from "./mention"

describe("detectMention", () => {
  it("opens on a lone @ at the start", () => {
    expect(detectMention("@", 1)).toEqual({ start: 0, query: "" })
  })

  it("captures the query typed after @", () => {
    expect(detectMention("hey @cla", 8)).toEqual({ start: 4, query: "cla" })
  })

  it("opens after whitespace mid-text", () => {
    expect(detectMention("ping @a here", 7)).toEqual({ start: 5, query: "a" })
  })

  it("does not treat an email's @ as a mention (mid-word)", () => {
    expect(detectMention("mail a@b.com", 12)).toBeNull()
  })

  it("closes once a space follows the mention", () => {
    // caret is after the space, no longer in the mention.
    expect(detectMention("@claude done", 12)).toBeNull()
  })

  it("returns null when there is no @ before the caret", () => {
    expect(detectMention("just text", 9)).toBeNull()
  })

  it("uses the caret, not the end of the string", () => {
    // caret right after "@cl", ignoring "aude" that follows.
    expect(detectMention("@claude", 3)).toEqual({ start: 0, query: "cl" })
  })
})
