import { describe, expect, it } from "vitest"

import type { RouteEntry } from "@/lib/design-api"
import { normalizeLayout } from "@/lib/design-layout"
import { deviceById } from "@/lib/design-devices"
import {
  captureViewport,
  exportDress,
  A4,
  PAGE_MARGIN,
  bestPageSetup,
  exportFileName,
  exportItems,
  frameFor,
  screenFileName,
  screensPerPage,
  slotOrigin,
} from "./export-plan"

const ROUTES: RouteEntry[] = [
  { path: "/", file: "pages/index.html", title: "Home" },
  { path: "/login", file: "pages/login.html", title: "Login" },
  { path: "/pricing", file: "pages/pricing.html", title: "Pricing" },
  { path: "/signup", file: "pages/signup.html", title: "Sign up" },
]
const layout = normalizeLayout({
  view: "groups",
  routeOrder: [],
  groups: [{ id: "g1", name: "Auth", routes: ["/signup", "/login"] }],
  pageLabels: { "/": "Landing" },
})
const labelFor = (route: string) => (route === "/" ? "Landing" : ROUTES.find((r) => r.path === route)!.title)

describe("exportItems (#507)", () => {
  it("prints groups first, then ungrouped pages, numbered in that order", () => {
    const items = exportItems(layout, ROUTES, { kind: "all" }, [], labelFor)
    expect(items.map((i) => [i.n, i.route, i.group])).toEqual([
      [1, "/login", "Auth"],
      [2, "/signup", "Auth"],
      [3, "/", null],
      [4, "/pricing", null],
    ])
    expect(items[2].label).toBe("Landing")
  })

  it("selects by group, by the open boards, and by hand — renumbering from 1", () => {
    expect(exportItems(layout, ROUTES, { kind: "groups", groupIds: ["g1"] }, [], labelFor).map((i) => i.route)).toEqual([
      "/login",
      "/signup",
    ])
    const open = exportItems(layout, ROUTES, { kind: "open" }, ["/pricing", "/"], labelFor)
    expect(open.map((i) => [i.n, i.route])).toEqual([
      [1, "/"],
      [2, "/pricing"],
    ])
    expect(exportItems(layout, ROUTES, { kind: "pick", routes: ["/signup"] }, [], labelFor).map((i) => i.route)).toEqual([
      "/signup",
    ])
  })
})

describe("page layout (#507)", () => {
  it("puts four phones on a page and two of anything larger", () => {
    expect(screensPerPage(deviceById("iphone-16-pro"))).toBe(4)
    expect(screensPerPage(deviceById("ipad-mini"))).toBe(2)
    expect(screensPerPage(deviceById("laptop"))).toBe(2)
  })

  it("lays four phones across a landscape page", () => {
    const phone = deviceById("iphone-16-pro")
    const setup = bestPageSetup(phone.width / phone.height, 4)
    expect(setup.orientation).toBe("landscape")
    expect([setup.cols, setup.rows]).toEqual([4, 1])
  })

  it("stacks two laptop screens top and bottom on a portrait page", () => {
    const laptop = deviceById("laptop")
    const setup = bestPageSetup(laptop.width / laptop.height, 2)
    expect(setup.orientation).toBe("portrait")
    expect([setup.cols, setup.rows]).toEqual([1, 2])
  })

  it("never lets an image overflow its slot or the printable area", () => {
    for (const id of ["iphone-se", "galaxy-s24", "ipad-pro-13", "desktop", "bp-sm"]) {
      const d = deviceById(id)
      const setup = bestPageSetup(d.width / d.height, screensPerPage(d))
      expect(setup.imageW).toBeLessThanOrEqual(setup.slotW + 1e-9)
      const last = slotOrigin(setup, screensPerPage(d) - 1)
      expect(last.x + setup.slotW).toBeLessThanOrEqual(setup.pageW - PAGE_MARGIN.side + 1e-9)
      expect(last.y + setup.slotH).toBeLessThanOrEqual(setup.pageH - PAGE_MARGIN.bottom + 1e-9)
      expect(Math.max(setup.pageW, setup.pageH)).toBe(A4.h)
    }
  })
})

describe("frames and names (#507)", () => {
  it("gives real devices an open-source frame and a breakpoint none", () => {
    expect(frameFor("iphone-16-pro")).toBe("iphone-14-pro")
    expect(frameFor("laptop")).toBe("macbook-pro")
    expect(frameFor("bp-md")).toBeNull()
  })

  it("names files so they sort in export order", () => {
    expect(exportFileName("TaskFlow v2", "iphone-16-pro", "pdf")).toBe("taskflow-v2-iphone-15-16-screens.pdf")
    expect(screenFileName({ route: "/", label: "Sign up!", group: null, n: 3 }, 12)).toBe("03-sign-up.png")
  })
})

describe("captureViewport", () => {
  it("is the device's own viewport for a bare or classic screenshot", () => {
    const pixel = deviceById("pixel-8")
    expect(captureViewport(pixel, { kind: "none" })).toEqual({ width: 412, height: 915 })
    expect(captureViewport(pixel, exportDress("pixel-8", "classic"))).toEqual({ width: 412, height: 915 })
  })
  it("is the frame's screen below its status bar, at the device's width, for a device frame", () => {
    // google-pixel-6-pro: screen 376×816 with a 26px status bar, so at the
    // Pixel 8's 412px width the page gets (816 − 26) × 412 / 376 = 866px —
    // exactly what the canvas gives a framed board, and exactly the screen
    // the picture is then laid into, so nothing is cropped.
    expect(captureViewport(deviceById("pixel-8"), exportDress("pixel-8", "device"))).toEqual({ width: 412, height: 866 })
    // iphone-14-pro: 390×830 with a 44px status bar, at 393px: (830 − 44) × 393 / 390 = 792.
    expect(captureViewport(deviceById("iphone-16-pro"), exportDress("iphone-16-pro", "device"))).toEqual({ width: 393, height: 792 })
  })
  it("ignores a frame it has no metrics for", () => {
    expect(captureViewport(deviceById("pixel-8"), { kind: "device", frame: "no-such-frame" })).toEqual({ width: 412, height: 915 })
  })
})

describe("exportDress", () => {
  it("dresses a phone in its device frame, the classic bezel, or nothing", () => {
    expect(exportDress("iphone-16-pro", "device")).toEqual({ kind: "device", frame: "iphone-14-pro" })
    const classic = exportDress("iphone-16-pro", "classic")
    expect(classic.kind).toBe("classic")
    if (classic.kind === "classic") expect(classic.chrome.notch).toBe(true)
    expect(exportDress("iphone-16-pro", "none")).toEqual({ kind: "none" })
  })

  it("gives a laptop the classic window bar", () => {
    const classic = exportDress("laptop", "classic")
    expect(classic.kind === "classic" && classic.chrome.topBar).toBe(true)
  })

  it("a breakpoint width is no device: no frame of either kind", () => {
    expect(exportDress("bp-sm", "device")).toEqual({ kind: "none" })
    expect(exportDress("bp-sm", "classic")).toEqual({ kind: "none" })
  })
})
