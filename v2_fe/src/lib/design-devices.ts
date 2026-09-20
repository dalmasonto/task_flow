/// Device presets for the design canvas (§9.3).
///
/// The iframe is ALWAYS its true CSS width — zoom is a transform on the frame
/// wrapper, never on the iframe itself, or the page's breakpoints would lie.
/// DPR is metadata for screenshots, not applied to previews.

export type DeviceGroup = "phone" | "tablet" | "laptop" | "breakpoint"

export type DevicePreset = {
  id: string
  label: string
  group: DeviceGroup
  width: number
  height: number
  dpr: number
}

export const DEVICE_PRESETS: DevicePreset[] = [
  // Phone
  { id: "iphone-se", label: "iPhone SE", group: "phone", width: 375, height: 667, dpr: 2 },
  { id: "iphone-16-pro", label: "iPhone 15/16", group: "phone", width: 393, height: 852, dpr: 3 },
  { id: "iphone-16-pro-max", label: "iPhone 16 Pro Max", group: "phone", width: 440, height: 956, dpr: 3 },
  { id: "pixel-8", label: "Pixel 8", group: "phone", width: 412, height: 915, dpr: 2.6 },
  { id: "galaxy-s24", label: "Galaxy S24", group: "phone", width: 360, height: 780, dpr: 3 },
  // Tablet
  { id: "ipad-mini", label: 'iPad mini', group: "tablet", width: 744, height: 1133, dpr: 2 },
  { id: "ipad-pro-11", label: 'iPad Pro 11"', group: "tablet", width: 834, height: 1194, dpr: 2 },
  { id: "ipad-pro-13", label: 'iPad Pro 13"', group: "tablet", width: 1024, height: 1366, dpr: 2 },
  // Laptop / desktop
  { id: "laptop", label: "Laptop", group: "laptop", width: 1280, height: 800, dpr: 2 },
  { id: "laptop-l", label: "Laptop L", group: "laptop", width: 1440, height: 900, dpr: 2 },
  { id: "desktop", label: "Desktop", group: "laptop", width: 1920, height: 1080, dpr: 1 },
  // Tailwind breakpoints — the operator is debugging Tailwind.
  { id: "bp-sm", label: "sm · 640", group: "breakpoint", width: 640, height: 900, dpr: 1 },
  { id: "bp-md", label: "md · 768", group: "breakpoint", width: 768, height: 1000, dpr: 1 },
  { id: "bp-lg", label: "lg · 1024", group: "breakpoint", width: 1024, height: 1100, dpr: 1 },
  { id: "bp-xl", label: "xl · 1280", group: "breakpoint", width: 1280, height: 800, dpr: 2 },
  { id: "bp-2xl", label: "2xl · 1536", group: "breakpoint", width: 1536, height: 960, dpr: 1 },
]

export const DEFAULT_DEVICE_ID = "iphone-16-pro"
export const RESPONSIVE_REVIEW_DEVICES = ["iphone-16-pro", "ipad-mini", "laptop"] as const

const FALLBACK_DEVICE_ID = "laptop"

export function deviceById(id: string): DevicePreset {
  return (
    DEVICE_PRESETS.find((d) => d.id === id) ??
    DEVICE_PRESETS.find((d) => d.id === FALLBACK_DEVICE_ID) ??
    DEVICE_PRESETS[0]
  )
}

export const DEVICE_GROUP_LABELS: Record<DeviceGroup, string> = {
  phone: "Phone",
  tablet: "Tablet",
  laptop: "Laptop / desktop",
  breakpoint: "Tailwind breakpoint",
}

/// Pure, size-agnostic decorative chrome tokens for `DeviceChrome`. Never
/// touches the iframe's true `width`×`height` — this only describes the
/// bezel drawn AROUND it (padding is bezel thickness, not a resize).
export type ChromeStyle = {
  /** Outer bezel corner radius (px). 0 = plain rectangle (breakpoints). */
  outerRadius: number
  /** Inner (screen cut-out) corner radius (px). */
  innerRadius: number
  /** Bezel thickness per side (px) — decorative padding around the iframe. */
  padding: { top: number; right: number; bottom: number; left: number }
  /** Phone-style notch pill at the top. */
  notch: boolean
  /** Phone-style home-indicator bar at the bottom. */
  homeIndicator: boolean
  /** Tablet-style front camera dot, centered at the top. */
  cameraDot: boolean
  /** Laptop-style browser-chrome top bar (traffic-light dots). */
  topBar: boolean
  /** `--safe-top`/`--safe-bottom` CSS vars to expose to the iframe content,
   * or null when the device has no safe-area insets to simulate. */
  safeArea: { top: number; bottom: number } | null
}

export function chromeStyleForGroup(group: DeviceGroup): ChromeStyle {
  switch (group) {
    case "phone":
      return {
        outerRadius: 44,
        innerRadius: 32,
        padding: { top: 24, right: 12, bottom: 20, left: 12 },
        notch: true,
        homeIndicator: true,
        cameraDot: false,
        topBar: false,
        safeArea: { top: 24, bottom: 20 },
      }
    case "tablet":
      // Thinner, uniform bezel — no notch, just a small front camera dot.
      return {
        outerRadius: 24,
        innerRadius: 14,
        padding: { top: 14, right: 14, bottom: 14, left: 14 },
        notch: false,
        homeIndicator: false,
        cameraDot: true,
        topBar: false,
        safeArea: null,
      }
    case "laptop":
      // Light-touch: a subtle browser-chrome top bar, flush sides/bottom.
      return {
        outerRadius: 10,
        innerRadius: 4,
        padding: { top: 22, right: 0, bottom: 0, left: 0 },
        notch: false,
        homeIndicator: false,
        cameraDot: false,
        topBar: true,
        safeArea: null,
      }
    case "breakpoint":
    default:
      // Abstract widths, not devices — keep the plain rectangle.
      return {
        outerRadius: 0,
        innerRadius: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        notch: false,
        homeIndicator: false,
        cameraDot: false,
        topBar: false,
        safeArea: null,
      }
  }
}

/// An artboard: one route rendered at one device size. Position persists per
/// project so the canvas layout survives reloads (localStorage keyed by
/// project; canvas geometry is chrome state, not design data).
export type Artboard = {
  /** Stable key: `${route}@${deviceId}` */
  key: string
  route: string
  deviceId: string
  x: number
  y: number
}

export function artboardKey(route: string, deviceId: string): string {
  return `${route}@${deviceId}`
}

export function makeArtboard(route: string, deviceId: string, x: number, y: number): Artboard {
  return { key: artboardKey(route, deviceId), route, deviceId, x, y }
}

/// Lay out every open page as its own ROW, with one COLUMN per selected
/// device — the canvas' actual grid. PURE: same inputs always produce the
/// same boards, in the same order, so callers can memoize on
/// `[openRoutes, deviceIds]` without any other state.
///
/// - One row per `openRoutes` entry, in that order; `y` stacks by the
///   cumulative height of prior rows (the tallest device in each row) plus
///   `gutter`.
/// - One column per `deviceIds` entry, in that order, shared by every row;
///   `x` is the cumulative width of prior columns in the same row plus
///   `gutter`.
export function layoutRows(openRoutes: string[], deviceIds: string[], gutter = 80): Artboard[] {
  const devices = deviceIds.map((id) => deviceById(id))
  const rowHeight = devices.length ? Math.max(...devices.map((d) => d.height)) : 0

  const boards: Artboard[] = []
  let y = 0
  for (const route of openRoutes) {
    let x = 0
    for (const device of devices) {
      boards.push(makeArtboard(route, device.id, x, y))
      x += device.width + gutter
    }
    y += rowHeight + gutter
  }
  return boards
}
