import type { LayoutDoc, LayoutGroup } from "./design-layout"

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

/** Id of a device's landscape variant. */
export function landscapeId(deviceId: string): string {
  return `${deviceId}:landscape`
}

/// A rotated rendering of a device: the SAME device, rendered at swapped
/// dimensions. Phones and tablets only — a laptop is not a portrait device, and
/// a Tailwind breakpoint is a width rather than a device, so rotating either
/// produces a size that means nothing.
///
/// This is a real preset rather than a per-board flag precisely because the
/// iframe must render at true pixel dimensions: rotating therefore IS a
/// breakpoint change, and giving it its own preset makes that visible instead
/// of hiding it. Returns null when the device has no meaningful landscape form.
export function landscapeVariant(device: DevicePreset): DevicePreset | null {
  if (device.group !== "phone" && device.group !== "tablet") return null
  return {
    ...device,
    id: landscapeId(device.id),
    label: `${device.label} ↻`,
    width: device.height,
    height: device.width,
  }
}

// Landscape variants live in the preset table so `deviceById`, the layout
// engines, the device picker and `design-ui-state`'s stored-id filter all
// resolve them with no special case. Built from the portrait entries, so the
// two can never disagree about a device's dimensions.
//
// Iterating a COPY is load-bearing: pushing into the array being iterated would
// have the loop consume the variants it is producing (`a:landscape` is a phone,
// so it would spawn `a:landscape:landscape`, forever).
for (const preset of [...DEVICE_PRESETS]) {
  const variant = landscapeVariant(preset)
  if (variant) DEVICE_PRESETS.push(variant)
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

/// An artboard: one route rendered at one device size. Position is derived,
/// not persisted — the `layout*` functions recompute x/y from the open routes
/// and selected devices on every render, so the canvas geometry is chrome
/// state, not design data.
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

/** Screen-space gap between two boards. Wide enough that a board's header —
 *  the route name plus its action buttons — cannot reach the next board. */
export const GUTTER = 140

/** Height of the per-board header row (`ArtboardHeader`): 22px of content —
 *  `p-1` buttons around `size-3.5` icons — plus its `mb-2` gap, so 30px of
 *  normal flow above the board. It renders ABOVE the board, so every stacking
 *  calculation has to add it: the board's own height does not include it, and a
 *  row that only cleared the board would put the next row's header *inside*
 *  this one's frame. */
export const HEADER_H = 30

/** The 1px border `DeviceChrome` draws around the bezel. */
const CHROME_BORDER = 1

/** How wide a board actually renders: the iframe's true device px plus the
 *  decorative bezel and border around it. Phone bezels are 12px a side, so a
 *  phone board is 26px wider than `device.width` — the old layout maths used
 *  the bare width and quietly overlapped neighbours. */
export function boardWidth(device: DevicePreset): number {
  const padding = chromeStyleForGroup(device.group).padding
  return device.width + padding.left + padding.right + CHROME_BORDER * 2
}

/** How tall a board actually renders (see `boardWidth`). */
export function boardHeight(device: DevicePreset): number {
  const padding = chromeStyleForGroup(device.group).padding
  return device.height + padding.top + padding.bottom + CHROME_BORDER * 2
}

/// Today's arrangement: one ROW per page, one COLUMN per selected device.
/// PURE: same inputs always produce the same boards, in the same order, so
/// callers can memoize on `[openRoutes, deviceIds]`.
export function layoutRows(openRoutes: string[], deviceIds: string[], gutter = GUTTER): Artboard[] {
  const devices = deviceIds.map((id) => deviceById(id))
  const rowHeight = devices.length ? Math.max(...devices.map(boardHeight)) : 0

  const boards: Artboard[] = []
  let y = 0
  for (const route of openRoutes) {
    let x = 0
    for (const device of devices) {
      boards.push(makeArtboard(route, device.id, x, y))
      x += boardWidth(device) + gutter
    }
    y += HEADER_H + rowHeight + gutter
  }
  return boards
}

/// The transpose of `layoutRows`: one BAND per device, that device's pages
/// running left→right across the band, the next device's band below it. Lets
/// you read one device's whole flow in a single line.
export function layoutBands(openRoutes: string[], deviceIds: string[], gutter = GUTTER): Artboard[] {
  const boards: Artboard[] = []
  let y = 0
  for (const deviceId of deviceIds) {
    const device = deviceById(deviceId)
    let x = 0
    for (const route of openRoutes) {
      boards.push(makeArtboard(route, deviceId, x, y))
      x += boardWidth(device) + gutter
    }
    y += HEADER_H + boardHeight(device) + gutter
  }
  return boards
}

/// The free-form arrangement: still one band per device, but within a band each
/// named group is a vertical COLUMN of its pages, and pages in no group flow
/// right of every group column.
///
/// Ungrouped pages deliberately stay on ONE row (no wrapping): the band grows
/// wider rather than deeper. Balanced packing of a long ungrouped tail is a
/// real design choice and is deferred — see the spec's §C.
export function layoutGroups(
  openRoutes: string[],
  deviceIds: string[],
  groups: LayoutGroup[],
  gutter = GUTTER,
): Artboard[] {
  const grouped = new Set(groups.flatMap((g) => g.routes))
  const ungrouped = openRoutes.filter((r) => !grouped.has(r))

  const boards: Artboard[] = []
  let y = 0

  for (const deviceId of deviceIds) {
    const device = deviceById(deviceId)
    const columnStep = boardWidth(device) + gutter
    const rowStep = HEADER_H + boardHeight(device) + gutter

    // One column per group (document order), then the ungrouped tail — each
    // ungrouped page its own one-board column, so the tail stays on the band's
    // top row instead of stacking. A column with nothing open takes no space,
    // so no phantom gap appears.
    const columns: string[][] = groups.map((g) => g.routes.filter((r) => openRoutes.includes(r)))
    for (const route of ungrouped) columns.push([route])

    let x = 0
    let bandHeight = 0
    for (const routes of columns) {
      if (!routes.length) continue
      for (let i = 0; i < routes.length; i++) {
        boards.push(makeArtboard(routes[i], deviceId, x, y + i * rowStep))
      }
      // The deepest board's BOTTOM, as a footprint measured from the band's
      // top: `n - 1` full row steps down to the last board, plus that board's
      // header and height. This is a footprint, not an advance — the
      // `y += bandHeight + gutter` below is what supplies the inter-band
      // gutter. Writing it as `n * (HEADER_H + h)` instead drops those `n - 1`
      // gutters, which touches the next band against a two-board column (no
      // gap where every other pair of bands gets a gutter) and overlaps a
      // three-board one by a whole gutter.
      bandHeight = Math.max(bandHeight, (routes.length - 1) * rowStep + HEADER_H + boardHeight(device))
      x += columnStep
    }
    y += bandHeight + gutter
  }

  return boards
}

/// The single entry point the surface calls: turn the arrangement document plus
/// the user's open pages and devices into positioned boards. Everything
/// downstream (canvas, selection, pins, focus) is keyed on `route@device` and
/// does not care which arrangement produced them.
export function boardsForView(
  doc: LayoutDoc,
  openRoutes: string[],
  deviceIds: string[],
): Artboard[] {
  switch (doc.view) {
    case "bands":
      return layoutBands(openRoutes, deviceIds)
    case "groups":
      return layoutGroups(openRoutes, deviceIds, doc.groups)
    // `rows` and anything unrecognised: a document written by a newer build
    // must still render *something* rather than blanking the canvas.
    case "rows":
    default:
      return layoutRows(openRoutes, deviceIds)
  }
}
