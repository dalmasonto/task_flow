import { describe, it, expect } from "vitest"
import { toolForKey } from "./canvas-tools"

/// `toolForKey` backs the canvas pointer-mode shortcuts (Task 3): `v` selects
/// the Select tool, `h` selects the Pan tool, and any other key is not a
/// shortcut for either.
describe("toolForKey", () => {
  it("maps v to select", () => {
    expect(toolForKey("v")).toBe("select")
  })

  it("maps h to pan", () => {
    expect(toolForKey("h")).toBe("pan")
  })

  it("is case-insensitive", () => {
    expect(toolForKey("V")).toBe("select")
    expect(toolForKey("H")).toBe("pan")
  })

  it("returns null for keys that are not tool shortcuts", () => {
    expect(toolForKey("x")).toBeNull()
    expect(toolForKey("c")).toBeNull()
    expect(toolForKey("")).toBeNull()
  })
})
