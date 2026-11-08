import { describe, expect, it } from "vitest"

import { clampActive, mentionPickerKey, rankMentionMatches } from "./mention-picker"

const people = ["Claude (main)", "reviewer (codex)", "Dalmas Ogembo", "dalmasonto", "DeepSeek (api)"]

describe("rankMentionMatches", () => {
  it("puts exact, then prefix, then word-start, then substring matches first", () => {
    expect(rankMentionMatches(people, "dalmas", (p) => p)).toEqual(["Dalmas Ogembo", "dalmasonto"])
    expect(rankMentionMatches(people, "codex", (p) => p)).toEqual(["reviewer (codex)"])
    expect(rankMentionMatches(["xmain", "main box", "Claude (main)"], "main", (p) => p)).toEqual(["main box", "Claude (main)", "xmain"])
    expect(rankMentionMatches(people, "dalmasonto", (p) => p)[0]).toBe("dalmasonto")
  })

  it("an empty query lists everyone in order, capped", () => {
    expect(rankMentionMatches(people, "", (p) => p, 3)).toEqual(people.slice(0, 3))
  })

  it("no match is an empty list", () => {
    expect(rankMentionMatches(people, "zzz", (p) => p)).toEqual([])
  })
})

describe("mentionPickerKey", () => {
  it("arrows move and wrap at both ends", () => {
    expect(mentionPickerKey({ key: "ArrowDown" }, 3, 0)).toEqual({ kind: "move", index: 1 })
    expect(mentionPickerKey({ key: "ArrowDown" }, 3, 2)).toEqual({ kind: "move", index: 0 })
    expect(mentionPickerKey({ key: "ArrowUp" }, 3, 0)).toEqual({ kind: "move", index: 2 })
    expect(mentionPickerKey({ key: "Tab", shiftKey: true }, 3, 1)).toEqual({ kind: "move", index: 0 })
  })

  it("Enter and Tab pick the highlighted row instead of sending", () => {
    expect(mentionPickerKey({ key: "Enter" }, 3, 1)).toEqual({ kind: "pick", index: 1 })
    expect(mentionPickerKey({ key: "Tab" }, 3, 2)).toEqual({ kind: "pick", index: 2 })
  })

  it("Esc closes; Shift+Enter, an IME and modified keys fall through", () => {
    expect(mentionPickerKey({ key: "Escape" }, 2, 0)).toEqual({ kind: "close" })
    expect(mentionPickerKey({ key: "Enter", shiftKey: true }, 2, 0)).toEqual({ kind: "none" })
    expect(mentionPickerKey({ key: "Enter", isComposing: true }, 2, 0)).toEqual({ kind: "none" })
    expect(mentionPickerKey({ key: "Enter", metaKey: true }, 2, 0)).toEqual({ kind: "none" })
    expect(mentionPickerKey({ key: "a" }, 2, 0)).toEqual({ kind: "none" })
  })

  it("with no rows every key is the composer's, so Enter sends as usual", () => {
    for (const key of ["Enter", "Tab", "ArrowDown", "Escape"]) {
      expect(mentionPickerKey({ key }, 0, 0)).toEqual({ kind: "none" })
    }
  })

  it("a stale highlight past the end picks the last row", () => {
    expect(mentionPickerKey({ key: "Enter" }, 2, 5)).toEqual({ kind: "pick", index: 1 })
    expect(clampActive(-1, 3)).toBe(0)
    expect(clampActive(4, 3)).toBe(2)
  })
})
