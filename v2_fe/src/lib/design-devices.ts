import { canvasFrame, canvasFrameMode } from "./design-frames"
import { resolveRouteOrder, type LayoutDoc, type LayoutGroup } from "./design-layout"

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

/** What `landscapeId` appends to a device id — and what `landscapeVariant`
 *  rejects, so a variant can never be rotated into a second one. One spelling,
 *  because those two must agree: a guard that silently stopped matching would
 *  let undeclared `${id}:landscape:landscape` ids back out. */
const LANDSCAPE_SUFFIX = ":landscape"

/** Id of a device's landscape variant. */
export function landscapeId(deviceId: string): string {
  return `${deviceId}${LANDSCAPE_SUFFIX}`
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
///
/// Total by design: it can never emit an id that is not a declared preset. A
/// variant has no landscape of its own — swapping it back would be portrait,
/// not landscape — and `${id}:landscape:landscape` is not a device at all:
/// `deviceById` resolves it to the laptop fallback, so two boards would collide
/// on one key while one of them rendered a laptop, and the stored-id filter
/// would drop it on reload. The caller is therefore never handed an undeclared
/// id to trust.
export function landscapeVariant(device: DevicePreset): DevicePreset | null {
  // Already landscape: rotating again would build `${id}:landscape:landscape`,
  // an id no preset declares — `deviceById` would fall back to a laptop, so two
  // different boards would collide on one key while one renders the wrong
  // device. The helper must be total; a caller guard is defence, not the fix.
  if (device.id.endsWith(LANDSCAPE_SUFFIX)) return null
  if (device.group !== "phone" && device.group !== "tablet") return null
  return {
    ...device,
    id: landscapeId(device.id),
    label: `${device.label} ↻`,
    width: device.height,
    height: device.width,
  }
}

/// Why the header's Rotate item can add nothing, in the item's own words.
export type RotateBlocked = "no landscape form" | "already on canvas"

/// What the canvas's Rotate action would ADD, or why it can add nothing.
///
/// Rotate is a duplicate at the same device's landscape preset, so it obeys the
/// rule the "Duplicate at another device" submenu already applies (`otherDevices`
/// filters out the devices on the canvas): a device that is already there cannot
/// be added again. Without the second check the item stays ENABLED, still reads
/// "Add iPhone 15/16 ↻ — 852×393", and the click does nothing at all —
/// `handleDuplicateBoard` skips a device that is already selected — so the row
/// promises an action the canvas refuses, with no explanation.
///
/// Here rather than in `design-canvas.tsx` because it is the same kind of fact
/// as `landscapeVariant`: a rule about the preset table, needing neither React
/// nor the canvas to decide.
export function rotateDecisionFor(
  device: DevicePreset,
  deviceIds: string[]
): { kind: "add"; device: DevicePreset } | { kind: "blocked"; reason: RotateBlocked } {
  const target = landscapeVariant(device)
  if (!target) return { kind: "blocked", reason: "no landscape form" }
  if (deviceIds.includes(target.id)) return { kind: "blocked", reason: "already on canvas" }
  return { kind: "add", device: target }
}

// Landscape variants live in the preset table so `deviceById`, the layout
// engines, the device picker and `design-ui-state`'s stored-id filter all
// resolve them with no special case. Built from the portrait entries, so the
// two can never disagree about a device's dimensions.
//
// The loop expands a COPY: pushing into the array being iterated would let the
// loop consume the variants it is producing. `landscapeVariant` also refuses to
// nest a variant, so this cannot run away even if the copy were dropped — but
// the loop does not lean on that guard to terminate, and a variant must never
// be input to the expansion in the first place.
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


/** How wide a board actually renders. In `device` mode a real device wears its
 *  open-source frame, scaled so the frame's screen is the device's CSS width
 *  (`lib/design-frames`); in `classic` mode it wears the simple bezel
 *  (`classicChrome`); otherwise — `outline` mode, or a breakpoint width, which
 *  is no device — the page sits in a 1px rounded outline.
 *  Every layout engine spaces boards by this, so it must be what renders. */
export function boardWidth(device: DevicePreset): number {
  const framed = canvasFrame(device)
  if (framed) return Math.round(framed.metrics.w * framed.scale)
  const chrome = classicChrome(device)
  if (chrome) return device.width + chrome.padding.left + chrome.padding.right + CHROME_BORDER * 2
  return device.width + OUTLINE_BORDER * 2
}

/** How tall a board actually renders (see `boardWidth`). */
export function boardHeight(device: DevicePreset): number {
  const framed = canvasFrame(device)
  if (framed) return Math.round(framed.metrics.h * framed.scale)
  const chrome = classicChrome(device)
  if (chrome) return device.height + chrome.padding.top + chrome.padding.bottom + CHROME_BORDER * 2
  return device.height + OUTLINE_BORDER * 2
}

/** Where the PAGE's top-left sits inside a board (header included), in canvas
 *  px — what turns a position a frame reports (a picked element, a comment's
 *  anchor) into a place on the canvas. The page renders 1:1 on every board, so
 *  this is an offset only. In a device frame the page starts BELOW the status
 *  bar — #632: the export's geometry (`export-plan.captureViewport`), so the
 *  canvas, a download and a screenshot frame a page identically — so its origin
 *  is the screen's corner plus the strip. With classic chrome the origin is the
 *  bezel's padding plus border, and in an outline it is the border alone. */
export function boardContentOrigin(device: DevicePreset): { x: number; y: number } {
  const framed = canvasFrame(device)
  if (framed) {
    const { metrics, scale } = framed
    return { x: metrics.screenX * scale, y: HEADER_H + (metrics.screenY + metrics.statusBar) * scale }
  }
  const chrome = classicChrome(device)
  if (chrome) return { x: CHROME_BORDER + chrome.padding.left, y: HEADER_H + CHROME_BORDER + chrome.padding.top }
  return { x: OUTLINE_BORDER, y: HEADER_H + OUTLINE_BORDER }
}

/// The canvas's original chrome (`ClassicBoard`), kept as the `classic` frame
/// mode because its plainness reads well: a black bezel drawn AROUND the page,
/// never resizing it (padding is bezel thickness). Phones get a notch pill and
/// a home indicator, tablets a camera dot, laptops and desktops a window bar.
export type ChromeStyle = {
  /** Outer bezel corner radius (px). */
  outerRadius: number
  /** Inner (screen cut-out) corner radius (px). */
  innerRadius: number
  /** Bezel thickness per side (px). */
  padding: { top: number; right: number; bottom: number; left: number }
  notch: boolean
  homeIndicator: boolean
  cameraDot: boolean
  /** A window bar with three dots across the top. */
  topBar: boolean
}

export function chromeStyleForGroup(group: Exclude<DeviceGroup, "breakpoint">): ChromeStyle {
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
      }
    case "tablet":
      return {
        outerRadius: 24,
        innerRadius: 14,
        padding: { top: 14, right: 14, bottom: 14, left: 14 },
        notch: false,
        homeIndicator: false,
        cameraDot: true,
        topBar: false,
      }
    case "laptop":
      return {
        outerRadius: 10,
        innerRadius: 4,
        padding: { top: 22, right: 0, bottom: 0, left: 0 },
        notch: false,
        homeIndicator: false,
        cameraDot: false,
        topBar: true,
      }
  }
}

/// The classic chrome a board wears, or null when `classic` is not the mode
/// or the device is a breakpoint width (no device, so the plain outline).
export function classicChrome(device: DevicePreset): ChromeStyle | null {
  if (canvasFrameMode() !== "classic" || device.group === "breakpoint") return null
  return chromeStyleForGroup(device.group)
}

/** The 1px border `ClassicBoard` draws around its bezel. */
export const CHROME_BORDER = 1

/** The border of a frameless board (`OutlineBoard`): the page in a 1px,
 *  softly rounded outline — frames off, or a breakpoint width. */
export const OUTLINE_BORDER = 1

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
/// `openRoutes` is positional here as it is in the other two engines, and the
/// order it arrives in does two jobs: it is the order of the ungrouped tail, and
/// it is the order of the pages INSIDE each column — a column is that group's
/// open pages, ordered by their position in `openRoutes`. The caller that
/// matters (`boardsForView`) hands it the user's flow, so a column reads down in
/// the same sequence the panel lists, and the pages the flow does not name keep
/// the caller's own order. With NO flow set — every project's first state — that
/// means a column reads in the pages' own order, deliberately not in `g.routes`,
/// which is ASSIGNMENT order (`assignRoute` appends) and would reshuffle a
/// column's existing pages the moment one more page was grouped into it. The
/// COLUMNS themselves are the document's group order and are never sorted by it:
/// the arrangement the user picked is what this view is for — §F's "The canvas
/// layout never reflows" is stated about a link click, and this phase reads it
/// the same way for every edit that is not an explicit reorder.
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
  /// Where each open page sits in the order this engine was handed. Every route
  /// a column can hold is open (it is filtered against `openRoutes`), so every
  /// survivor of that filter has an index — the `?? 0` is for the type, not for
  /// a case.
  const position = new Map(openRoutes.map((route, i) => [route, i]))

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
    const columns: string[][] = groups.map((g) =>
      g.routes
        .filter((r) => openRoutes.includes(r))
        .sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)),
    )
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
///
/// The order the boards are drawn in is the document's FLOW — `routeOrder`, the
/// sequence the user built by moving pages up and down in the Pages panel —
/// resolved over the open pages by `resolveRouteOrder`. Resolving it here, at
/// the one entry point, is what makes all three arrangements agree: `rows` and
/// `bands` lay the boards out in the sequence they are given, and `groups` uses
/// it for the pages inside each column.
///
/// An explicit reorder is the ONE edit that moves boards, and the flow is
/// deliberately not the same thing as the panel's listing: grouping a page
/// changes where it is listed and never touches `routeOrder`, so a grouping edit
/// leaves these boards exactly where they were. The two edits look alike from
/// the outside — a page's position on screen changes in both — which is why they
/// are separated here rather than left to look the same.
export function boardsForView(
  doc: LayoutDoc,
  openRoutes: string[],
  deviceIds: string[],
): Artboard[] {
  // Resolved against the OPEN pages, so a flow written when more (or other)
  // pages were open still describes a sequence of exactly the boards on screen:
  // the pages it names come first, in its order, and the ones it does not name
  // keep the order `openRoutes` arrives in — its manifest order.
  const ordered = resolveRouteOrder(doc, openRoutes)
  switch (doc.view) {
    case "bands":
      return layoutBands(ordered, deviceIds)
    case "groups":
      return layoutGroups(ordered, deviceIds, doc.groups)
    // `rows` and anything unrecognised: a document written by a newer build
    // must still render *something* rather than blanking the canvas.
    case "rows":
    default:
      return layoutRows(ordered, deviceIds)
  }
}
