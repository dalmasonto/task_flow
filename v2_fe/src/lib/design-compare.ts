/// #523: the Compare drawer's pure half — what a valid comparison IS, how a
/// request is shaped, and how a variant becomes a token write.
///
/// Kept out of the component so the rules match the renderer's, not the
/// drawer's mood: the backend refuses >6 routes, >4 variants and >24 cells
/// (`compare::validate_spec`), and a drawer that let the operator press
/// Render into a 400 would be lying about what the grid holds.

import type { DesignTokenValue, DesignTokensDoc } from "./design-api"

/// One column: a label and the token overrides it renders with. An empty
/// `tokens` is the live design (`Current`).
export type CompareVariant = { label: string; tokens: Record<string, string> }

/// The grid's limits, mirroring `compare::validate_spec`.
export const COMPARE_LIMITS = { maxRoutes: 6, maxVariants: 4, maxCells: 24 } as const

export type CompareSpec = {
  routes: string[]
  variants: CompareVariant[]
  themes: string[]
}

/// Why this spec cannot be rendered, or null when it can. The caller shows it
/// and disables Render — the operator learns what is wrong instead of reading
/// it off a 400.
export function compareProblem(spec: CompareSpec): string | null {
  if (spec.routes.length === 0) return "Pick at least one screen."
  if (spec.routes.length > COMPARE_LIMITS.maxRoutes) {
    return `At most ${COMPARE_LIMITS.maxRoutes} screens (picked ${spec.routes.length}).`
  }
  if (spec.variants.length === 0) return "Add at least one variant — “Current” is the live design."
  if (spec.variants.length > COMPARE_LIMITS.maxVariants) {
    return `At most ${COMPARE_LIMITS.maxVariants} variants (added ${spec.variants.length}).`
  }
  const cells = spec.routes.length * Math.max(1, spec.variants.length) * Math.max(1, spec.themes.length)
  if (cells > COMPARE_LIMITS.maxCells) {
    return `The grid holds ${COMPARE_LIMITS.maxCells} cells at most (screens × variants × themes); this is ${cells}.`
  }
  return null
}

export type CompareRequest = {
  routes: string[]
  variants: { label: string; tokens?: Record<string, string> }[]
  themes: string[]
  checks: { fg: string; bg: string; label: string }[]
  include_apply: boolean
}

/// The wire body for `POST /api/design/{project}/compare`. A variant with no
/// overrides sends no `tokens` at all — it is the live design, not an empty
/// override. The default contrast check is the proposal's own: the button's
/// text on the button.
export function buildCompareRequest(spec: CompareSpec): CompareRequest {
  return {
    routes: spec.routes,
    variants: spec.variants.map((variant) =>
      Object.keys(variant.tokens).length ? { label: variant.label, tokens: variant.tokens } : { label: variant.label }
    ),
    themes: spec.themes,
    checks: [{ fg: "--primary-foreground", bg: "--primary", label: "button text" }],
    // The drawer needs `apply`: a variant's tokens are spoken in CSS-variable
    // names, and only the emitter knows which tokens.json key each one is.
    include_apply: true,
  }
}

/// The next free `Variant N`, so two clicks never make two columns the reply
/// cannot tell apart.
export function newVariantLabel(existing: string[]): string {
  for (let n = 1; ; n += 1) {
    const label = `Variant ${n}`
    if (!existing.includes(label)) return label
  }
}

/// A token patch (the `{category: {key: {light, dark?}}}` shape `compare_apply`
/// returns, and the shape `design_write_tokens` accepts) merged into a full
/// document — what the operator's Apply writes, since the user route takes the
/// whole doc rather than a patch.
///
/// A patched token's value object REPLACES the stored one: the patch carries
/// the values the variant rendered with, per theme, so replacing is what makes
/// the write reproduce the column exactly.
export function applyTokenPatch(doc: DesignTokensDoc, patch: Record<string, Record<string, DesignTokenValue>>): DesignTokensDoc {
  const categories: Record<string, Record<string, DesignTokenValue>> = { ...doc.categories }
  for (const [category, tokens] of Object.entries(patch)) {
    categories[category] = { ...(categories[category] ?? {}), ...tokens }
  }
  return { ...doc, categories }
}

export type ColourTokenRow = {
  /// The CSS variable name the compare API speaks (`--primary`).
  name: string
  category: string
  /// What the token renders as in the active theme (light when it has none).
  value: string
  /// `#rrggbb` when the value can seed a colour input; null otherwise (oklch,
  /// color-mix, a var() chain) — those keep the value and cannot be picked.
  hex: string | null
}

const HEX6 = /^#[0-9a-f]{6}$/i

/// The tokens a variant can plausibly recolour: everything in the `colors`
/// category, plus any token anywhere whose value looks like a colour. Ordered
/// category by category so the picker reads like the tokens file.
export function colourTokenRows(doc: DesignTokensDoc, theme: string): ColourTokenRow[] {
  const rows: ColourTokenRow[] = []
  for (const [category, tokens] of Object.entries(doc.categories)) {
    for (const [key, values] of Object.entries(tokens)) {
      const value = (values[theme] ?? values["light"] ?? "").trim()
      if (category !== "colors" && !looksLikeColour(value)) continue
      rows.push({
        name: category === "colors" ? `--${key}` : key,
        category,
        value,
        hex: HEX6.test(value) ? value : null,
      })
    }
  }
  return rows
}

function looksLikeColour(value: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgb|hsl|oklch|oklab|lch|lab|color\(|color-mix\(|var\()/i.test(value)
}

/// A compare response's `apply`, narrowed to what the drawer uses.
export type CompareApply = Record<string, { patch: Record<string, Record<string, DesignTokenValue>> }>
