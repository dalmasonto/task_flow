import { describe, expect, it } from "vitest"

import {
  applyTokenPatch,
  buildCompareRequest,
  compareProblem,
  colourTokenRows,
  newVariantLabel,
  type CompareVariant,
} from "./design-compare"
import type { DesignTokensDoc } from "./design-api"

const doc = (overrides: Partial<DesignTokensDoc> = {}): DesignTokensDoc => ({
  version: 1,
  themes: [{ name: "ocean" }],
  categories: {
    colors: {
      primary: { light: "#15803D", ocean: "#0EA5E9" },
      background: { light: "#FFFFFF" },
      ring: { light: "oklch(0.7 0.1 250)" },
    },
    custom: { "--track-tint": { light: "#F1F5F9" } },
  },
  ...overrides,
})

describe("compareProblem", () => {
  const variant = (tokens: Record<string, string> = {}): CompareVariant => ({ label: "Lime", tokens })

  it("passes a spec inside every limit", () => {
    expect(compareProblem({ routes: ["/", "/setup"], variants: [variant(), { label: "Current", tokens: {} }], themes: ["light", "ocean"] })).toBeNull()
  })

  it("names what is missing rather than disabling silently", () => {
    expect(compareProblem({ routes: [], variants: [variant()], themes: ["light"] })).toMatch(/screen/i)
    expect(compareProblem({ routes: ["/"], variants: [], themes: ["light"] })).toMatch(/variant/i)
  })

  it("refuses more routes, more variants or more cells than the grid holds", () => {
    const routes = ["/a", "/b", "/c", "/d", "/e", "/f", "/g"]
    expect(compareProblem({ routes, variants: [variant()], themes: ["light"] })).toMatch(/at most 6 screens/i)
    expect(
      compareProblem({ routes: ["/"], variants: [1, 2, 3, 4, 5].map((n) => ({ label: `v${n}`, tokens: {} })), themes: ["light"] })
    ).toMatch(/at most 4 variants/i)
    // 6 × 3 × 2 = 36 cells; the grid holds 24.
    expect(
      compareProblem({
        routes: ["/a", "/b", "/c", "/d", "/e", "/f"],
        variants: [variant(), { label: "b", tokens: {} }, { label: "c", tokens: {} }],
        themes: ["light", "ocean"],
      })
    ).toMatch(/24 cells/i)
  })
})

describe("buildCompareRequest", () => {
  it("sends the picked screens, the variants' overrides and the default contrast check", () => {
    const body = buildCompareRequest({
      routes: ["/", "/setup"],
      variants: [{ label: "Current", tokens: {} }, { label: "Lime", tokens: { "--primary": "#448502" } }],
      themes: ["light", "ocean"],
    })
    expect(body.routes).toEqual(["/", "/setup"])
    expect(body.variants).toEqual([{ label: "Current" }, { label: "Lime", tokens: { "--primary": "#448502" } }])
    expect(body.themes).toEqual(["light", "ocean"])
    // The proposal's own default: button text on the button.
    expect(body.checks).toEqual([{ fg: "--primary-foreground", bg: "--primary", label: "button text" }])
    // The drawer ASKS for `apply`: mapping a CSS variable back to its
    // tokens.json key is the emitter's knowledge (`category_to_var_name`), and
    // a second copy of that mapping in TypeScript is how the two drift.
    expect(body.include_apply).toBe(true)
  })
})

describe("newVariantLabel", () => {
  it("mints the first unused Variant N", () => {
    expect(newVariantLabel(["Current"])).toBe("Variant 1")
    expect(newVariantLabel(["Variant 1", "Variant 3"])).toBe("Variant 2")
  })
})

describe("applyTokenPatch", () => {
  it("merges the patch's values in, leaving every other token and theme alone", () => {
    const merged = applyTokenPatch(doc(), { colors: { primary: { light: "#448502", ocean: "#84CC16" } } })
    expect(merged.categories.colors.primary).toEqual({ light: "#448502", ocean: "#84CC16" })
    expect(merged.categories.colors.background).toEqual({ light: "#FFFFFF" })
    expect(merged.categories.custom["--track-tint"]).toEqual({ light: "#F1F5F9" })
    expect(merged.version).toBe(1)
    expect(merged.themes).toEqual([{ name: "ocean" }])
  })

  it("creates a category the variant introduced, and never mutates the input", () => {
    const before = doc()
    const merged = applyTokenPatch(before, { custom: { "--track-tint": { light: "#E2E8F0" } } })
    expect(merged.categories.custom["--track-tint"]).toEqual({ light: "#E2E8F0" })
    expect(before.categories.custom["--track-tint"]).toEqual({ light: "#F1F5F9" })
  })
})

describe("colourTokenRows", () => {
  it("lists the colour tokens with the value a variant would start from", () => {
    const rows = colourTokenRows(doc(), "light")
    expect(rows.map((r) => r.name)).toEqual(["--primary", "--background", "--ring", "--track-tint"])
    expect(rows[0]).toMatchObject({ name: "--primary", category: "colors", value: "#15803D", hex: "#15803D" })
    // A non-hex value is still listed — it just cannot seed a colour input.
    expect(rows[2].hex).toBeNull()
  })

  it("reads the value the ACTIVE theme renders with", () => {
    const rows = colourTokenRows(doc(), "ocean")
    expect(rows[0].value).toBe("#0EA5E9")
    // A token with no value in that theme falls back to light, as the page does.
    expect(rows[1].value).toBe("#FFFFFF")
  })
})
