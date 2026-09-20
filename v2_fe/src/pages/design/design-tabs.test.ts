import { describe, it, expect } from "vitest"
import { nextDesignTab } from "./design-tabs"

/// `nextDesignTab` backs the right panel's auto-focus rule (Task 8): picking
/// an element on the canvas should jump the panel to Inspect, but nothing
/// else should ever fight the human for the tab they're looking at.
describe("nextDesignTab", () => {
  it("jumps to inspect when a selection newly appears", () => {
    expect(nextDesignTab(false, "pages", true)).toBe("inspect")
  })

  it("jumps to inspect from any other tab when a selection newly appears", () => {
    expect(nextDesignTab(false, "tokens", true)).toBe("inspect")
    expect(nextDesignTab(false, "components", true)).toBe("inspect")
  })

  it("keeps the current tab when the selection was already present", () => {
    expect(nextDesignTab(true, "inspect", true)).toBe("inspect")
    expect(nextDesignTab(true, "tokens", true)).toBe("tokens")
  })

  it("keeps the current tab when the selection is cleared", () => {
    expect(nextDesignTab(true, "inspect", false)).toBe("inspect")
  })

  it("keeps the current tab when nothing about the selection changed", () => {
    expect(nextDesignTab(false, "components", false)).toBe("components")
  })

  it("defaults to pages on the initial call with no tab chosen and no selection", () => {
    expect(nextDesignTab(false, "", false)).toBe("pages")
  })

  it("defaults to inspect on the initial call with no tab chosen but a selection already present", () => {
    expect(nextDesignTab(false, "", true)).toBe("inspect")
  })
})
