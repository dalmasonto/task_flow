import { describe, expect, it } from "vitest"

import type { DesignManifest } from "@/lib/design-api"
import {
  manifestThemes,
  resolveActiveTheme,
  safeSwatchColor,
  switcherMode,
  themeSelectItems,
  toggledTheme,
  type ThemeOption,
} from "./theme-options"

const opt = (name: string, label = name): ThemeOption => ({ name, label, swatch: { primary: null, background: null } })

describe("switcherMode", () => {
  it("keeps the sun/moon toggle for exactly light + dark (acceptance 4)", () => {
    expect(switcherMode([opt("light"), opt("dark")])).toBe("toggle")
  })
  it("uses the dropdown for three or more", () => {
    expect(switcherMode([opt("light"), opt("dark"), opt("ocean")])).toBe("menu")
  })
  it("uses the dropdown for a pair that is not light + dark", () => {
    expect(switcherMode([opt("light"), opt("ocean")])).toBe("menu")
  })
  it("shows nothing for light alone", () => {
    expect(switcherMode([opt("light")])).toBe("none")
  })
})

describe("resolveActiveTheme", () => {
  it("keeps a declared theme", () => {
    expect(resolveActiveTheme("ocean", [opt("light"), opt("dark"), opt("ocean")])).toBe("ocean")
  })
  it("falls back to light when the chosen theme was deleted or renamed (review focus 3)", () => {
    expect(resolveActiveTheme("ocean", [opt("light"), opt("dark")])).toBe("light")
  })
})

describe("manifestThemes", () => {
  it("reads the manifest's ordered list", () => {
    const manifest = { themes: [opt("light"), opt("sunset"), opt("dark")] } as unknown as DesignManifest
    expect(manifestThemes(manifest).map((t) => t.name)).toEqual(["light", "sunset", "dark"])
  })
  it("falls back to light + dark with no manifest yet or an older backend", () => {
    expect(manifestThemes(null).map((t) => t.name)).toEqual(["light", "dark"])
    expect(manifestThemes({} as DesignManifest).map((t) => t.name)).toEqual(["light", "dark"])
  })
})

describe("toggle and items", () => {
  it("toggles between light and dark", () => {
    expect(toggledTheme("light")).toBe("dark")
    expect(toggledTheme("dark")).toBe("light")
  })
  it("gives the Base UI Select its value → label map", () => {
    expect(themeSelectItems([opt("light", "Light"), opt("ocean", "Ocean")])).toEqual([
      { value: "light", label: "Light" },
      { value: "ocean", label: "Ocean" },
    ])
  })
})

describe("safeSwatchColor", () => {
  // A stand-in for CSS.supports("color", v): plain colours only.
  const supports = (property: string, v: string) => property === "color" && /^(#[0-9a-f]{3,8}|oklch\([^()]*\)|red)$/i.test(v)
  it("paints a value the browser reads as a colour", () => {
    expect(safeSwatchColor("#0af", supports)).toBe("#0af")
    expect(safeSwatchColor("oklch(0.5 0.1 250)", supports)).toBe("oklch(0.5 0.1 250)")
  })
  it("never paints a url() or anything else that is not a colour", () => {
    expect(safeSwatchColor("url(//evil.example/x.png)", supports)).toBeUndefined()
    expect(safeSwatchColor("red url(//evil.example/x.png)", supports)).toBeUndefined()
  })
  it("paints nothing for a missing value, or with no CSS.supports at all", () => {
    expect(safeSwatchColor(null, supports)).toBeUndefined()
    expect(safeSwatchColor("", supports)).toBeUndefined()
    expect(safeSwatchColor("#0af", null)).toBeUndefined()
    // In node (vitest) the default has no `CSS`, so it refuses.
    expect(safeSwatchColor("#0af")).toBeUndefined()
  })
})

describe("safeSwatchColor refuses url() and var()", () => {
  const yes = () => true
  it("rejects values that could fetch or can't resolve", () => {
    expect(safeSwatchColor("var(--x, url(//h/x))", yes)).toBeUndefined()
    expect(safeSwatchColor("url(x)", yes)).toBeUndefined()
    expect(safeSwatchColor("URL (x)", yes)).toBeUndefined()
    expect(safeSwatchColor("var(--primary)", yes)).toBeUndefined()
  })
  it("passes a concrete colour", () => {
    expect(safeSwatchColor("#fff", yes)).toBe("#fff")
  })
})
