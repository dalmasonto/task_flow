import { describe, expect, it } from "vitest"

import type { DesignTokensDoc } from "@/lib/design-api"
import {
  addTheme,
  declaredThemes,
  deleteTheme,
  duplicateTheme,
  moveTheme,
  overrideFromDefault,
  ownThemeValue,
  renameTheme,
  setThemeValue,
  themeLabel,
  themeNameError,
  themeOverrideCount,
} from "./token-themes"

// The document as `fetchDesignTokens` hands it over: parsed JSON, legacy shape.
const legacy = (): DesignTokensDoc =>
  JSON.parse(`{"version":1,"categories":{"colors":{"primary":{"light":"#111","dark":"#eee"},"bg":{"light":"#fff"}}}}`)

describe("declaredThemes", () => {
  it("treats a document with no list as the legacy light/dark pair", () => {
    expect(declaredThemes(legacy())).toEqual(["light", "dark"])
  })
})

describe("theme edits", () => {
  it("duplicates dark into ocean, copying every override (acceptance 2)", () => {
    const doc = duplicateTheme(legacy(), "dark", "ocean")
    expect(declaredThemes(doc)).toEqual(["light", "dark", "ocean"])
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee", ocean: "#eee" })
    expect(doc.categories.colors.bg).toEqual({ light: "#fff" })
  })

  it("duplicating light starts a theme with no overrides", () => {
    const doc = duplicateTheme(legacy(), "light", "paper")
    expect(declaredThemes(doc)).toEqual(["light", "dark", "paper"])
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee" })
  })

  it("renames a theme and moves its values", () => {
    const doc = renameTheme(duplicateTheme(legacy(), "dark", "ocean"), "ocean", "sea")
    expect(declaredThemes(doc)).toEqual(["light", "dark", "sea"])
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee", sea: "#eee" })
  })

  it("deletes a theme with its values, and never deletes light", () => {
    const doc = deleteTheme(legacy(), "dark")
    expect(declaredThemes(doc)).toEqual(["light"])
    expect(doc.categories.colors.primary).toEqual({ light: "#111" })
    expect(deleteTheme(legacy(), "light")).toEqual(legacy())
  })

  it("reorders themes and stops at the ends", () => {
    const doc = addTheme(addTheme(legacy(), "ocean"), "sunset")
    expect(declaredThemes(moveTheme(doc, "sunset", -1))).toEqual(["light", "dark", "sunset", "ocean"])
    expect(declaredThemes(moveTheme(doc, "dark", -1))).toEqual(["light", "dark", "ocean", "sunset"])
    expect(declaredThemes(moveTheme(doc, "sunset", 1))).toEqual(["light", "dark", "ocean", "sunset"])
  })

  it("never mutates the document it was given", () => {
    const before = legacy()
    const snapshot = JSON.stringify(before)
    renameTheme(duplicateTheme(before, "dark", "ocean"), "dark", "night")
    setThemeValue(before, "colors", "primary", "dark", "")
    deleteTheme(before, "dark")
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe("themeNameError", () => {
  it.each(["", "Ocean", "my theme", "1x", "x\"]", "light", "both", "all", "dark"])("refuses %j", (name) => {
    expect(themeNameError(legacy(), name)).not.toBeNull()
  })

  it("accepts a fresh slug, and a rename to its own name", () => {
    expect(themeNameError(legacy(), "ocean")).toBeNull()
    expect(themeNameError(legacy(), "dark", "dark")).toBeNull()
  })

  it("caps the list at 8 themes including light", () => {
    let doc = legacy()
    for (const name of ["a", "b", "c", "d", "e", "f"]) doc = addTheme(doc, name)
    expect(declaredThemes(doc)).toHaveLength(8)
    expect(themeNameError(doc, "g")).toMatch(/8/)
  })
})

describe("per-theme values", () => {
  it("edits one theme; an empty value removes the override so light shows through", () => {
    let doc = duplicateTheme(legacy(), "dark", "ocean")
    doc = setThemeValue(doc, "colors", "primary", "ocean", "#0af")
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee", ocean: "#0af" })
    doc = setThemeValue(doc, "colors", "primary", "ocean", "  ")
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee" })
    expect(ownThemeValue(doc.categories.colors.primary, "ocean")).toBeUndefined()
    expect(ownThemeValue(doc.categories.colors.primary, "light")).toBe("#111")
    doc = setThemeValue(doc, "colors", "primary", "light", "#222")
    expect(doc.categories.colors.primary.light).toBe("#222")
  })

  it("labels themes from their declaration or their slug", () => {
    expect(themeLabel(legacy(), "light")).toBe("Light")
    expect(themeLabel(addTheme(legacy(), "high-contrast"), "high-contrast")).toBe("High Contrast")
    expect(themeLabel(addTheme(legacy(), "ocean", "Deep sea"), "ocean")).toBe("Deep sea")
  })
})

describe("overrideFromDefault", () => {
  const shadcn = { light: "oklch(0.205 0 0)", dark: "oklch(0.922 0 0)" }
  it("drops the default's dark in a project that deleted dark (Save would be refused)", () => {
    const oceanOnly: DesignTokensDoc = { version: 1, themes: [{ name: "ocean" }], categories: {} }
    expect(overrideFromDefault(oceanOnly, shadcn)).toEqual({ light: "oklch(0.205 0 0)" })
  })
  it("keeps dark where the project declares it (legacy and listed alike)", () => {
    expect(overrideFromDefault(legacy(), shadcn)).toEqual(shadcn)
    const listed: DesignTokensDoc = { version: 1, themes: [{ name: "dark" }, { name: "ocean" }], categories: {} }
    expect(overrideFromDefault(listed, shadcn)).toEqual(shadcn)
  })
  it("returns a copy, never the default itself", () => {
    const copy = overrideFromDefault(legacy(), shadcn)
    expect(copy).not.toBe(shadcn)
  })
})

describe("themeOverrideCount", () => {
  it("counts the token values a theme overrides, across categories", () => {
    const doc: DesignTokensDoc = {
      version: 1,
      themes: [{ name: "ocean" }],
      categories: {
        colors: { primary: { light: "#000", ocean: "#0af" }, ring: { light: "#111" } },
        custom: { radius: { light: "0.5rem", ocean: "1rem" } },
      },
    }
    expect(themeOverrideCount(doc, "ocean")).toBe(2)
    expect(themeOverrideCount(doc, "dark")).toBe(0)
  })
})
