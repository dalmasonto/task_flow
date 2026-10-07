// #632: the renderer's status strip (backend/renderer/status-chrome.mjs) is a
// port of the canvas/export rules in pages/design/status-bar.ts. This pins the
// two to the same answers across the rule order, the contrast guard and every
// fallback, so a `design_screenshot` device frame is inked and filled exactly
// as the canvas and a download are. Change both files together.
import { describe, expect, it } from "vitest"
import * as port from "../../../backend/renderer/status-chrome.mjs"
import {
  frameChrome,
  inkForBackground,
  relativeLuminance,
  resolveStatusInk,
  type StatusBarReport,
  type StatusInk,
  type ThemeAppearance,
} from "@/pages/design/status-bar"

const colours = [
  null,
  "rgb(255, 255, 255)",
  "rgb(0, 0, 0)",
  "rgb(15, 23, 42)",
  "rgb(21, 128, 61)",
  "rgb(59, 130, 246)",
  "rgb(118, 118, 118)",
  "rgb(250, 204, 21)",
  "rgb(12, 74, 110)",
  "#0ea5e9",
  "#fff",
  "oklch(0.145 0 0)",
  "oklch(98% 0.01 240)",
  "url(//x)",
]
const modes: (StatusInk | null)[] = [null, "light", "dark"]
const appearances: (ThemeAppearance | null)[] = [null, "light", "dark"]
// Both sides get the same guard so the RULES are what is compared.
const pass = (v: string | null | undefined) => (v && !v.startsWith("url") ? v : undefined)

describe("renderer status chrome parity (#632)", () => {
  it("luminance and the light/dark line agree for every colour form", () => {
    for (const c of colours) {
      if (!c) continue
      expect(port.relativeLuminance(c), c).toBe(relativeLuminance(c))
      expect(port.inkForBackground(c), c).toBe(inkForBackground(c))
    }
  })

  it("resolveStatusInk and frameChrome agree on every combination", () => {
    let n = 0
    for (const mode of modes)
      for (const appearance of appearances)
        for (const background of colours)
          for (const themeBackground of colours) {
            const input = { mode, appearance, background, themeBackground }
            expect(port.resolveStatusInk(input), JSON.stringify(input)).toBe(resolveStatusInk(input))
            const report: StatusBarReport = { mode, background, padsTop: false, padsBottom: false }
            const args = { report, appearance, themeBackground }
            expect(port.frameChrome(args, pass), JSON.stringify(args)).toEqual(frameChrome(args, pass))
            expect(port.frameChrome({ ...args, report: null }, pass)).toEqual(frameChrome({ ...args, report: null }, pass))
            n++
          }
    expect(n).toBeGreaterThan(1000)
  })

  it("a named dark theme gets a dark strip with light icons", () => {
    const page = port.statusFromPage({ mode: null, background: "rgb(8, 47, 73)", appearance: "dark", themeBackground: "rgb(8, 47, 73)" })
    expect(page).not.toBeNull()
    expect(port.frameChrome(page!)).toEqual({ ink: "light", stripFill: "rgb(8, 47, 73)", screenBackground: "rgb(8, 47, 73)", colorScheme: "dark" })
  })

  it("statusFromPage keeps only rgb() colours and light/dark words", () => {
    expect(port.statusFromPage(null)).toBeNull()
    expect(port.statusFromPage({ mode: "x", background: "url(javascript:1)", appearance: "dim", themeBackground: "red" })).toEqual({
      report: { mode: null, background: null },
      appearance: null,
      themeBackground: null,
    })
  })
})
