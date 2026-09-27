import { describe, expect, it } from "vitest"

import type { RouteEntry } from "@/lib/design-api"
import { normalizeLayout } from "@/lib/design-layout"
import { deviceById } from "@/lib/design-devices"
import {
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
