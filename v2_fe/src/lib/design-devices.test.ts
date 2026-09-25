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
  layoutGroups,
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
    // Three devices of three different heights — the shape
    // `RESPONSIVE_REVIEW_DEVICES` produces. With only two bands, a middle band
    // stepping by the FIRST band's height is indistinguishable from stepping by
    // its own, so the third band is what makes the stacking assertable.
    const boards = layoutBands(open, ["laptop", "bp-sm", "ipad-mini"])
    expect(boards).toHaveLength(6)

    const laptop = deviceById("laptop")
    const bp = deviceById("bp-sm")
    const ipad = deviceById("ipad-mini")
    const colStep = boardWidth(laptop) + GUTTER

    const band0 = boards.filter((b) => b.deviceId === "laptop")
    const band1 = boards.filter((b) => b.deviceId === "bp-sm")
    const band2 = boards.filter((b) => b.deviceId === "ipad-mini")
    // One board per open page in each band — no duplicates, none dropped.
    expect(band0).toHaveLength(open.length)
    expect(band1).toHaveLength(open.length)
    expect(band2).toHaveLength(open.length)

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
    // ...and columns step by their OWN device's width, not the first band's.
    expect(band1.find((b) => b.route === "/about")!.x).toBe(boardWidth(bp) + GUTTER)

    // Band 2 stacks on BAND 1's step, not on band 0's step repeated. The three
    // steps are pairwise distinct (ipad-mini is taller than bp-sm, which is
    // taller than laptop), so this cannot pass by reusing an earlier band's.
    const band1Step = HEADER_H + boardHeight(bp) + GUTTER
    const band2Step = HEADER_H + boardHeight(ipad) + GUTTER
    expect(new Set([bandStep, band1Step, band2Step]).size).toBe(3)
    expect(band2.every((b) => b.y === bandStep + band1Step)).toBe(true)
    expect(band2.find((b) => b.route === "/")!.x).toBe(0)
  })

  it("layoutBands is the transpose of layoutRows", () => {
    const open = ["/", "/about"]
    const devices = ["laptop", "bp-sm"]
    const rows = layoutRows(open, devices)
    const bands = layoutBands(open, devices)
    // Same boards, same keys — only the arrangement differs.
    expect(new Set(bands.map((b) => b.key))).toEqual(new Set(rows.map((b) => b.key)))
    expect(bands).not.toEqual(rows)

    // ...and they differ GEOMETRICALLY, not merely in iteration order: the same
    // board sits at a different point in each arrangement. One board is enough
    // to prove the axes swapped — `/@bp-sm` leads its band but trails its row.
    const inBands = bands.find((b) => b.key === "/@bp-sm")!
    const inRows = rows.find((b) => b.key === "/@bp-sm")!
    expect({ x: inBands.x, y: inBands.y }).toEqual({
      x: 0,
      y: HEADER_H + boardHeight(deviceById("laptop")) + GUTTER,
    })
    expect({ x: inRows.x, y: inRows.y }).toEqual({
      x: boardWidth(deviceById("laptop")) + GUTTER,
      y: 0,
    })
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

  it("layoutGroups: groups are vertical columns, ungrouped flows right in one row", () => {
    const groups = [
      { id: "g1", name: "Auth", routes: ["/login", "/signup"] },
      { id: "g2", name: "Ops", routes: ["/ops"] },
    ]
    const open = ["/", "/login", "/signup", "/ops", "/about"]
    const boards = layoutGroups(open, ["laptop"], groups)
    expect(boards).toHaveLength(5)

    const at = (route: string) => boards.find((b) => b.route === route)!
    const laptop = deviceById("laptop")
    const colStep = boardWidth(laptop) + GUTTER
    const rowStep = HEADER_H + boardHeight(laptop) + GUTTER

    // Group 1 is the first column: its pages stack downward.
    expect(at("/login").x).toBe(0)
    expect(at("/login").y).toBe(0)
    expect(at("/signup").x).toBe(0)
    expect(at("/signup").y).toBe(rowStep)

    // Group 2 is the next column, starting back at the band top.
    expect(at("/ops").x).toBe(colStep)
    expect(at("/ops").y).toBe(0)

    // Ungrouped pages flow right of every group column, all on the band's top row.
    expect(at("/").x).toBe(colStep * 2)
    expect(at("/").y).toBe(0)
    expect(at("/about").x).toBe(colStep * 3)
    expect(at("/about").y).toBe(0)
  })

  it("layoutGroups: only OPEN pages appear, and an empty group takes no space", () => {
    const groups = [
      { id: "g1", name: "Auth", routes: ["/login", "/signup"] },
      { id: "g2", name: "Empty", routes: ["/gone"] },
    ]
    const boards = layoutGroups(["/", "/signup"], ["laptop"], groups)
    expect(boards.map((b) => b.route).sort()).toEqual(["/", "/signup"])

    const colStep = boardWidth(deviceById("laptop")) + GUTTER
    // The emptied group takes no space, so the ungrouped row sits one column
    // in — not two — even though it is the third group in document order.
    expect(boards.find((b) => b.route === "/")!.x).toBe(colStep)
    expect(boards.find((b) => b.route === "/signup")!.x).toBe(0)
  })

  it("layoutGroups: bands per device, each device starting its own band", () => {
    const groups = [{ id: "g1", name: "Auth", routes: ["/login"] }]
    const boards = layoutGroups(["/", "/login"], ["laptop", "bp-sm"], groups)
    const laptop = deviceById("laptop")
    const bandStep = HEADER_H + boardHeight(laptop) + GUTTER
    const bpRow = boards.filter((b) => b.deviceId === "bp-sm")
    for (const b of bpRow) expect(b.y).toBe(bandStep)
  })

  it("layoutGroups is deterministic", () => {
    const groups = [{ id: "g1", name: "Auth", routes: ["/login"] }]
    expect(layoutGroups(["/", "/login"], ["laptop"], groups)).toEqual(
      layoutGroups(["/", "/login"], ["laptop"], groups),
    )
  })
})
