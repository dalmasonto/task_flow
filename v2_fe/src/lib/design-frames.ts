/// The open-source device frames (devices.css, MIT) the design surface draws a
/// page in — on the canvas, in the Flow view and in exports.
///
/// On the CANVAS a frame is scaled so its screen is exactly the device's CSS
/// width: the page inside renders 1:1, so its breakpoints are honest, text is
/// the size it always was, and a picked element's position needs only an
/// offset (`frameContentOrigin`), never a scale.

import type { DevicePreset } from "./design-devices"

/// The frame each real device wears. A Tailwind breakpoint is a width, not a
/// device, so it has none and keeps the canvas's plain chrome.
const FRAMES: Record<string, string> = {
  "iphone-se": "iphone-8",
  "iphone-16-pro": "iphone-14-pro",
  "iphone-16-pro-max": "iphone-14-pro",
  "pixel-8": "google-pixel-6-pro",
  "galaxy-s24": "galaxy-s8",
  "ipad-mini": "ipad-pro",
  "ipad-pro-11": "ipad-pro",
  "ipad-pro-13": "ipad-pro",
  laptop: "macbook-pro",
  "laptop-l": "macbook-pro",
  desktop: "imac",
}

export function frameFor(deviceId: string): string | null {
  return FRAMES[deviceId] ?? null
}

/// Each frame's measurements from devices.css, in its own CSS px: the whole
/// device box, where its screen sits in that box, the screen's size, and the
/// status-bar strip at the top of the screen that a notch or Dynamic Island
/// sits in (kept clear, so a page's header is never under the island).
export type FrameMetrics = {
  w: number
  h: number
  screenX: number
  screenY: number
  screenW: number
  screenH: number
  statusBar: number
}

export const FRAME_METRICS: Record<string, FrameMetrics> = {
  "iphone-14-pro": { w: 428, h: 868, screenX: 20, screenY: 20, screenW: 390, screenH: 830, statusBar: 44 },
  "iphone-8": { w: 419, h: 871, screenX: 22, screenY: 102, screenW: 375, screenH: 667, statusBar: 20 },
  "google-pixel-6-pro": { w: 404, h: 862, screenX: 14, screenY: 20, screenW: 376, screenH: 816, statusBar: 26 },
  "galaxy-s8": { w: 380, h: 828, screenX: 10, screenY: 53, screenW: 360, screenH: 740, statusBar: 20 },
  "ipad-pro": { w: 560, h: 778, screenX: 27, screenY: 27, screenW: 506, screenH: 724, statusBar: 0 },
  "macbook-pro": { w: 740, h: 434, screenX: 70, screenY: 9, screenW: 600, screenH: 375, statusBar: 0 },
  imac: { w: 640, h: 540, screenX: 16, screenY: 16, screenW: 608, screenH: 342, statusBar: 0 },
}

/// What the canvas draws around each page — the toolbar's Frames / Classic
/// toggles:
/// - `device`: the realistic open-source frames below.
/// - `classic`: the canvas's original, simpler chrome — a black bezel with a
///   notch pill, camera dot or window bar (`classicChrome` in design-devices).
/// - `outline`: no device at all, the page in a plain rounded outline.
/// A module setting rather than a parameter because every board-size rule
/// (`boardWidth`, `boardHeight`, the layout engines, fit) reads it; the surface
/// sets it before deriving its boards and lists it in their memo deps.
export type CanvasFrameMode = "device" | "classic" | "outline"

let frameMode: CanvasFrameMode = "device"

export function setCanvasFrameMode(mode: CanvasFrameMode): void {
  frameMode = mode
}

export function canvasFrameMode(): CanvasFrameMode {
  return frameMode
}

/// A device's frame and the scale that makes the frame's screen exactly as
/// wide as the device — or null when device frames are not the mode or the
/// device has none.
export function canvasFrame(device: DevicePreset): { frame: string; metrics: FrameMetrics; scale: number } | null {
  if (frameMode !== "device") return null
  const frame = frameFor(device.id)
  const metrics = frame ? FRAME_METRICS[frame] : undefined
  if (!frame || !metrics) return null
  return { frame, metrics, scale: device.width / metrics.screenW }
}

/// How many frame pixels a device frame must grow so a FULL-PAGE shot fits its
/// screen below the status bar (0 when the shot fits). The shot is shown at the
/// screen's width, so its height scales by `screenW / shot.width`. devices.css
/// positions every frame part from the frame's top or bottom edge, so growing
/// the frame, its inner frame and its screen by this much stretches the phone
/// without moving its buttons, notch or home bar.
export function frameStretch(metrics: FrameMetrics, shot: { width: number; height: number }): number {
  if (shot.width <= 0) return 0
  const shown = (shot.height * metrics.screenW) / shot.width
  const room = metrics.screenH - metrics.statusBar
  return Math.max(0, Math.ceil(shown - room))
}

/// The page's viewport height inside a framed board: the frame's screen below
/// its status bar, at the canvas scale. Close to the preset's height — a real
/// phone loses the same strip to its status bar.
export function framedViewportHeight(device: DevicePreset): number {
  const f = canvasFrame(device)
  if (!f) return device.height
  return Math.round((f.metrics.screenH - f.metrics.statusBar) * f.scale)
}

/// How a device lays out its status bar — each follows its platform:
/// - `ios-island`: time left; signal, Wi-Fi, battery right (Dynamic Island).
/// - `ios-classic`: signal and Wi-Fi left, time centred, battery right (the
///   home-button iPhones, iPhone SE).
/// - `android`: time left; Wi-Fi, signal and battery with its percentage right.
export type StatusBarStyle = "ios-island" | "ios-classic" | "android"

const STATUS_STYLE: Record<string, StatusBarStyle> = {
  "iphone-14-pro": "ios-island",
  "iphone-8": "ios-classic",
  "google-pixel-6-pro": "android",
  "galaxy-s8": "android",
}

export function statusBarStyle(frame: string): StatusBarStyle | null {
  return STATUS_STYLE[frame] ?? null
}

const signal = (ink: string) =>
  `<svg width="18" height="12" viewBox="0 0 18 12" fill="${ink}"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>`
const wifi = (ink: string) =>
  `<svg width="16" height="12" viewBox="0 0 16 12" fill="${ink}"><path d="M8 11.5 10.4 9a3.4 3.4 0 0 0-4.8 0Z"/><path d="M8 5.2a6.6 6.6 0 0 1 4.6 1.9l1.3-1.3a8.4 8.4 0 0 0-11.8 0l1.3 1.3A6.6 6.6 0 0 1 8 5.2Z"/><path d="M8 1.6c2.8 0 5.3 1.1 7.2 2.9L16 3.6A12 12 0 0 0 0 3.6l.8.9A10.2 10.2 0 0 1 8 1.6Z"/></svg>`
const iosBattery = (ink: string) =>
  `<svg width="26" height="12" viewBox="0 0 26 12" fill="none"><rect x="0.5" y="0.5" width="22" height="11" rx="3" stroke="${ink}" opacity="0.4"/><rect x="2" y="2" width="17" height="8" rx="1.6" fill="${ink}"/><rect x="24" y="4" width="1.5" height="4" rx="0.7" fill="${ink}" opacity="0.5"/></svg>`
const androidBattery = (ink: string) =>
  `<svg width="9" height="14" viewBox="0 0 9 14" fill="${ink}"><rect x="2.5" y="0" width="4" height="1.6" rx="0.5"/><rect x="0" y="1.4" width="9" height="12.6" rx="1.4"/></svg>`

/// The status bar a device shows, as self-contained HTML (inline styles only,
/// so no stylesheet — devices.css's included — can re-lay it out). The canvas
/// and the export both render exactly this, so the two cannot drift.
export function statusBarHtml(style: StatusBarStyle, width: number, height: number, ink: string): string {
  const row = "display:flex;align-items:center"
  const base = `${row};justify-content:space-between;box-sizing:border-box;width:${width}px;height:${height}px;color:${ink};font-family:'Inter Variable',Inter,system-ui,sans-serif;font-weight:600;letter-spacing:-0.01em;white-space:nowrap`
  switch (style) {
    case "ios-island":
      return `<div style="${base};padding:0 30px 0 36px;font-size:15px"><span>9:41</span><span style="${row};gap:6px">${signal(ink)}${wifi(ink)}${iosBattery(ink)}</span></div>`
    case "ios-classic":
      // Smaller, and three-part: the time is centred between the two sides.
      return `<div style="${base};padding:0 6px;font-size:12px"><span style="${row};gap:4px;flex:1">${signal(ink)}${wifi(ink)}</span><span>9:41</span><span style="${row};justify-content:flex-end;gap:4px;flex:1">100%${iosBattery(ink)}</span></div>`
    case "android":
      return `<div style="${base};padding:0 18px;font-size:13px;font-weight:500"><span>9:41</span><span style="${row};gap:6px">${wifi(ink)}${signal(ink)}<span style="${row};gap:3px">100%${androidBattery(ink)}</span></span></div>`
  }
}
