import { describe, expect, it } from "vitest"

import type { DesignManifest } from "@/lib/design-api"
import {
  manifestThemes,
  resolveActiveTheme,
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
