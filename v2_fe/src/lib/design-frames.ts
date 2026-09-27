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
  "iphone-8": { w: 419, h: 871, screenX: 22, screenY: 102, screenW: 375, screenH: 667, statusBar: 0 },
  "google-pixel-6-pro": { w: 404, h: 862, screenX: 14, screenY: 20, screenW: 376, screenH: 816, statusBar: 26 },
  "galaxy-s8": { w: 380, h: 828, screenX: 10, screenY: 53, screenW: 360, screenH: 740, statusBar: 20 },
  "ipad-pro": { w: 560, h: 778, screenX: 27, screenY: 27, screenW: 506, screenH: 724, statusBar: 0 },
  "macbook-pro": { w: 740, h: 434, screenX: 70, screenY: 9, screenW: 600, screenH: 375, statusBar: 0 },
  imac: { w: 640, h: 540, screenX: 16, screenY: 16, screenW: 608, screenH: 342, statusBar: 0 },
}

/// A device's frame and the scale that makes the frame's screen exactly as
/// wide as the device — or null for a device with no frame.
export function canvasFrame(device: DevicePreset): { frame: string; metrics: FrameMetrics; scale: number } | null {
  const frame = frameFor(device.id)
  const metrics = frame ? FRAME_METRICS[frame] : undefined
  if (!frame || !metrics) return null
  return { frame, metrics, scale: device.width / metrics.screenW }
}

/// The page's viewport height inside a framed board: the frame's screen below
/// its status bar, at the canvas scale. Close to the preset's height — a real
/// phone loses the same strip to its status bar.
export function framedViewportHeight(device: DevicePreset): number {
  const f = canvasFrame(device)
  if (!f) return device.height
  return Math.round((f.metrics.screenH - f.metrics.statusBar) * f.scale)
}
