/// What the canvas PAINTS and WHAT it paints from — the two expressions shared
/// by the JSX that renders the canvas and by the imperative paint that runs
/// while a gesture is in flight, and the one rule that picks the value they
/// paint when the live gesture and the committed prop disagree.
///
/// The expressions are shared rather than written twice because the gap between
/// them is invisible until it bites: mid-gesture the imperative paint is the
/// only thing writing these, so a painter that formatted its own string (a
/// rounded coordinate, a `Math.max(0, ...)` left out) would disagree with the
/// JSX the very next render writes, and the canvas would jump the moment the
/// gesture settled. One expression, two callers.
///
/// `resolveLive` is here for the same reason from the other side: it is the
/// decision of WHICH transform is painted — three inputs wide, the shape that
/// reads as obvious inline and is not — and it was walked by hand and never
/// pinned. Both halves of it are tests (`canvas-paint.test.ts`) — they went in
/// with the fix that extracted this rule, before this comment, and the comment
/// they replaced claimed a bug no committed revision shows — which is the whole
/// of the claim: a rule that lived in render sequences somebody had to hold in
/// their head is a rule nothing could fail for.

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

/** Which transform the canvas should hold and paint: the gesture's LIVE value,
 *  or the `transform` prop this render was handed.
 *
 *  `pending` is the settle gate's answer to "is a gesture still in flight", so
 *  the whole rule is:
 *
 *    !pending && prop !== live  →  prop   (nothing in flight: the prop is truth)
 *    otherwise                  →  live
 *
 *  Both halves are load-bearing, and both have to be:
 *
 *  * Nothing in flight means the prop IS the truth — its own commit, Fit, a
 *    zoom button, a viewport restored from Dexie — and the live ref must follow
 *    it. A rule that always kept the live value makes every one of those
 *    invisible: the canvas would paint the new value for one render and then the
 *    old one, and the next gesture would pan from a position the canvas is not at.
 *  * A gesture in flight means the live value is the truth even when the prop is
 *    a genuine foreign write, not a stale one. React re-asserts the prop on the
 *    layer element itself on every render, so adopting it mid-gesture drags the
 *    canvas somewhere else under a moving finger; worse, the gesture's own
 *    accumulator (the pan anchor, the wheel zoom's live scale) continues from a
 *    position the hand never chose. The external write is left to the settle,
 *    which lands within ~120ms and commits the gesture.
 *
 *  The comparison is identity, not value: the same object is the same view, and
 *  a deep compare would cost a comparison per render and decide nothing (an
 *  equal-valued prop is adopted when idle, which is a no-op for the value). */
export function resolveLive<T>(pending: boolean, prop: T, live: T): T {
  return !pending && prop !== live ? prop : live
}
