import { describe, expect, it } from "vitest"

import {
  DARK_INK,
  LIGHT_INK,
  frameChrome,
  inkColour,
  inkForBackground,
  parseStatusBarReport,
  relativeLuminance,
  resolveStatusInk,
  sameStatusBarReport,
  type StatusBarReport,
} from "./status-bar"

const report = (over: Partial<StatusBarReport> = {}): StatusBarReport => ({
  mode: null,
  background: null,
  padsTop: false,
  padsBottom: false,
  ...over,
})

/// vitest runs in node (no `CSS.supports`), so the painter's colour guard is
/// injected: pass plain strings through.
const passThrough = (v: string | null | undefined) => v ?? undefined

describe("parseStatusBarReport", () => {
  it("reads a well-formed report", () => {
    expect(
      parseStatusBarReport({ type: "design:status-bar", mode: "light", background: "rgb(21, 128, 61)", padsTop: true, padsBottom: false }),
    ).toEqual(report({ mode: "light", background: "rgb(21, 128, 61)", padsTop: true }))
  })

  it("ignores other messages and non-objects", () => {
    expect(parseStatusBarReport({ type: "design:route", path: "/s/x" })).toBeNull()
    expect(parseStatusBarReport("design:status-bar")).toBeNull()
    expect(parseStatusBarReport(null)).toBeNull()
  })

  it("sanitises hostile fields: only rgb() backgrounds, only light/dark modes, only true booleans", () => {
    const parsed = parseStatusBarReport({
      type: "design:status-bar",
      mode: "purple",
      background: "url(https://evil.example/x.png)",
      padsTop: "yes",
      padsBottom: 1,
    })
    expect(parsed).toEqual(report())
    expect(parseStatusBarReport({ type: "design:status-bar", background: "oklch(0.2 0 0)" })?.background).toBeNull()
  })
})

describe("sameStatusBarReport", () => {
  it("is true only for an equal report", () => {
    expect(sameStatusBarReport(report({ padsTop: true }), report({ padsTop: true }))).toBe(true)
    expect(sameStatusBarReport(report(), report({ background: "rgb(0, 0, 0)" }))).toBe(false)
    expect(sameStatusBarReport(null, report())).toBe(false)
  })
})

describe("relativeLuminance", () => {
  it("reads rgb, rgba and hex", () => {
    expect(relativeLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 5)
    expect(relativeLuminance("rgba(0, 0, 0, 1)")).toBeCloseTo(0, 5)
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 5)
    expect(relativeLuminance("#15803D")).toBeCloseTo(0.16, 2)
  })

  it("reads shadcn oklch values, L as a number or a percentage", () => {
    expect(relativeLuminance("oklch(1 0 0)")).toBeCloseTo(1, 2)
    expect(relativeLuminance("oklch(0.145 0 0)")!).toBeLessThan(0.01)
    expect(relativeLuminance("oklch(14.5% 0 0)")!).toBeLessThan(0.01)
    expect(relativeLuminance("oklch(0.62 0.14 220 / 0.9)")).not.toBeNull()
  })

  it("is null for anything it cannot read", () => {
    expect(relativeLuminance("var(--background)")).toBeNull()
    expect(relativeLuminance("rgb(300, 0, 0)")).toBeNull()
    expect(relativeLuminance("hsl(0 0% 0%)")).toBeNull()
  })
})

describe("inkForBackground", () => {
  it("puts white icons on dark colours and black on light ones (higher contrast wins)", () => {
    expect(inkForBackground("rgb(10, 10, 10)")).toBe("light")
    expect(inkForBackground("rgb(255, 255, 255)")).toBe("dark")
    // A brand green (green-700, L≈0.16) is under the ≈0.179 line: white icons.
    expect(inkForBackground("rgb(21, 128, 61)")).toBe("light")
  })
  it("draws the light/dark line at L≈0.179, where both inks have equal contrast", () => {
    expect(inkForBackground("rgb(70, 70, 70)")).toBe("light") // L≈0.061
    expect(inkForBackground("rgb(128, 128, 128)")).toBe("dark") // L≈0.216
    expect(inkForBackground(null)).toBeNull()
    expect(inkForBackground("var(--x)")).toBeNull()
  })
})

describe("resolveStatusInk — the order", () => {
  const base = { mode: null, appearance: null, background: null, themeBackground: null } as const

  it("1. the page's data-status-bar wins over everything", () => {
    expect(resolveStatusInk({ ...base, mode: "light", appearance: "light", background: "rgb(255, 255, 255)" })).toBe("light")
    expect(resolveStatusInk({ ...base, mode: "dark", appearance: "dark", background: "rgb(0, 0, 0)" })).toBe("dark")
  })

  it("2. then the theme's appearance: dark → white icons, light → black", () => {
    // Over a readable top colour, or none, the appearance wins over luminance.
    expect(resolveStatusInk({ ...base, appearance: "dark", background: "rgb(0, 0, 0)" })).toBe("light")
    expect(resolveStatusInk({ ...base, appearance: "light", background: "rgb(255, 255, 255)" })).toBe("dark")
    expect(resolveStatusInk({ ...base, appearance: "dark", themeBackground: "#ffffff" })).toBe("light")
    expect(resolveStatusInk({ ...base, appearance: "light", themeBackground: "#000000" })).toBe("dark")
  })

  it("2a. contrast guard: the appearance's ink yields to the top colour under 3:1", () => {
    const navy = "rgb(15, 23, 42)"
    const white = "rgb(255, 255, 255)"
    expect(resolveStatusInk({ ...base, appearance: "light", background: navy })).toBe("light")
    expect(resolveStatusInk({ ...base, appearance: "light", background: white })).toBe("dark")
    expect(resolveStatusInk({ ...base, appearance: "dark", background: white })).toBe("dark")
    expect(resolveStatusInk({ ...base, appearance: "dark", background: "rgb(15,23,42)" })).toBe("light")
    // An explicit page mode is never second-guessed.
    expect(resolveStatusInk({ ...base, mode: "dark", appearance: "light", background: navy })).toBe("dark")
    expect(resolveStatusInk({ ...base, mode: "dark", background: navy })).toBe("dark")
  })

  it("3. then the page's top colour, then the theme's --background, else black icons", () => {
    expect(resolveStatusInk({ ...base, background: "rgb(15, 23, 42)" })).toBe("light")
    expect(resolveStatusInk({ ...base, themeBackground: "oklch(0.145 0 0)" })).toBe("light")
    expect(resolveStatusInk({ ...base, background: "rgb(250, 250, 250)", themeBackground: "oklch(0.145 0 0)" })).toBe("dark")
    expect(resolveStatusInk(base)).toBe("dark")
  })
})

describe("inkColour", () => {
  it("keeps today's two inks", () => {
    expect(inkColour("light")).toBe(LIGHT_INK)
    expect(inkColour("dark")).toBe(DARK_INK)
    expect([LIGHT_INK, DARK_INK]).toEqual(["#f5f5f5", "#0a0a0a"])
  })
})

describe("frameChrome", () => {
  it("#632: the strip is filled with the top colour even when the page claims to pad", () => {
    const chrome = frameChrome(
      { report: report({ mode: "light", background: "rgb(21, 128, 61)", padsTop: true }), appearance: "light", themeBackground: "#fff" },
      (v) => v ?? undefined,
    )
    expect(chrome).toEqual({ ink: "light", stripFill: "rgb(21, 128, 61)", screenBackground: "rgb(21, 128, 61)", colorScheme: "light" })
  })

  it("a page that does not pad gets the strip filled with its own top colour, never white by default", () => {
    const chrome = frameChrome(
      { report: report({ background: "rgb(15, 23, 42)" }), appearance: null, themeBackground: "oklch(1 0 0)" },
      passThrough,
    )
    expect(chrome.stripFill).toBe("rgb(15, 23, 42)")
    expect(chrome.ink).toBe("light")
    expect(chrome.colorScheme).toBe("normal")
  })

  it("before any report, the strip is filled with the theme's background and inked by appearance", () => {
    const chrome = frameChrome({ report: null, appearance: "dark", themeBackground: "oklch(0.145 0 0)" }, passThrough)
    expect(chrome).toEqual({ ink: "light", stripFill: "oklch(0.145 0 0)", screenBackground: "oklch(0.145 0 0)", colorScheme: "dark" })
  })

  it("a theme background the colour guard refuses is never painted; the fallback follows the ink", () => {
    const refuse = () => undefined
    expect(frameChrome({ report: null, appearance: "dark", themeBackground: "url(//x)" }, refuse).stripFill).toBe("#0a0a0a")
    expect(frameChrome({ report: null, appearance: null, themeBackground: null }, refuse).stripFill).toBe("#ffffff")
  })
})
