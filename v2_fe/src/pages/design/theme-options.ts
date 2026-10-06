/// What the canvas theme switcher offers (#619), as pure logic so it is
/// tested: the component (`theme-switcher.tsx`) only draws it.
///
/// The list comes from the manifest, which the server rebuilds on every file
/// event — so saving a new theme in the token panel updates the switcher live.

import type { DesignManifest, DesignThemeInfo } from "@/lib/design-api"

export type ThemeOption = DesignThemeInfo

const LEGACY: ThemeOption[] = [
  { name: "light", label: "Light", swatch: { primary: null, background: null } },
  { name: "dark", label: "Dark", swatch: { primary: null, background: null } },
]

/// The manifest's ordered themes, or — before the manifest loads, or from a
/// backend that predates named themes — the light/dark pair.
export function manifestThemes(manifest: DesignManifest | null): ThemeOption[] {
  return manifest?.themes?.length ? manifest.themes : LEGACY
}

export type SwitcherMode = "none" | "toggle" | "menu"

/// Exactly light + dark keeps the sun/moon toggle; light alone needs no
/// control; anything else is a dropdown.
export function switcherMode(themes: ThemeOption[]): SwitcherMode {
  if (themes.length <= 1) return "none"
  if (themes.length === 2 && themes[0].name === "light" && themes[1].name === "dark") return "toggle"
  return "menu"
}

/// The theme to render: the chosen one while it exists, else light. The
/// choice itself stays as stored, so a restored theme comes back.
export function resolveActiveTheme(theme: string, themes: ThemeOption[]): string {
  return themes.some((t) => t.name === theme) ? theme : "light"
}

export function toggledTheme(theme: string): string {
  return theme === "dark" ? "light" : "dark"
}

/// Base UI's `SelectValue` shows the raw value unless the root gets this map.
export function themeSelectItems(themes: ThemeOption[]): { value: string; label: string }[] {
  return themes.map((t) => ({ value: t.name, label: t.label }))
}

/// A swatch value safe to paint as a CSS `background`, or undefined. Token
/// values are agent-authored and validation only refuses `http(s)://`, so a
/// value like `url(//host/x.png)` would make the viewer's browser fetch a
/// remote resource. Only something the browser parses as a plain COLOR is
/// used. `supports` is injectable for tests (vitest runs in node, where `CSS`
/// does not exist — and with no `CSS`, nothing is painted).
const COLOUR_FNS = "rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix"
const PLAIN_ARGS = "[a-zA-Z0-9 .%/,+-]*"
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NAMED = /^[a-z]+$/i
const SIMPLE_FN = new RegExp(`^(?:${COLOUR_FNS})\\(${PLAIN_ARGS}\\)$`, "i")
const MIX_FN = new RegExp(
  `^color-mix\\((?:[a-zA-Z0-9 .%/,+-]|(?:${COLOUR_FNS})\\(${PLAIN_ARGS}\\))*\\)$`,
  "i",
)

/// Allowlist: hex, one colour function with plain-character arguments
/// (color-mix may nest one level of colour functions), or a letters-only name.
/// No backslash can match, so no CSS escape survives.
function isPlainColour(v: string): boolean {
  return HEX.test(v) || NAMED.test(v) || SIMPLE_FN.test(v) || MIX_FN.test(v)
}

export function safeSwatchColor(
  value: string | null | undefined,
  supports: ((property: string, value: string) => boolean) | null = typeof CSS !== "undefined" &&
  typeof CSS.supports === "function"
    ? (property, v) => CSS.supports(property, v)
    : null,
): string | undefined {
  if (!value || !supports) return undefined
  if (!isPlainColour(value)) return undefined
  return supports("color", value) ? value : undefined
}
