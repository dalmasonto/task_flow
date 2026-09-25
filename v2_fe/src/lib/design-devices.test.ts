import { describe, expect, it } from "vitest"
import {
  DEVICE_PRESETS,
  GUTTER,
  HEADER_H,
  artboardKey,
  boardHeight,
  boardWidth,
  chromeStyleForGroup,
  deviceById,
  layoutBands,
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
    const laptop = deviceById("laptop")

    const row0 = boards.filter((b) => b.route === "/")
    const row1 = boards.filter((b) => b.route === "/about")
    expect(row0).toHaveLength(2)
    expect(row1).toHaveLength(2)

    for (const b of row0) expect(b.y).toBe(0)

    // Columns step by the board's REAL width — device px plus its bezel — not
    // by the bare iframe width. A phone is 26px wider than `width` claims.
    const row0Iphone = row0.find((b) => b.deviceId === "iphone-16-pro")!
    const row0Laptop = row0.find((b) => b.deviceId === "laptop")!
    expect(row0Iphone.x).toBe(0)
    expect(row0Laptop.x).toBe(boardWidth(iphone) + GUTTER)
    expect(boardWidth(iphone)).toBe(393 + 12 + 12 + 2)

    // The next row clears the tallest board AND its header, which renders
    // above the board and so is not covered by the board's own height.
    const rowHeight = Math.max(boardHeight(iphone), boardHeight(laptop))
    for (const b of row1) expect(b.y).toBe(HEADER_H + rowHeight + GUTTER)

    expect(row0Iphone.key).toBe("/@iphone-16-pro")
    expect(row0Laptop.key).toBe("/@laptop")
    expect(row1.find((b) => b.deviceId === "iphone-16-pro")!.key).toBe("/about@iphone-16-pro")
    expect(row1.find((b) => b.deviceId === "laptop")!.key).toBe("/about@laptop")
  })

  it("boardWidth/boardHeight count the bezel and the 1px border", () => {
    // Phone bezel is 12 left + 12 right; tablet is 14 all round.
    expect(boardWidth(deviceById("iphone-16-pro"))).toBe(393 + 24 + 2)
    expect(boardHeight(deviceById("iphone-16-pro"))).toBe(852 + 44 + 2)
    expect(boardWidth(deviceById("ipad-mini"))).toBe(744 + 28 + 2)
    // Laptops and breakpoints are flush on the sides.
    expect(boardWidth(deviceById("laptop"))).toBe(1280 + 0 + 2)
    expect(boardWidth(deviceById("bp-sm"))).toBe(640 + 0 + 2)
  })

  it("layoutBands: one band per device, its pages across, next device below", () => {
    const open = ["/", "/about"]
    const boards = layoutBands(open, ["laptop", "bp-sm"])
    expect(boards).toHaveLength(4)

    const laptop = deviceById("laptop")
    const bp = deviceById("bp-sm")
    const colStep = boardWidth(laptop) + GUTTER

    const band0 = boards.filter((b) => b.deviceId === "laptop")
    const band1 = boards.filter((b) => b.deviceId === "bp-sm")

    // Within a band, this device's pages run left→right along the band's top.
    expect(band0.every((b) => b.y === 0)).toBe(true)
    expect(band0.find((b) => b.route === "/")!.x).toBe(0)
    expect(band0.find((b) => b.route === "/about")!.x).toBe(colStep)

    // The next device starts its own band below, back at x = 0.
    const bandStep = HEADER_H + boardHeight(laptop) + GUTTER
    expect(band1.every((b) => b.y === bandStep)).toBe(true)
    expect(band1.find((b) => b.route === "/")!.x).toBe(0)

    // A band advances by ITS OWN device's height, not some other device's.
    expect(HEADER_H + boardHeight(bp) + GUTTER).not.toBe(bandStep)
  })

  it("layoutBands is the transpose of layoutRows", () => {
    const open = ["/", "/about"]
    const devices = ["laptop", "bp-sm"]
    const rows = layoutRows(open, devices)
    const bands = layoutBands(open, devices)
    // Same boards, same keys — only the arrangement differs.
    expect(new Set(bands.map((b) => b.key))).toEqual(new Set(rows.map((b) => b.key)))
    expect(bands).not.toEqual(rows)
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
