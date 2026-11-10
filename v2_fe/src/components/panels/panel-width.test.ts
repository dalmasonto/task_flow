/// #1083: panels keep their range, scale with the window, never squeeze the canvas.
import { describe, expect, it } from "vitest"

import { CANVAS_MIN, DESIGN_CHAT_PANEL, DESIGN_SIDE_PANEL, clampPanelWidth, defaultWidth, fitPanels, keyboardStep } from "./panel-width"

describe("defaultWidth", () => {
  it("is never under 380, then a quarter of the window, inside the range", () => {
    expect(defaultWidth(DESIGN_CHAT_PANEL, 1440)).toBe(380)
    expect(defaultWidth(DESIGN_CHAT_PANEL, 1920)).toBe(480)
    expect(defaultWidth(DESIGN_CHAT_PANEL, 2560)).toBe(640)
    expect(defaultWidth(DESIGN_CHAT_PANEL, 6000)).toBe(DESIGN_CHAT_PANEL.max)
  })
  it("opens both sides at the same width", () => {
    expect(defaultWidth(DESIGN_SIDE_PANEL, 1920)).toBe(defaultWidth(DESIGN_CHAT_PANEL, 1920))
  })
})

describe("clampPanelWidth", () => {
  it("keeps a width inside the panel's range", () => {
    expect(clampPanelWidth(100, DESIGN_CHAT_PANEL, 3000, 400)).toBe(DESIGN_CHAT_PANEL.min)
    expect(clampPanelWidth(2000, DESIGN_CHAT_PANEL, 5000, 400)).toBe(DESIGN_CHAT_PANEL.max)
    expect(clampPanelWidth(500, DESIGN_CHAT_PANEL, 3000, 400)).toBe(500)
  })
  it("stops growing before the canvas drops under its minimum", () => {
    expect(clampPanelWidth(800, DESIGN_CHAT_PANEL, 1400, 400)).toBe(1400 - 400 - CANVAS_MIN)
  })
  it("never goes below the minimum, even on a cramped row", () => {
    expect(clampPanelWidth(500, DESIGN_CHAT_PANEL, 800, 400)).toBe(DESIGN_CHAT_PANEL.min)
  })
})

describe("fitPanels", () => {
  const a = { spec: DESIGN_CHAT_PANEL, open: true }
  const b = { spec: DESIGN_SIDE_PANEL, open: true }
  it("leaves both alone when they fit", () => {
    expect(fitPanels(2000, { ...a, width: 500 }, { ...b, width: 500 }, "a")).toEqual([500, 500])
  })
  it("shrinks the panel you didn't just drag first", () => {
    // 1400 row: 700 + 600 + 420 = 1720, 320 over. b gives 280 (to its 320 min), then a 40.
    expect(fitPanels(1400, { ...a, width: 700 }, { ...b, width: 600 }, "a")).toEqual([660, 320])
    expect(fitPanels(1400, { ...a, width: 700 }, { ...b, width: 600 }, "b")).toEqual([380, 600])
  })
  it("gives a closed panel no room", () => {
    expect(fitPanels(1400, { ...a, width: 700, open: false }, { ...b, width: 600 }, "a")).toEqual([0, 600])
  })
})

describe("keyboardStep", () => {
  it("is 16 px, or 64 px with Shift", () => {
    expect(keyboardStep(false, 1)).toBe(16)
    expect(keyboardStep(true, -1)).toBe(-64)
  })
})
