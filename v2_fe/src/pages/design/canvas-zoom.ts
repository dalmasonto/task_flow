/// The canvas's zoom range, and the step its buttons and its wheel zoom move by.
///
/// A module of its own — no React, no components — because the range is what
/// the canvas's PURE tests assert against: the grid's opacity at the deepest
/// zoom a user can reach (`canvas-paint.test.ts`, which reads them from here).
/// Reading them off `design-canvas` instead is reading them off a component
/// module, which drags React, `lucide-react` and `components/ui/dropdown-menu`
/// into a node test of arithmetic.
///
/// `design-canvas` re-exports all three, so the call sites that read them beside
/// the component — `DesignSurfacePage`, `canvas-view`, `design-ui-state` — are
/// unchanged, and so are the two tests that reach them through it, each in its
/// own way: `canvas-view.test.ts` imports `design-canvas` directly, while
/// `design-ui-state.test.ts` reaches it TRANSITIVELY (through
/// `design-ui-state.ts`'s own import of the two bounds) and never names the
/// component module at all. Both therefore still drag React into a node test of
/// arithmetic, which is the thing this module exists to give them a way out of;
/// either would rather import from here, and can move as it is touched.

/** Deepest zoom out, as a CSS scale factor. Below this the dot grid is gone
 *  entirely (`gridDotOpacity`) — the canvas is a plotting surface, not a page. */
export const MIN_SCALE = 0.25

/** Furthest zoom in. Past this the iframes are scaling bitmaps, not layouts. */
export const MAX_SCALE = 2

/** One press of a zoom button, and one Cmd/Ctrl+wheel notch. */
export const ZOOM_STEP = 1.1
