/// The canvas's content epoch: one number that, when it changes, remounts every
/// artboard's frame and reloads its composed document.
///
/// WHY IT IS COALESCED. The epoch is written on EVERY design-file realtime
/// event, and it is part of every frame's key (`design-canvas.tsx` builds
/// `epoch={contentEpoch + boardEpoch}` and `LazyFrame` keys its iframe on it).
/// One event is therefore one remount of EVERY board, each re-running the
/// composer and re-parsing the document — and under Responsive review
/// (`RESPONSIVE_REVIEW_DEVICES`) the same write remounts three devices' worth.
/// An agent writing a page, its tokens and a component in one turn produced that
/// storm three times over, which is the sluggishness this module exists to
/// remove: a burst of writes now commits ONE epoch, once the writes stop.
///
/// WHAT IT DOES NOT DO: scope the invalidation to the routes a write touched.
/// `PUT /api/design/{project}/file` computes exactly that list and answers with
/// it (`affected_routes`, `views.rs`'s `put_file`), but the event that reaches
/// this browser never carries it. Both emitters — `Expose::<DesignFile>` in
/// `backend/src/realtime.rs` and the bulk bridge in
/// `taskflow-design/src/signals.rs` (the path every edit of an EXISTING page
/// takes, via `update_values`) — send an ID-ONLY row, and the SSE frame ships
/// that row verbatim as `d`. So all this side ever learns is "some design file
/// changed", and a per-route remount first needs the payload widened. Until
/// then, coalescing is the whole fix: the remount is indiscriminate either way,
/// and the only lever here is how MANY times it happens.
///
/// The settle itself is `settle-gate` — the same trailing-edge debounce the
/// canvas's pan/zoom uses, imported rather than reimplemented. Two coalescers
/// for one problem is how the next person gets it wrong. What this module adds
/// is the one thing a generic gate cannot know: that the value is a monotonic
/// counter, so a burst's last value is strictly newer than the one before it and
/// a caller cannot push a stale or repeated epoch.
///
/// WHY "LAST WINS" IS SAFE HERE, since the gate replaces what it holds rather
/// than merging it. That default is WRONG for a burst of payloads: a settle that
/// commits the last event of a burst which named affected routes would remount
/// only the last route and silently drop the rest — no error, just fewer boards
/// invalidated than the burst required. The value pushed here is not a payload.
/// It is a monotonically increasing VERSION of the canvas's content, and one
/// version is all a version needs — the newest — because the remount is
/// whole-canvas by construction (see above). There is no set of routes to take
/// the union of, and a counter cannot lose information the way a payload does:
/// every write in the burst still advances it by one, so a burst of three is
/// never mistaken for a burst of one. **If per-route invalidation ever lands,
/// this is the line that changes**: the held value becomes the union of the
/// routes the burst touched, and the gate's replacement semantics stop being
/// safe for it.

import { createSettleGate, type SettleTimers } from "./settle-gate"

/** How long the writes must stop before the epoch commits. Longer than the
 *  wheel burst the gate's own default covers (a trackpad's 8–16ms), because a
 *  "burst" here is a REST write plus its signal round-trip rather than a stream
 *  of input events — an agent's multi-file turn lands over tens to hundreds of
 *  ms. Still short enough that a human's own save shows as their own change
 *  (the frame reload behind it takes longer than this), and a wrong guess here
 *  costs latency, not correctness: the commit always happens. */
export const CONTENT_EPOCH_SETTLE_MS = 200

export type ContentEpoch = {
  /** A design file changed server-side. The epoch commits once the writes stop,
   *  so a burst is one remount rather than one per event. */
  fileChanged(): void
  /** Drop a pending bump without committing it — the subscriber is going away
   *  (project switch, unmount) and a bump landing afterwards would remount a
   *  canvas the human has already left. */
  cancel(): void
  /** Where a bump is delivered. Set it before the first `fileChanged()`: a
   *  settle that fires with no commit set THROWS rather than swallowing the
   *  value (see `settle-gate`). */
  setCommit(commit: (epoch: number) => void): void
}

export function createContentEpoch({
  settleMs = CONTENT_EPOCH_SETTLE_MS,
  timers,
}: {
  settleMs?: number
  /** Injected so a test can drive the window; the app uses the real timers. */
  timers?: SettleTimers
} = {}): ContentEpoch {
  const gate = createSettleGate<number>(timers ? { settleMs, timers } : { settleMs })
  // Counts from 1, and only ever forwards. The value reaches `React` keys, and
  // `LazyFrame` compares it against the epoch stamped on a load FAILURE
  // (`failed.epoch === epoch`), so a value that could repeat would let a retired
  // failure retire a frame it does not belong to.
  let next = 1

  return {
    fileChanged: () => gate.push(next++),
    cancel: () => gate.cancel(),
    setCommit: (commit) => gate.setCommit(commit),
  }
}
