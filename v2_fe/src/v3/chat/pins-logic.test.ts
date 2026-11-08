import { describe, expect, it } from "vitest"

import { deliveryText, glyphOf, reactionIds, reactionLabel, REACTIONS, stepPin, toolsSummary } from "./pins-logic"

describe("pins and reactions (#5949)", () => {
  it("mirrors the server's eight reactions", () => {
    expect(REACTIONS.map((r) => r.id)).toEqual(["thumbs_up", "eyes", "check", "heart", "tada", "rocket", "thinking", "x"])
    expect(glyphOf("rocket")).toBe("🚀")
    expect(glyphOf("unknown")).toBe("unknown")
  })
  it("labels a reaction with who, capped at three names", () => {
    expect(reactionLabel({ emoji: "eyes", count: 4, mine: false, by: ["Ann", "Bo", "Cy", "Di"] })).toBe("Looking, 4: Ann, Bo, Cy and 1 more")
    expect(reactionLabel({ emoji: "check", count: 1, mine: true, by: ["You"] })).toBe("Done, 1: You")
    expect(reactionLabel({ emoji: "x", count: 2, mine: false, by: [] })).toBe("No, 2")
  })
  it("steps through pins, wrapping both ways", () => {
    expect(stepPin(0, -1, 3)).toBe(2)
    expect(stepPin(2, 1, 3)).toBe(0)
    expect(stepPin(5, 0, 3)).toBe(2)
    expect(stepPin(1, 1, 0)).toBe(0)
  })
  it("loads reactions for posted messages only, newest 100", () => {
    const msgs = [{ id: "pending:x", status: "sending" }, { id: "7", status: "posted" }, { id: "8", status: "failed" }, ...Array.from({ length: 120 }, (_, i) => ({ id: String(100 + i), status: "posted" }))]
    const ids = reactionIds(msgs)
    expect(ids).toHaveLength(100)
    expect(ids[0]).toBe(120)
    expect(ids).not.toContain(7)
  })
})

describe("tools per message (#5988 item 8)", () => {
  it("summarises like the design, nothing for none", () => {
    expect(toolsSummary({ count: 4, names: ["design_screenshot", "design_write_page"] })).toEqual({ title: "Ran 4 tools", names: "design_screenshot, design_write_page" })
    expect(toolsSummary({ count: 1, names: ["whoami"] })?.title).toBe("Ran 1 tool")
    expect(toolsSummary({ count: 0, names: [] })).toBeNull()
    expect(toolsSummary(undefined)).toBeNull()
  })
})

describe("delivery receipts (#5988 item 7)", () => {
  it("reads like the design, naming at most two", () => {
    expect(deliveryText([{ label: "Claude (main)", pane: "%4" }])).toBe("Delivered to Claude (main), pane %4")
    expect(deliveryText([{ label: "Claude (main)", pane: null }])).toBe("Delivered to Claude (main)")
    expect(deliveryText([{ label: "A", pane: "%4" }, { label: "B", pane: null }])).toBe("Delivered to A (pane %4) and B")
    expect(deliveryText([{ label: "A", pane: "%4" }, { label: "B", pane: null }, { label: "C", pane: "%9" }])).toBe("Delivered to A (pane %4), B and 1 more")
    expect(deliveryText([])).toBeNull()
    expect(deliveryText(undefined)).toBeNull()
  })
})
