import { describe, expect, it } from "vitest"
import {
  DEVICE_PRESETS,
  artboardKey,
  deviceById,
  makeArtboard,
  rowLayout,
} from "./design-devices"

describe("design devices", () => {
  it("covers the spec's device table exactly", () => {
    const ids = DEVICE_PRESETS.map((d) => d.id)
    for (const id of [
      "iphone-se",
      "iphone-16-pro",
      "iphone-16-pro-max",
      "pixel-8",
      "galaxy-s24",
      "ipad-mini",
      "ipad-pro-11",
      "ipad-pro-13",
      "laptop",
      "laptop-l",
      "desktop",
      "bp-sm",
      "bp-md",
      "bp-lg",
      "bp-xl",
      "bp-2xl",
    ]) {
      expect(ids).toContain(id)
    }
  })

  it("matches real CSS dimensions for key presets", () => {
    expect(deviceById("iphone-16-pro")).toMatchObject({ width: 393, height: 852 })
    expect(deviceById("desktop")).toMatchObject({ width: 1920, height: 1080, dpr: 1 })
    expect(deviceById("bp-2xl")).toMatchObject({ width: 1536 })
  })

  it("falls back to laptop for unknown ids", () => {
    expect(deviceById("nope").id).toBe("laptop")
  })

  it("keys artboards by route@device", () => {
    expect(artboardKey("/settings", "iphone-se")).toBe("/settings@iphone-se")
  })

  it("rows never overlap: x advances past each board's own width", () => {
    const boards = rowLayout([deviceById("laptop"), deviceById("iphone-se")], 100, 50)
    expect(boards).toHaveLength(2)
    // Second board starts after first board's width + gutter.
    const [a, b] = boards
    expect(b.x).toBeGreaterThan(a.x + deviceById(a.deviceId).width - 1)
    expect(a.y).toBe(50)
  })

  it("makeArtboard keeps key in sync with route+device", () => {
    const board = makeArtboard("/billing", "pixel-8", 10, 20)
    expect(board.key).toBe("/billing@pixel-8")
    expect(board.deviceId).toBe("pixel-8")
  })
})
