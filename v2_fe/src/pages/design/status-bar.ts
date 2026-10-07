/// #626: the device frame's status bar and home indicator — what colour the
/// icons are, and whether the frame fills the strip — decided from what the
/// page reports (`design:status-bar`, sent by the composer's status runtime),
/// the active theme's `appearance` and its `--background`. Pure, so it is
/// tested; `FramedBoard` only draws the answer.

import { safeSwatchColor } from "./theme-options"

/** The ICON colour: "light" = white icons (iOS lightContent), "dark" = black. */
export type StatusInk = "light" | "dark"
export type ThemeAppearance = "light" | "dark"

export type StatusBarReport = {
  /** The page's `data-status-bar` at the top, if any. */
  mode: StatusInk | null
  /** The solid colour at the top of the page, as `rgb(r, g, b)`. */
  background: string | null
  /** Something at the top pads by `--safe-top` (the page draws the strip). */
  padsTop: boolean
  padsBottom: boolean
}

export type FrameChrome = {
  ink: StatusInk
  /** What fills the status strip, or null for transparent (the page pads). */
  stripFill: string | null
  /** The device screen behind the page (seen while it loads). */
  screenBackground: string
  colorScheme: "light" | "dark" | "normal"
}

/** Today's two inks, unchanged. */
export const LIGHT_INK = "#f5f5f5"
export const DARK_INK = "#0a0a0a"

const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i

/// A frame's report, validated: the frame is untrusted, so only an `rgb()`
/// background (the runtime always normalises to one), a light/dark mode and
/// literal `true` booleans survive. Anything else is not this message.
export function parseStatusBarReport(data: unknown): StatusBarReport | null {
  if (!data || typeof data !== "object") return null
  const m = data as Record<string, unknown>
  if (m.type !== "design:status-bar") return null
  const mode = m.mode === "light" || m.mode === "dark" ? m.mode : null
  const background =
    typeof m.background === "string" && m.background.length <= 40 && RGB.test(m.background) ? m.background : null
  return { mode, background, padsTop: m.padsTop === true, padsBottom: m.padsBottom === true }
}

export function sameStatusBarReport(current: StatusBarReport | null, next: StatusBarReport): boolean {
  return (
    !!current &&
    current.mode === next.mode &&
    current.background === next.background &&
    current.padsTop === next.padsTop &&
    current.padsBottom === next.padsBottom
  )
}

const toLinear = (channel: number) => {
  const s = channel / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const weigh = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function fromBytes(r: number, g: number, b: number): number | null {
  if ([r, g, b].some((c) => !(c >= 0 && c <= 255))) return null
  return weigh(toLinear(r), toLinear(g), toLinear(b))
}

/// WCAG relative luminance (0 black … 1 white) of an rgb()/rgba(), #hex or
/// oklch() colour — the forms a computed style or a shadcn token takes. Null
/// for anything else (the caller falls through to its next rule).
export function relativeLuminance(colour: string): number | null {
  const v = colour.trim()
  let m = RGB.exec(v)
  if (m) return fromBytes(Number(m[1]), Number(m[2]), Number(m[3]))
  m = HEX6.exec(v)
  if (m) return fromBytes(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16))
  m = HEX3.exec(v)
  if (m) return fromBytes(parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16))
  m = OKLCH.exec(v)
  if (m) {
    // OKLab → linear sRGB (Björn Ottosson's reference matrices).
    const L = Number(m[1]) / (m[2] ? 100 : 1)
    const C = Number(m[3])
    const h = (Number(m[4]) * Math.PI) / 180
    const a = C * Math.cos(h)
    const b = C * Math.sin(h)
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
    const r = 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s
    const g = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s
    const bl = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s
    return weigh(clamp01(r), clamp01(g), clamp01(bl))
  }
  return null
}

/// White icons when white has more contrast against `colour` than black:
/// 1.05/(L+0.05) > (L+0.05)/0.05  ⇔  (L+0.05)² < 0.0525  ⇔  L < ≈0.179.
export function inkForBackground(colour: string | null | undefined): StatusInk | null {
  if (!colour) return null
  const L = relativeLuminance(colour)
  if (L === null) return null
  return (L + 0.05) ** 2 < 0.0525 ? "light" : "dark"
}

/// WCAG contrast ratio between two relative luminances: (L1+0.05)/(L2+0.05),
/// lighter over darker — 1 (none) … 21 (black on white).
export function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Below this the appearance's ink is unreadable on the page's own top colour. */
const MIN_INK_CONTRAST = 3

/// The ruling's order: the page's `data-status-bar`, then the theme's
/// `appearance`, then the colour at the top of the page, then the theme's
/// `--background`; black icons when nothing is known.
///
/// Contrast guard: the appearance's ink yields to the reported top colour when
/// it would be under 3:1 against it (a light theme with a dark brand header
/// that does not pad gets white icons, not black on navy). An explicit page
/// `mode` is never second-guessed.
export function resolveStatusInk(input: {
  mode: StatusInk | null
  appearance: ThemeAppearance | null
  background: string | null
  themeBackground: string | null
}): StatusInk {
  if (input.mode) return input.mode
  if (input.appearance) {
    const ink: StatusInk = input.appearance === "dark" ? "light" : "dark"
    const top = input.background ? relativeLuminance(input.background) : null
    if (top !== null) {
      const inkL = relativeLuminance(inkColour(ink))
      if (inkL !== null && contrastRatio(inkL, top) < MIN_INK_CONTRAST) {
        return inkForBackground(input.background) ?? ink
      }
    }
    return ink
  }
  return inkForBackground(input.background) ?? inkForBackground(input.themeBackground) ?? "dark"
}

export function inkColour(ink: StatusInk): string {
  return ink === "light" ? LIGHT_INK : DARK_INK
}

/// Everything `FramedBoard` paints around the page. The report's background is
/// already a validated `rgb()`; the theme's swatch is agent-authored, so it is
/// painted only through `safeColour` (the switcher's allowlist). Until the
/// page has reported, the strip is FILLED (never a white gap); once it says it
/// pads under the bar, the strip is transparent and the page's own bar shows.
export function frameChrome(
  input: { report: StatusBarReport | null; appearance: ThemeAppearance | null; themeBackground: string | null },
  safeColour: (v: string | null | undefined) => string | undefined = (v) => safeSwatchColor(v),
): FrameChrome {
  const { report, appearance, themeBackground } = input
  const ink = resolveStatusInk({
    mode: report?.mode ?? null,
    appearance,
    background: report?.background ?? null,
    themeBackground,
  })
  const background = report?.background ?? safeColour(themeBackground) ?? null
  const fallback = ink === "light" ? DARK_INK : "#ffffff"
  return {
    ink,
    stripFill: report?.padsTop ? null : (background ?? fallback),
    screenBackground: background ?? fallback,
    colorScheme: appearance ?? "normal",
  }
}
