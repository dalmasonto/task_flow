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

/// Lay out artboards in a row with a gutter that scales with the tallest
/// neighbour, so cards never overlap at any zoom.
export function rowLayout(devices: DevicePreset[], startX = 0, startY = 0): Artboard[] {
  let cursorX = startX
  return devices.map((device) => {
    const board = makeArtboard("/", device.id, cursorX, startY)
    cursorX += device.width + 80
    return board
  })
}
