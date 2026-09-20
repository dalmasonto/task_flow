/// Pure canvas-view math shared by the zoom control's Fit button.
///
/// Kept separate from `design-canvas.tsx` (which owns pan/zoom interaction
/// and rendering) so it can be unit-tested without a DOM.

import { deviceById } from "@/lib/design-devices"
import { MIN_SCALE, MAX_SCALE, type CanvasTransform } from "./design-canvas"

/** A board's world-space placement — just enough to compute a bounding box. */
export type FitBoard = { x: number; y: number; deviceId: string }

export type Viewport = { w: number; h: number }

export type FitOptions = {
  /** Screen-space gutter kept clear around the fitted bounding box, in px. */
  padding?: number
}

const DEFAULT_PADDING = 48

/**
 * Computes the `CanvasTransform` that fits every board's bounding box inside
 * `viewport`, centered, with `scale` clamped to `[MIN_SCALE, MAX_SCALE]`.
 *
 * Matches `design-canvas.tsx`'s render order (`translate(x,y) scale(s)` on
 * an origin-top-left layer): a world point `(wx, wy)` lands on screen at
 * `(x + wx*scale, y + wy*scale)`.
 */
export function fitTransform(
  boards: FitBoard[],
  viewport: Viewport,
  opts: FitOptions = {}
): CanvasTransform {
  const padding = opts.padding ?? DEFAULT_PADDING

  if (boards.length === 0) {
    return { x: viewport.w / 2, y: viewport.h / 2, scale: 1 }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const board of boards) {
    const device = deviceById(board.deviceId)
    minX = Math.min(minX, board.x)
    minY = Math.min(minY, board.y)
    maxX = Math.max(maxX, board.x + device.width)
    maxY = Math.max(maxY, board.y + device.height)
  }

  const bboxW = Math.max(1, maxX - minX)
  const bboxH = Math.max(1, maxY - minY)
  const availW = Math.max(1, viewport.w - padding * 2)
  const availH = Math.max(1, viewport.h - padding * 2)

  const rawScale = Math.min(availW / bboxW, availH / bboxH)
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, rawScale))

  const centerWorldX = (minX + maxX) / 2
  const centerWorldY = (minY + maxY) / 2

  return {
    x: viewport.w / 2 - centerWorldX * scale,
    y: viewport.h / 2 - centerWorldY * scale,
    scale,
  }
}
