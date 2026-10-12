/// Which boards are allowed a LIVE iframe — the live window.
///
/// WHY THIS EXISTS. Boards used to mount on approach and never unmount
/// (`LazyFrame`'s latch, kept for comparison's sake), so a session on a
/// 500-board canvas ended with 500 live documents: one renderer process tree,
/// one page runtime and one scroll position per board seen. The comparisons
/// that latch protected still matter, but "never release" does not scale, so
/// the canvas keeps a BOUNDED set of documents alive and shows everyone else
/// as a snapshot (or a placeholder until one is captured).
///
/// THE SET IS COMPUTED, NOT OBSERVED. `IntersectionObserver` would need one
/// observer per board (500 of them) and answers only "is it intersecting",
/// not "which 24 are nearest" — the budget is a property of the SET, and a set
/// needs one owner. Here that owner is a pure function of geometry the canvas
/// already has: every board's rect, the committed transform, and the viewport
/// size. Pure means the bound is testable without a browser, which is the
/// point — this is the invariant users feel as "the canvas stays fast".
///
/// THE RULES, in the order they apply:
/// 1. Zoomed out below [`MIN_LIVE_SCALE`], NOTHING is live. At that size a
///    page's text is unreadable, so a live document buys nothing at all —
///    every board renders its snapshot (which is why a zoomed-out canvas is
///    cheap even on first visit).
/// 2. Otherwise a board is a candidate while its rect intersects the window
///    expanded by [`LIVE_MARGIN`] viewports — mount-on-approach, kept: a
///    board just off-screen preloads before it is seen.
/// 3. Candidates are ranked by distance from the window's centre and cut to
///    [`LIVE_FRAME_BUDGET`]. Everything nearer wins; the rank is what keeps
///    the OFFICIAL view (the one the human is reading) live while the rest of
///    a dense zoom level goes cold.

/** How many boards may hold a live iframe at once. */
export const LIVE_FRAME_BUDGET = 24

/** Below this canvas scale, no board keeps a live iframe: text is unreadable
 *  at this size, so the whole canvas renders snapshots instead. */
export const MIN_LIVE_SCALE = 0.35

/** How many boards may WAIT for a snapshot capture at any zoom — the nearest
 *  ones to the window centre. Larger than [`LIVE_FRAME_BUDGET`] because a
 *  capture is one-off background work rather than a resident document, and
 *  capped at all because a zoomed-out canvas holds hundreds of boards and a
 *  queue that long is a machine that never drains it. */
export const SNAPSHOT_WINDOW = 48

/** How far past the window a board still counts as approaching, in viewport
 *  sizes. Half a viewport is what the old IntersectionObserver used (150%
 *  rootMargin ≈ 0.5 viewports past each edge). */
export const LIVE_MARGIN = 0.5

export type LiveBoard = {
  key: string
  /** Board rect in canvas world units (React Flow node position and size). */
  x: number
  y: number
  width: number
  height: number
}

export type LiveTransform = { x: number; y: number; scale: number }

export type LiveOptions = {
  budget?: number
  minScale?: number
  margin?: number
}

/** The keys allowed a live iframe, for this transform and viewport. */
export function liveBoardKeys(
  boards: readonly LiveBoard[],
  transform: LiveTransform,
  viewport: { width: number; height: number },
  { budget = LIVE_FRAME_BUDGET, minScale = MIN_LIVE_SCALE, margin = LIVE_MARGIN }: LiveOptions = {},
): Set<string> {
  const { scale } = transform
  if (scale < minScale) return new Set()
  if (viewport.width <= 0 || viewport.height <= 0) return new Set()

  // Screen = world * scale + {x, y} (React Flow's own mapping), so the window
  // in world units is the screen rect divided by the scale. The margin is
  // expressed in SCREEN viewports, hence the /scale here too.
  const left = -transform.x / scale - (margin * viewport.width) / scale
  const top = -transform.y / scale - (margin * viewport.height) / scale
  const right = -transform.x / scale + (viewport.width * (1 + margin)) / scale
  const bottom = -transform.y / scale + (viewport.height * (1 + margin)) / scale

  // Rank from the centre of the VISIBLE window (margin excluded): the nearest
  // board to what the human is actually looking at is the one that must stay
  // live when something has to go cold.
  const centreX = -transform.x / scale + viewport.width / (2 * scale)
  const centreY = -transform.y / scale + viewport.height / (2 * scale)

  const candidates: { key: string; distance: number }[] = []
  for (const board of boards) {
    const hit =
      board.x < right && board.x + board.width > left &&
      board.y < bottom && board.y + board.height > top
    if (!hit) continue
    const dx = board.x + board.width / 2 - centreX
    const dy = board.y + board.height / 2 - centreY
    candidates.push({ key: board.key, distance: dx * dx + dy * dy })
  }
  // Ties break on the key so the same geometry always yields the same set —
  // an unstable live set would remount frames for no reason at all.
  candidates.sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return new Set(candidates.slice(0, budget).map((c) => c.key))
}

/** The keys that were live and are not any more — the boards whose snapshots
 *  the canvas should ask for. Order follows `previous` (Set insertion order),
 *  so a caller that caps its requests per settle drops the oldest first. */
export function newlyColdKeys(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): string[] {
  const cold: string[] = []
  for (const key of previous) if (!next.has(key)) cold.push(key)
  return cold
}
