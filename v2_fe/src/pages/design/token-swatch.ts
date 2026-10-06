import { safeSwatchColor } from "./theme-options"

const HEX6 = /^#[0-9a-f]{6}$/i

export type ColourControl = { kind: "picker"; hex: string } | { kind: "swatch"; color: string | undefined }

/// Decides how a colour token is previewed. `<input type="color">` only
/// understands `#rrggbb`; anything else (oklch, hsl, color-mix, names) gets a
/// read-only swatch painted through the hardened `safeSwatchColor`, never the
/// raw token value. An empty value falls back to the inherited placeholder.
export function colourControl(
  value: string,
  placeholder?: string,
  supports?: ((property: string, value: string) => boolean) | null,
): ColourControl {
  const shown = (value.trim() || placeholder?.trim() || "").trim()
  if (HEX6.test(shown)) return { kind: "picker", hex: shown }
  return { kind: "swatch", color: supports === undefined ? safeSwatchColor(shown) : safeSwatchColor(shown, supports) }
}
