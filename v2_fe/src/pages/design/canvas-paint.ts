/// The two expressions the canvas PAINTS — shared by the JSX that renders the
/// canvas and by the imperative paint that runs while a gesture is in flight.
///
/// They are shared rather than written twice because the gap between them is
/// invisible until it bites: mid-gesture the imperative paint is the only thing
/// writing these, so a painter that formatted its own string (a rounded
/// coordinate, a `Math.max(0, ...)` left out) would disagree with the JSX the
/// very next render writes, and the canvas would jump the moment the gesture
/// settled. One expression, two callers.

import type { CanvasTransform } from "./design-canvas"

/** The panning layer's CSS transform. The layer is `origin-top-left` and the
 *  order is translate-then-scale, which is what `fitTransform` in
 *  `canvas-view.ts` is computed against: a world point lands on screen at
 *  `(x + wx*scale, y + wy*scale)`. */
export function transformCss(t: CanvasTransform): string {
  return `translate(${t.x}px, ${t.y}px) scale(${t.scale})`
}

/** The dot grid's opacity at a zoom: full at 50% and above, fading out to
 *  nothing at 30%, floored at 0 — the grid is a plotting surface, not a page,
 *  and it must be gone (not merely transparent-if-lucky) at the low end. */
export function gridDotOpacity(scale: number): number {
  return scale >= 0.5 ? 0.55 : Math.max(0, (scale - 0.3) * 1.8)
}
