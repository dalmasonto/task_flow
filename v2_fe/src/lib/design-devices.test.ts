import { describe, expect, it } from "vitest"
import {
  DEVICE_PRESETS,
  GUTTER,
  HEADER_H,
  artboardKey,
  boardHeight,
  boardWidth,
  boardsForView,
  chromeStyleForGroup,
  deviceById,
  landscapeId,
  landscapeVariant,
  layoutBands,
  layoutGroups,
  layoutRows,
  makeArtboard,
} from "./design-devices"
import { DEFAULT_LAYOUT, assignRoute, createGroup, moveRoute, type LayoutDoc } from "./design-layout"

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

    // The SECOND device's band is also laid out horizontally with ITS OWN
    // metrics, not the first device's. I picked `/` because it is the band's
    // second column — `/login` leads at x = 0 by definition and so proves
    // nothing about the step — and bp-sm is 642px against laptop's 1282, so
    // deriving `columnStep` from `deviceIds[0]` fails on this exact assertion.
    const bpSecond = bpRow.find((b) => b.route === "/")!
    expect(bpRow.find((b) => b.route === "/login")!.x).toBe(0)
    expect(bpSecond.x).toBe(boardWidth(deviceById("bp-sm")) + GUTTER)
    expect(boardWidth(deviceById("laptop")) + GUTTER).not.toBe(
      boardWidth(deviceById("bp-sm")) + GUTTER,
    )
  })

  it("layoutGroups: bands step by the PRECEDING device — a three-device chain", () => {
    const groups = [{ id: "g1", name: "Auth", routes: ["/login"] }]
    // Three devices, deliberately not in the natural order. Three, not two,
    // because with two the second band's PRECEDING device IS the first device,
    // so "advance by the first band's step" cannot be told apart from "advance
    // by the preceding band's step" in any two-device fixture. The middle band
    // is what makes the difference observable, and its device is the one the
    // real "Responsive review" tuple uses.
    const devices = ["bp-sm", "ipad-mini", "laptop"]
    const boards = layoutGroups(["/", "/login"], devices, groups)

    const band = (id: string) => boards.filter((b) => b.deviceId === id)
    const [bpRow, ipadRow, laptopRow] = devices.map((id) => band(id))
    // Every band is non-empty, so the per-band assertions below cannot pass
    // vacuously on an empty array.
    for (const row of [bpRow, ipadRow, laptopRow]) expect(row).toHaveLength(2)

    const step = (id: string) => HEADER_H + boardHeight(deviceById(id)) + GUTTER
    const steps = devices.map(step)
    // The three steps are pairwise distinct, so no band can land on the right
    // offset by reusing another's. If the preset table ever changes so two of
    // them coincide, the assertions below stop discriminating — fail loudly
    // here instead.
    expect(new Set(steps).size).toBe(3)

    // The leading band is at the top; each later band stacks on the steps ABOVE
    // it: 0, step0, step0 + step1. Band 2 is the discriminator — asserting the
    // running sum separately from band 1 is what fails an implementation that
    // reuses the first band's step for every band after the first.
    for (const b of bpRow) expect(b.y).toBe(0)
    for (const b of ipadRow) expect(b.y).toBe(steps[0])
    for (const b of laptopRow) expect(b.y).toBe(steps[0] + steps[1])

    // Named explicitly, so the failure mode stays pinned even if a future
    // preset change made step1 vanish: the third band must NOT sit one step in.
    expect(laptopRow[0].y).not.toBe(steps[0])
    // ...and it is not stepped by its OWN device either — laptop is the
    // shortest of the three, so its own step is the smallest number here.
    expect(steps[2]).toBeLessThan(steps[1])
    expect(steps[2]).not.toBe(steps[0] + steps[1])
  })

  it("layoutGroups: a band clears its DEEPEST column, headers and all", () => {
    const groups = [{ id: "g1", name: "Auth", routes: ["/login", "/signup"] }]
    const devices = ["laptop", "bp-sm"]
    const boards = layoutGroups(["/", "/login", "/signup"], devices, groups)

    const band = (id: string) => boards.filter((b) => b.deviceId === id)
    const [laptopRow, bpRow] = devices.map((id) => band(id))
    // Non-empty, so the per-band checks below cannot pass vacuously.
    for (const row of [laptopRow, bpRow]) expect(row).toHaveLength(3)

    // The leading band's Auth column really is two boards deep. Every column in
    // the older fixtures held exactly one board, so a band advance that ignored
    // column depth agreed with the right one — this assert is what makes the
    // difference observable, and the depth is asserted rather than assumed.
    const laptop = deviceById("laptop")
    const laptopRowStep = HEADER_H + boardHeight(laptop) + GUTTER
    const login = laptopRow.find((b) => b.route === "/login")!
    const signup = laptopRow.find((b) => b.route === "/signup")!
    expect(login.y).toBe(0)
    expect(signup.y).toBe(laptopRowStep)

    // The next band starts one gutter below the deepest column's last board:
    // that board's bottom (994 + header + height = 1848) plus GUTTER = 1988.
    // Not 1848 — that left the bands touching, with no gutter at all, and not
    // the bare device step 994. Both wrong values are named below so the
    // failure mode stays pinned.
    const deepestBottom = signup.y + HEADER_H + boardHeight(laptop)
    const nextBand = deepestBottom + GUTTER
    const bpRowStep = HEADER_H + boardHeight(deviceById("bp-sm")) + GUTTER
    // The whole of the next band is offset by it: its two FIRST-ROW boards —
    // `/login` (its own Auth column) and `/` (the ungrouped tail) — both sit on
    // the band top, so neither can be mistaken for the stacked one.
    expect(bpRow.find((b) => b.route === "/login")!.y).toBe(nextBand)
    expect(bpRow.find((b) => b.route === "/")!.y).toBe(nextBand)
    // ...and its stacked board is a row down from there, by ITS OWN device's
    // step — not the leading band's.
    expect(bpRow.find((b) => b.route === "/signup")!.y).toBe(nextBand + bpRowStep)
    // The candidates this must NOT have landed on: the bare device step, and
    // the zero-gutter number the shipped formula produced (deepestBottom).
    expect(HEADER_H + boardHeight(laptop) + GUTTER).not.toBe(nextBand)
    expect(deepestBottom).not.toBe(nextBand)
  })

  it("layoutGroups: a THREE-board column's band is cleared, not overlapped", () => {
    // The depth where the shipped `n * (HEADER_H + h)` band height went wrong:
    // a two-board column only lost its gutter, a three-board one overlaps by a
    // full gutter. Two boards cannot tell those apart, so this case is the one
    // that pins the defect itself.
    const groups = [{ id: "g1", name: "Auth", routes: ["/a", "/b", "/c"] }]
    const boards = layoutGroups(["/a", "/b", "/c"], ["laptop", "bp-sm"], groups)
    const laptop = deviceById("laptop")
    const laptopRowStep = HEADER_H + boardHeight(laptop) + GUTTER
    const laptopRow = boards.filter((b) => b.deviceId === "laptop")
    const bpRow = boards.filter((b) => b.deviceId === "bp-sm")
    expect(laptopRow).toHaveLength(3)
    expect(bpRow).toHaveLength(3)

    // Three boards, so the last one sits two full steps down the column.
    const last = laptopRow.find((b) => b.route === "/c")!
    expect(laptopRow.find((b) => b.route === "/a")!.y).toBe(0)
    expect(laptopRow.find((b) => b.route === "/b")!.y).toBe(laptopRowStep)
    expect(last.y).toBe(2 * laptopRowStep)

    // Its bottom, then one gutter — and the next band must clear it. The
    // shipped formula put this band at 2702, inside the board that ends at 2842.
    const lastBottom = last.y + HEADER_H + boardHeight(laptop)
    const bpRowStep = HEADER_H + boardHeight(deviceById("bp-sm")) + GUTTER
    expect(bpRow.find((b) => b.route === "/a")!.y).toBe(lastBottom + GUTTER)
    expect(bpRow.find((b) => b.route === "/c")!.y).toBe(lastBottom + GUTTER + 2 * bpRowStep)
    expect(bpRow[0].y).toBeGreaterThanOrEqual(lastBottom)
    expect(3 * (HEADER_H + boardHeight(laptop)) + GUTTER).not.toBe(lastBottom + GUTTER)
  })

  it("layoutGroups is deterministic", () => {
    const groups = [{ id: "g1", name: "Auth", routes: ["/login"] }]
    expect(layoutGroups(["/", "/login"], ["laptop"], groups)).toEqual(
      layoutGroups(["/", "/login"], ["laptop"], groups),
    )
  })

  it("boardsForView dispatches on the document's view", () => {
    const open = ["/", "/login"]
    const devices = ["laptop"]
    // `pageLabels` rides on every document the server serves, so a fixture for
    // `LayoutDoc` carries it too — `boardsForView` ignores it either way.
    const rows = { view: "rows" as const, routeOrder: open, groups: [], pageLabels: {} }
    const bands = { view: "bands" as const, routeOrder: open, groups: [], pageLabels: {} }
    const groups = {
      view: "groups" as const,
      routeOrder: open,
      groups: [{ id: "g1", name: "Auth", routes: ["/login"] }],
      pageLabels: {},
    }

    expect(boardsForView(rows, open, devices)).toEqual(layoutRows(open, devices))
    expect(boardsForView(bands, open, devices)).toEqual(layoutBands(open, devices))
    expect(boardsForView(groups, open, devices)).toEqual(
      layoutGroups(open, devices, groups.groups),
    )
  })

  it("boardsForView treats an unknown view as rows rather than crashing", () => {
    // A document from a newer build must still render something.
    const open = ["/"]
    const weird = { view: "diagonal" as never, routeOrder: open, groups: [], pageLabels: {} }
    expect(boardsForView(weird, open, ["laptop"])).toEqual(layoutRows(open, ["laptop"]))
  })

  // The FLOW, at the canvas: `routeOrder` is the order the pages are presented
  // in, and the boards are the presentation. In `rows` and `bands` the sequence
  // is the only ordering those views have, so the boards follow it directly —
  // and the pages the flow does not name keep their own order after the ones it
  // does, which is what makes a half-written flow (a page added since, a page
  // deleted since) still a total sequence rather than a list with holes.
  it("draws the boards in the flow, in rows and in bands", () => {
    const open = ["/", "/login", "/signup"]
    const doc = { ...DEFAULT_LAYOUT, routeOrder: ["/signup", "/login"] }

    for (const view of ["rows", "bands"] as const) {
      expect(
        boardsForView({ ...doc, view }, open, ["laptop"]).map((b) => b.route),
        view,
      ).toEqual(["/signup", "/login", "/"])
    }
    // And the same document with no flow at all is the pages' own order — the
    // fallback, not an empty canvas.
    expect(boardsForView(DEFAULT_LAYOUT, open, ["laptop"]).map((b) => b.route)).toEqual(open)
  })

  // A flow naming pages that are not open — the ordinary case of a half-open
  // canvas: the open routes still all appear, in their own order, because the
  // flow is resolved over the OPEN pages rather than filtered down to the ones
  // it happens to name.
  it("keeps every open page when the flow names none of them", () => {
    const doc = { ...DEFAULT_LAYOUT, routeOrder: ["/settings", "/about"] }

    expect(boardsForView(doc, ["/", "/login"], ["laptop"]).map((b) => b.route)).toEqual(["/", "/login"])
  })

  // The ruling, and the one place the two orderings meet: in `groups` the
  // COLUMNS are the arrangement the user chose — the flow must not sort them —
  // but the pages WITHIN each column are drawn in the flow, so the sequence the
  // user built is visible in this view too rather than only in the other two.
  it("keeps the group columns as the arrangement and orders the pages inside them by the flow", () => {
    const open = ["/login", "/settings"]
    const groups = [
      { id: "g1", name: "Auth", routes: ["/login"] },
      { id: "g2", name: "Admin", routes: ["/settings"] },
    ]
    // The flow leads with the SECOND group's page: the columns must stay put
    // anyway, which is what the two x positions below are.
    const doc = { ...DEFAULT_LAYOUT, view: "groups" as const, groups, routeOrder: ["/settings", "/login"] }
    const boards = boardsForView(doc, open, ["laptop"])
    const xOf = (route: string) => boards.find((b) => b.route === route)!.x

    expect(xOf("/login")).toBe(0)
    expect(xOf("/settings")).toBe(boardWidth(deviceById("laptop")) + GUTTER)

    // Within one column: three pages, one column, in the flow's order. The flow
    // here leads with the page that sits LAST in the group's own `routes` array
    // and in the pages' order, so a column that ignored it — or that fell back
    // to `g.routes`, which is assignment order — cannot produce this sequence.
    const oneColumn = {
      ...doc,
      routeOrder: ["/signup", "/"],
      groups: [{ id: "g1", name: "Auth", routes: ["/", "/login", "/signup"] }],
    }
    const column = boardsForView(oneColumn, ["/", "/login", "/signup"], ["laptop"])
    const step = HEADER_H + boardHeight(deviceById("laptop")) + GUTTER
    expect(column.map((b) => b.route)).toEqual(["/signup", "/", "/login"])
    expect(column.map((b) => b.y)).toEqual([0, step, 2 * step])
    expect(column.every((b) => b.x === 0)).toBe(true)
  })

  // The DEFAULT of that same rule, and the deliberate one: with no flow set the
  // sequence IS the pages' own order, so a column reads in the pages' own order
  // — not in `g.routes`, which is ASSIGNMENT order because `assignRoute`
  // appends. A column that rendered `g.routes` would reshuffle its existing
  // pages the moment one more page was grouped into it, and would disagree with
  // the panel listing the same pages beside it. This is what every project sees
  // before anything has been moved, in the one view whose arrangement the user
  // chose, so it is pinned here rather than left to the sort above.
  it("draws a group column in the pages' own order when no flow has been set", () => {
    const open = ["/", "/login", "/settings"]
    const groups = [{ id: "g1", name: "Auth", routes: ["/settings", "/login"] }]
    const doc: LayoutDoc = { ...DEFAULT_LAYOUT, view: "groups", groups }
    const boards = boardsForView(doc, open, ["laptop"])
    /// The group's own two boards, in the order the canvas draws them.
    const column = boards.filter((b) => b.route !== "/")

    expect(doc.routeOrder).toEqual([]) // the premise: no flow has been set
    expect(column.map((b) => b.route)).toEqual(["/login", "/settings"])
    // One column, not two: the arrangement is untouched by what orders it.
    expect(column[0].x).toBe(column[1].x)
    expect(column[1].y).toBeGreaterThan(column[0].y)
  })

  // §F, next to the two edits that look alike and are not: a grouping edit is a
  // LISTING edit — it never touches `routeOrder` — so it must not move a board,
  // while an explicit move is the whole point of the flow and does. The canvas
  // is never sorted into the panel's listing order; it is sorted into the flow,
  // and the flow is only ever changed by moving a page.
  it("does not reflow the boards for a grouping edit, and does for an explicit move", () => {
    const open = ["/", "/login", "/signup"]
    const doc = { ...DEFAULT_LAYOUT, routeOrder: ["/signup", "/login"] }
    const { doc: withGroup, id } = createGroup(doc, "Auth")
    const assigned = assignRoute(withGroup, "/login", id)
    const sequence = (view: "rows" | "bands", d: LayoutDoc) =>
      boardsForView({ ...d, view }, open, ["laptop"]).map((b) => b.route)

    // Rows and bands draw the flow and nothing else, so grouping `/login` — the
    // one page the two documents differ by — leaves both sequences as they were.
    // (In `groups` this same edit moves the page into its column, which is what
    // that view IS; it still does not reorder the columns.)
    expect(sequence("rows", assigned)).toEqual(sequence("rows", doc))
    expect(sequence("bands", assigned)).toEqual(sequence("bands", doc))

    // A move is the one edit that reflows them.
    expect(sequence("rows", moveRoute(doc, "/", -1, open))).not.toEqual(sequence("rows", doc))
  })
})

describe("landscape variants", () => {
  it("swaps the dimensions and keeps the group", () => {
    const v = landscapeVariant(deviceById("iphone-16-pro"))!
    expect(v.width).toBe(852)
    expect(v.height).toBe(393)
    expect(v.group).toBe("phone")
    expect(v.id).toBe("iphone-16-pro:landscape")
  })

  it("exists only for phones and tablets", () => {
    expect(landscapeVariant(deviceById("iphone-se"))).not.toBeNull()
    expect(landscapeVariant(deviceById("ipad-mini"))).not.toBeNull()
    // A laptop is not a portrait device and a breakpoint is a width, not a
    // device — rotating either produces a size that means nothing.
    expect(landscapeVariant(deviceById("laptop"))).toBeNull()
    expect(landscapeVariant(deviceById("bp-sm"))).toBeNull()
  })

  it("every variant is a real preset, so the device filter accepts it", () => {
    // `design-ui-state`'s parse filters stored ids against DEVICE_PRESETS; a
    // landscape id that is not in the table would be silently dropped on reload.
    for (const d of DEVICE_PRESETS) {
      if (d.id.endsWith(":landscape")) {
        expect(d.width).toBe(deviceById(d.id.replace(":landscape", "")).height)
      }
    }
    expect(DEVICE_PRESETS.some((d) => d.id === "iphone-16-pro:landscape")).toBe(true)
  })

  it("deviceById resolves a variant, and board metrics follow it", () => {
    const v = deviceById("iphone-16-pro:landscape")
    expect(v.width).toBe(852)
    // Portrait: 393 + 12 + 12 + 2. Landscape swaps the WIDTH, so the sides are
    // the same padding but the number is now the preset's height.
    expect(boardWidth(v)).toBe(852 + 12 + 12 + 2)
  })

  it("landscapeId is stable and reversible", () => {
    expect(landscapeId("ipad-mini")).toBe("ipad-mini:landscape")
    expect(deviceById(landscapeId("ipad-mini")).id).toBe("ipad-mini:landscape")
  })

  it("a variant has no landscape of its own — the helper cannot lie", () => {
    // Swapping a variant would produce `${id}:landscape:landscape`, an id NO
    // preset declares. That is worse than a missing device: `deviceById`
    // resolves it to the laptop fallback, so the board would render a laptop at
    // a key a real laptop board already holds, and `design-ui-state` would drop
    // the id on reload. The helper is total instead, so no caller can be handed
    // an undeclared id.
    expect(landscapeVariant(deviceById("iphone-16-pro:landscape"))).toBeNull()
    expect(landscapeVariant(deviceById("ipad-mini:landscape"))).toBeNull()
    // The guard keys off the id `landscapeId` builds, so it cannot drift from
    // the ids the expansion declares: every variant in the table is rejected.
    for (const d of DEVICE_PRESETS) {
      if (d.id.endsWith(":landscape")) {
        expect(landscapeVariant(d)).toBeNull()
      }
    }
    // ...and the portrait device those came from still rotates — the guard
    // rejects the variant, not the phone.
    expect(landscapeVariant(deviceById("iphone-16-pro"))).not.toBeNull()
  })
})
