import { describe, it, expect } from "vitest"
import { spliceAtCaret, fileReferenceText } from "./composer"

describe("spliceAtCaret", () => {
  it("inserts at a collapsed caret and moves the caret past the insert", () => {
    expect(spliceAtCaret("hello world", 5, 5, "X")).toEqual({ value: "helloX world", caret: 6 })
  })

  it("replaces a selection with the insert", () => {
    // "hello" selected (0..5) -> replaced by "hi"
    expect(spliceAtCaret("hello world", 0, 5, "hi")).toEqual({ value: "hi world", caret: 2 })
  })

  it("appends at the end", () => {
    expect(spliceAtCaret("abc", 3, 3, "!")).toEqual({ value: "abc!", caret: 4 })
  })

  it("inserts into an empty value", () => {
    expect(spliceAtCaret("", 0, 0, "[x]")).toEqual({ value: "[x]", caret: 3 })
  })
})

describe("fileReferenceText", () => {
  // Clicking a staged file drops its name, square-bracketed, at the caret so a
  // message can point at one specific attachment among several.
  it("wraps the filename in square brackets", () => {
    expect(fileReferenceText("Screenshot from 2026-07-21.png")).toBe("[Screenshot from 2026-07-21.png]")
  })
})
