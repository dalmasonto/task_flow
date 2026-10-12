import { describe, expect, it } from "vitest"

import { isBoardChord, isBoardShortcut } from "./board-shortcut"

const press = (overrides: Record<string, unknown> = {}) => ({
  key: "b",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target: { tagName: "BODY" },
  ...overrides,
})

describe("isBoardShortcut", () => {
  it("fires on Cmd/Ctrl+B", () => {
    expect(isBoardShortcut(press({ metaKey: true }))).toBe(true)
    expect(isBoardShortcut(press({ ctrlKey: true }))).toBe(true)
    expect(isBoardShortcut(press({ metaKey: true, key: "B" }))).toBe(true)
  })

  it("ignores other keys and other modifiers", () => {
    expect(isBoardShortcut(press())).toBe(false)
    expect(isBoardShortcut(press({ metaKey: true, key: "n" }))).toBe(false)
    expect(isBoardShortcut(press({ metaKey: true, shiftKey: true }))).toBe(false)
    expect(isBoardShortcut(press({ metaKey: true, altKey: true }))).toBe(false)
  })

  it("stays out of the way while someone is typing", () => {
    // Cmd+B is bold in a text field, and a chat draft must not open a board.
    expect(isBoardShortcut(press({ metaKey: true, target: { tagName: "INPUT" } }))).toBe(false)
    expect(isBoardShortcut(press({ metaKey: true, target: { tagName: "TEXTAREA" } }))).toBe(false)
    expect(isBoardShortcut(press({ metaKey: true, target: { tagName: "SELECT" } }))).toBe(false)
    expect(isBoardShortcut(press({ metaKey: true, target: { tagName: "DIV", isContentEditable: true } }))).toBe(false)
  })

  it("the chord alone ignores where the focus is — closing must work from the board's own search box", () => {
    expect(isBoardChord(press({ metaKey: true, target: { tagName: "INPUT" } }))).toBe(true)
    expect(isBoardChord(press({ metaKey: true, key: "n" }))).toBe(false)
  })

  it("works with no target at all (a synthetic key event)", () => {
    expect(isBoardShortcut(press({ metaKey: true, target: null }))).toBe(true)
  })
})
