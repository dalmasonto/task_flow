/// The canvas's content invalidation: what to remount when a design file
/// changes server-side, coalesced per burst.
///
/// WHAT IT CARRIES. A commit is a [`ContentChange`]: a monotonic `epoch` and
/// the `routes` whose render changed — or `null` for "every board", which is
/// what an event that cannot be scoped must produce (an older backend mid
/// deploy, a payload this build does not know). `routes` is a SET, and an
/// EMPTY set is a real answer — "nothing renders this file" (a component
/// delete that was allowed only because no page used it) — distinct from
/// `null`'s "unknown". Collapsing those two either remounts the whole canvas
/// per unused-component edit, or leaves a real change stale.
///
/// WHY IT IS COALESCED. The epoch is written on EVERY design-file realtime
/// event, and it is part of every frame's key (`design-canvas.tsx` builds
/// `epoch={contentEpoch + boardEpoch}`). One event is therefore one remount of
/// every board it names — and under Responsive review
/// (`RESPONSIVE_REVIEW_DEVICES`) the same write remounts three devices' worth.
/// An agent writing a page, its tokens and a component in one turn produced
/// that storm three times over, which is the sluggishness this module exists to
/// remove: a burst of writes now commits ONE change, once the writes stop.
///
/// THE UNION IS THE PART THAT IS EASY TO GET WRONG. The settle gate REPLACES
/// the value it holds (that is the right default for a stream of live values),
/// so a settle that committed only the burst's LAST event would remount one
/// route of the three the burst named — no error, just fewer boards
/// invalidated than the writes required. The union is therefore accumulated
/// HERE, before the gate, and each push carries the running union; the last
/// push of a burst is the whole burst. This is the change the module's own
/// earlier docs promised ("if per-route invalidation ever lands, this is the
/// line that changes") — it landed with #665, together with the widened
/// payload (`{id, version, path, affected_routes}`, `backend`'s
/// `taskflow_design::signals`), which is what lets the surface know the scope
/// at all.
///
/// THE EPOCH STILL COUNTS WRITES, not commits. It is monotonic (counts from 1,
/// only forwards) because it reaches React keys and `LazyFrame` compares it
/// against the epoch stamped on a load FAILURE (`failed.epoch === epoch`), so a
/// value that could repeat would let a retired failure retire a frame it does
/// not belong to. One version is all a version needs — the newest — which is
/// why the gate's replacement of the EPOCH is safe even though replacement of
/// the ROUTE SET was not: a burst of three still moves the counter three times,
/// so no two commits can collide on one epoch.
///
/// The settle itself is `settle-gate` — the same trailing-edge debounce the
/// canvas's pan/zoom uses, imported rather than reimplemented. Two coalescers
/// for one problem is how the next person gets it wrong. What this module adds
/// is the two things a generic gate cannot know: that the value is a version
/// (so the newest is the only one worth committing), and that the routes are a
/// set to union rather than a value to overwrite.

import { artboardKey } from "@/lib/design-devices"

import { createSettleGate, type SettleTimers } from "./settle-gate"

/** How long the writes must stop before the change commits. Longer than the
 *  wheel burst the gate's own default covers (a trackpad's 8–16ms), because a
 *  "burst" here is a REST write plus its signal round-trip rather than a stream
 *  of input events — an agent's multi-file turn lands over tens to hundreds of
 *  ms. Still short enough that a human's own save shows as their own change
 *  (the frame reload behind it takes longer than this), and a wrong guess here
 *  costs latency, not correctness: the commit always happens. */
export const CONTENT_EPOCH_SETTLE_MS = 200

/** One committed invalidation: the newest epoch of the burst, and the routes
 *  the burst touched — or `null` when the scope is unknown and every board
 *  must remount. */
export type ContentChange = {
  epoch: number
  routes: ReadonlySet<string> | null
}

export type ContentEpoch = {
  /** A design file changed server-side. `routes` names the routes whose render
   *  changed; an empty array is authoritative ("nothing renders this file");
   *  null/undefined means the scope could not be determined and every board
   *  must remount. The change commits once the writes stop, so a burst is one
   *  remount rather than one per event. */
  fileChanged(routes?: readonly string[] | null): void
  /** Drop a pending change without committing it — the subscriber is going away
   *  (project switch, unmount) and a change landing afterwards would remount a
   *  canvas the human has already left. The burst's routes go with it: a
   *  cancelled invalidation that still remounts half its routes is only half
   *  cancelled. */
  cancel(): void
  /** Where a change is delivered. Set it before the first `fileChanged()`: a
   *  settle that fires with no commit set THROWS rather than swallowing the
   *  value (see `settle-gate`). */
  setCommit(commit: (change: ContentChange) => void): void
}

export function createContentEpoch({
  settleMs = CONTENT_EPOCH_SETTLE_MS,
  timers,
}: {
  settleMs?: number
  /** Injected so a test can drive the window; the app uses the real timers. */
  timers?: SettleTimers
} = {}): ContentEpoch {
  const gate = createSettleGate<ContentChange>(timers ? { settleMs, timers } : { settleMs })
  // Counts from 1, and only ever forwards — see the header's "counts writes".
  let next = 1
  /** The union of the routes this burst's events named, so far. Reset with the
   *  burst, on commit and on cancel. */
  let pendingRoutes = new Set<string>()
  /** Set once any event of the burst could not be scoped. "Every board" is
   *  absorbing: no later route list can narrow the burst back down, because
   *  the unscoped event may have been the very write those routes missed. */
  let pendingAll = false

  const resetPending = () => {
    pendingRoutes = new Set()
    pendingAll = false
  }

  return {
    fileChanged: (routes) => {
      if (routes === null || routes === undefined) {
        pendingAll = true
      } else {
        for (const route of routes) pendingRoutes.add(route)
      }
      // The running union goes in on EVERY push, not just the last: the gate
      // holds only what it was last pushed, and the last push of a burst is
      // what commits. (See the header — pushing each event's own routes is the
      // bug this shape exists to prevent.)
      gate.push({
        epoch: next++,
        routes: pendingAll ? null : new Set(pendingRoutes),
      })
    },
    cancel: () => {
      resetPending()
      gate.cancel()
    },
    setCommit: (commit) =>
      gate.setCommit((change) => {
        // The burst is over the moment it commits; the next one starts empty.
        resetPending()
        commit(change)
      }),
  }
}

/** The `affected_routes` a design-file realtime event carries, or `null` when
 *  the event cannot be scoped: an id-only event from a backend that predates
 *  the widening, or a payload of an unexpected shape. `null` fails OPEN (every
 *  board remounts) — the safe direction: an unscopable change that remounted
 *  nothing would leave the canvas silently stale.
 *
 *  Non-string members are dropped rather than trusted: the payload is wire
 *  data, and a member that is not a route can only ever fail a lookup. */
export function eventAffectedRoutes(event: { row?: Record<string, unknown> | undefined }): string[] | null {
  const value = event.row?.["affected_routes"]
  if (!Array.isArray(value)) return null
  return value.filter((route): route is string => typeof route === "string")
}

/** The board keys a scoped invalidation must remount: every OPEN route the
 *  change names, at every device a board may be rendered at. Keys are
 *  `artboardKey`'s `${route}@${deviceId}` — the same keys `boardEpochs` and the
 *  canvas's frames use, so the bump lands on exactly the boards whose content
 *  changed. A route that is not open contributes nothing, which is the point:
 *  a write to a page nobody has open remounts nothing. */
export function invalidatedBoardKeys(
  routes: ReadonlySet<string>,
  openRoutes: readonly string[],
  deviceIds: readonly string[],
): string[] {
  const keys: string[] = []
  for (const route of openRoutes) {
    if (!routes.has(route)) continue
    for (const deviceId of deviceIds) keys.push(artboardKey(route, deviceId))
  }
  return keys
}
