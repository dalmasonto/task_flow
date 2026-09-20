import { describe, expect, it } from "vitest"
import {
  DEVICE_PRESETS,
  artboardKey,
  chromeStyleForGroup,
  deviceById,
  layoutRows,
  makeArtboard,
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

  it("layoutRows: one row per route, one column per device, no overlaps", () => {
    const boards = layoutRows(["/", "/about"], ["iphone-16-pro", "laptop"])
    expect(boards).toHaveLength(4)

    const iphone = deviceById("iphone-16-pro")
    const gutter = 80

    const row0 = boards.filter((b) => b.route === "/")
    const row1 = boards.filter((b) => b.route === "/about")
    expect(row0).toHaveLength(2)
    expect(row1).toHaveLength(2)

    // Row 0 (first route): every board's y is 0.
    for (const b of row0) expect(b.y).toBe(0)

    // Columns: the laptop column sits to the right of the iphone column by
    // the iphone's width plus the gutter.
    const row0Iphone = row0.find((b) => b.deviceId === "iphone-16-pro")!
    const row0Laptop = row0.find((b) => b.deviceId === "laptop")!
    expect(row0Iphone.x).toBe(0)
    expect(row0Laptop.x).toBe(iphone.width + gutter)

    // Row 1 (second route): y is row-0's height (max device height in the
    // row) plus the gutter.
    const rowHeight = Math.max(iphone.height, deviceById("laptop").height)
    for (const b of row1) expect(b.y).toBe(rowHeight + gutter)

    // Keys are route@device.
    expect(row0Iphone.key).toBe("/@iphone-16-pro")
    expect(row0Laptop.key).toBe("/@laptop")
    expect(row1.find((b) => b.deviceId === "iphone-16-pro")!.key).toBe("/about@iphone-16-pro")
    expect(row1.find((b) => b.deviceId === "laptop")!.key).toBe("/about@laptop")
  })

  it("layoutRows is deterministic and order-stable", () => {
    const a = layoutRows(["/", "/about"], ["iphone-16-pro", "laptop"])
    const b = layoutRows(["/", "/about"], ["iphone-16-pro", "laptop"])
    expect(a).toEqual(b)
  })

  it("layoutRows returns nothing for no open routes or no devices", () => {
    expect(layoutRows([], ["laptop"])).toEqual([])
    expect(layoutRows(["/"], [])).toEqual([])
  })

  it("makeArtboard keeps key in sync with route+device", () => {
    const board = makeArtboard("/billing", "pixel-8", 10, 20)
    expect(board.key).toBe("/billing@pixel-8")
    expect(board.deviceId).toBe("pixel-8")
  })

  describe("chromeStyleForGroup", () => {
    it("phones get a notch + home indicator + safe-area insets", () => {
      const chrome = chromeStyleForGroup("phone")
      expect(chrome.notch).toBe(true)
      expect(chrome.homeIndicator).toBe(true)
      expect(chrome.cameraDot).toBe(false)
      expect(chrome.topBar).toBe(false)
      expect(chrome.safeArea).toEqual({ top: 24, bottom: 20 })
      expect(chrome.outerRadius).toBeGreaterThan(0)
    })

    it("tablets get a thinner uniform bezel with a camera dot, no notch", () => {
      const tablet = chromeStyleForGroup("tablet")
      const phone = chromeStyleForGroup("phone")
      expect(tablet.notch).toBe(false)
      expect(tablet.homeIndicator).toBe(false)
      expect(tablet.cameraDot).toBe(true)
      expect(tablet.topBar).toBe(false)
      expect(tablet.safeArea).toBeNull()
      // Uniform on all four sides.
      expect(tablet.padding.top).toBe(tablet.padding.right)
      expect(tablet.padding.right).toBe(tablet.padding.bottom)
      expect(tablet.padding.bottom).toBe(tablet.padding.left)
      // Thinner than the phone's bezel, and less round.
      expect(tablet.padding.top).toBeLessThan(phone.padding.top)
      expect(tablet.outerRadius).toBeLessThan(phone.outerRadius)
      expect(tablet.outerRadius).toBeGreaterThan(0)
    })

    it("laptops get a light top bar only, flush sides/bottom", () => {
      const chrome = chromeStyleForGroup("laptop")
      expect(chrome.topBar).toBe(true)
      expect(chrome.notch).toBe(false)
      expect(chrome.homeIndicator).toBe(false)
      expect(chrome.cameraDot).toBe(false)
      expect(chrome.safeArea).toBeNull()
      expect(chrome.padding.top).toBeGreaterThan(0)
      expect(chrome.padding.right).toBe(0)
      expect(chrome.padding.bottom).toBe(0)
      expect(chrome.padding.left).toBe(0)
    })

    it("breakpoints stay a plain rectangle — no bezel at all", () => {
      const chrome = chromeStyleForGroup("breakpoint")
      expect(chrome).toEqual({
        outerRadius: 0,
        innerRadius: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        notch: false,
        homeIndicator: false,
        cameraDot: false,
        topBar: false,
        safeArea: null,
      })
    })
  })
})
