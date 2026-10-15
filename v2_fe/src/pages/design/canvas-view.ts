/// Pure canvas-view math shared by the zoom control's Fit button.
///
/// Kept separate from `design-canvas.tsx` (which owns pan/zoom interaction
/// and rendering) so it can be unit-tested without a DOM.

import { HEADER_H, boardHeight, boardWidth, deviceById } from "@/lib/design-devices"
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
 *
 * The box is the CARDS' footprint, not the boards': `board.{x,y}` is where a
 * card starts, and a card is its header (`HEADER_H`, rendered above the board)
 * followed by the bezel-wrapped board. Measuring the bare device px under-fits
 * every arrangement and the error compounds with the gutters.
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
    maxX = Math.max(maxX, board.x + boardWidth(device))
    maxY = Math.max(maxY, board.y + HEADER_H + boardHeight(device))
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

/// Whether React Flow's move-END should be committed as the canvas transform.
///
/// React Flow fires its move events for PROGRAMMATIC viewport changes too
/// (`setViewport`, `fitView`), with a null `event`, and delays the end by
/// 150ms under `panOnScroll`. A user gesture (`event` set) always commits. A
/// programmatic end commits only while its viewport is STILL the live one: if a
/// newer change has landed since (the stored zoom being restored on reload),
/// the late end describes a view nobody is looking at, and committing it was
/// how a reload snapped the zoom back to the 60% default.
export function shouldCommitMoveEnd(
  event: unknown,
  ended: { x: number; y: number; zoom: number },
  live: { x: number; y: number; zoom: number } | null
): boolean {
  if (event) return true
  if (!live) return true
  return (
    Math.abs(ended.x - live.x) <= 0.5 &&
    Math.abs(ended.y - live.y) <= 0.5 &&
    Math.abs(ended.zoom - live.zoom) <= 0.0005
  )
}
