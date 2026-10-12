import { describe, expect, it } from "vitest"

import {
  CONTENT_EPOCH_SETTLE_MS,
  createContentEpoch,
  eventAffectedRoutes,
  invalidatedBoardKeys,
  type ContentChange,
} from "./content-epoch"
import type { SettleTimers } from "./settle-gate"

/// A clock the test drives by hand, in the one shape the epoch needs: it holds
/// AT MOST one armed timer. Re-arming without clearing is the bug that commits a
/// value from the middle of a burst (see `settle-gate`'s own comment on why it
/// disarms before re-arming), and a fake clock that silently overwrote the
/// first callback would hide it — so this one throws instead.
///
/// The window's DURATION is not this file's subject: `settle-gate.test.ts`
/// drives a real deadline queue and pins the timing. These tests pin what the
/// epoch does with the gate — one commit per burst, the burst's LAST epoch, and
/// the UNION of the routes its writes named.
function armableTimers() {
  let armed: (() => void) | null = null
  let ids = 0
  let arms = 0
  /// The delay each window was armed with, in order. The clock fires the window
  /// whenever it is told to, so the duration is not what it measures — this is
  /// what makes the LENGTH the module hands to the gate observable at all.
  const delays: number[] = []
  const timers: SettleTimers = {
    set(fn, ms) {
      if (armed) throw new Error("armed a second timer without clearing the first")
      armed = fn
      arms++
      delays.push(ms)
      return ++ids
    },
    clear() {
      armed = null
    },
  }
  return {
    timers,
    /// Fire the pending window, as the browser would once it elapses.
    fire() {
      const fn = armed
      armed = null
      fn?.()
    },
    armed: () => armed !== null,
    /// How many times a window was opened — the count a per-event bump would
    /// push towards the number of events.
    arms: () => arms,
    /// The delays those windows were armed with.
    delays: () => delays,
  }
}

/// The routes a change names, as a sorted array — `null` (every board) stays
/// `null`, so an assertion can never file "all" under "none".
function routesOf(change: ContentChange | undefined): string[] | null {
  if (!change || change.routes === null) return null
  return [...change.routes].sort()
}

function harness(settleMs?: number) {
  const clock = armableTimers()
  const commits: ContentChange[] = []
  const epoch = createContentEpoch(
    settleMs === undefined ? { timers: clock.timers } : { settleMs, timers: clock.timers },
  )
  epoch.setCommit((value) => commits.push(value))
  return { clock, commits, epoch }
}

describe("createContentEpoch", () => {
  it("commits a lone write, and not before the window elapses", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged(["/a"])
    // The point of the window: the canvas must NOT remount on the event itself.
    expect(commits).toEqual([])
    expect(clock.armed()).toBe(true)

    clock.fire()
    expect(commits).toHaveLength(1)
  })

  it("commits ONCE for a burst of writes, with the LAST epoch", () => {
    const { clock, commits, epoch } = harness()

    // Twenty writes back-to-back, each re-arming the window before it elapses —
    // an agent rewriting a page, its tokens and a component in one turn. Every
    // one of these used to be a `setContentEpoch`, and therefore a remount of
    // every artboard at every device (three devices under Responsive review).
    for (let i = 0; i < 20; i++) {
      epoch.fileChanged(["/a"])
      expect(commits).toEqual([])
    }
    expect(clock.arms()).toBe(20)

    clock.fire()
    expect(commits).toHaveLength(1)
    expect(commits[0].epoch).toBeGreaterThan(0)
  })

  it("uses the trailing write's epoch, not the burst's first", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged(["/a"])
    clock.fire()
    const afterFirst = commits[0].epoch

    // A burst whose window is re-armed part-way through: the value that must
    // commit is the last one pushed, so the epoch that reaches React is the
    // burst's, not a stale earlier one.
    epoch.fileChanged(["/a"])
    epoch.fileChanged(["/a"])
    epoch.fileChanged(["/a"])
    clock.fire()

    expect(commits).toHaveLength(2)
    expect(commits[1].epoch).toBeGreaterThan(afterFirst)
  })

  it("does not drop the trailing write when the burst is cut short", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged(["/a"])
    epoch.fileChanged(["/b"])
    clock.fire()

    // Exactly one commit, and it carries the SECOND write. A coalescer that
    // keeps the first value and drops the trailing one passes the burst test
    // above and still misses the write the human is waiting for.
    expect(commits).toHaveLength(1)
    expect(commits[0].epoch).toBe(2)
    expect(routesOf(commits[0])).toEqual(["/a", "/b"])
  })

  it("commits again after each pause, with a strictly increasing epoch", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged(["/a"])
    clock.fire()
    epoch.fileChanged(["/a"])
    clock.fire()
    epoch.fileChanged(["/a"])
    clock.fire()

    // A gate that latches after its first fire leaves the canvas stale for the
    // rest of the session; equal or decreasing epochs would let LazyFrame match
    // a retired failure's epoch stamp (`failed.epoch === epoch`).
    expect(commits).toHaveLength(3)
    expect(commits[0].epoch).toBeLessThan(commits[1].epoch)
    expect(commits[1].epoch).toBeLessThan(commits[2].epoch)
  })

  it("arms the gate with the module's OWN default window", () => {
    // Two halves, and the second is the one that used to be missing. The window
    // is re-armed per event, so ANY settle at all coalesces a burst tighter than
    // it — which means the constant alone (asserted first, against it going
    // degenerate at 0ms) says nothing about what the gate was armed with: a
    // `createContentEpoch` that passed `settleMs: 0` to the gate while exporting
    // 200 would pass every other test in this file. The delay recorded by the
    // fake clock is the threading itself, so this fails on exactly that change.
    expect(CONTENT_EPOCH_SETTLE_MS).toBeGreaterThanOrEqual(120)
    const { clock, commits, epoch } = harness()
    epoch.fileChanged(["/a"])
    expect(clock.arms()).toBe(1)
    expect(clock.delays()).toEqual([CONTENT_EPOCH_SETTLE_MS])
    clock.fire()
    expect(commits).toHaveLength(1)
  })

  it("advances by the number of WRITES, not the number of commits", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged(["/a"])
    epoch.fileChanged(["/a"])
    epoch.fileChanged(["/a"])
    clock.fire()
    epoch.fileChanged(["/a"])
    clock.fire()

    // The gate replaces what it holds, so a burst commits only its last epoch.
    // That is safe only because the epoch is a version rather than a payload:
    // the three writes of the first burst must still MOVE the counter three, so
    // a burst of three can never look to anything comparing epochs like a burst
    // of one. What the payload half must NOT lose is carried separately: the
    // committed route list is the burst's UNION (asserted below).
    expect(commits.map((c) => c.epoch)).toEqual([3, 4])
  })

  it("commits the UNION of a burst's routes, not the trailing event's", () => {
    const { clock, commits, epoch } = harness()

    // Three writes touching three different pages, inside one window. The
    // gate keeps only the LAST value it is pushed, so a caller that pushed
    // each event's own routes would remount one page and silently leave two
    // stale — no error, just fewer boards invalidated than the burst required.
    // The union is accumulated HERE, before the gate, which is what makes the
    // gate's replacement semantics safe for a payload.
    epoch.fileChanged(["/a"])
    epoch.fileChanged(["/b"])
    epoch.fileChanged(["/c", "/a"])
    clock.fire()

    expect(commits).toHaveLength(1)
    expect(routesOf(commits[0])).toEqual(["/a", "/b", "/c"])
  })

  it("resets the union once it commits, so a later burst cannot inherit it", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged(["/a"])
    clock.fire()
    epoch.fileChanged(["/b"])
    clock.fire()

    expect(routesOf(commits[0])).toEqual(["/a"])
    expect(routesOf(commits[1])).toEqual(["/b"])
  })

  it("widens the whole burst to every board when one event cannot be scoped", () => {
    const { clock, commits, epoch } = harness()

    // An event without `affected_routes` — an older backend mid-deploy, or a
    // payload this build cannot read — must fail OPEN: an unscopable change
    // remounts everything rather than nothing. And it widens the burst it
    // arrived in, because the canvas applies one remount decision per settle.
    epoch.fileChanged(["/a"])
    epoch.fileChanged(null)
    epoch.fileChanged(["/b"])
    clock.fire()

    expect(commits).toHaveLength(1)
    expect(routesOf(commits[0])).toBeNull()
  })

  it("keeps an EMPTY route list authoritative — nothing renders that file", () => {
    const { clock, commits, epoch } = harness()

    // `[]` is a real answer (a component delete that was allowed only because
    // no page used it): nothing to remount. It must stay distinct from `null`,
    // which means "unknown scope". Collapsing the two would either remount the
    // whole canvas per unused-component edit, or leave real changes stale.
    epoch.fileChanged([])
    clock.fire()

    expect(commits).toHaveLength(1)
    expect(commits[0].routes).not.toBeNull()
    expect(routesOf(commits[0])).toEqual([])
  })

  it("cancel drops a pending bump, and disarms its window", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged(["/a"])
    // The surface calls this when it unsubscribes (project switch, unmount): a
    // bump that lands afterwards remounts a canvas the human has left.
    epoch.cancel()

    expect(clock.armed()).toBe(false)
    clock.fire()
    expect(commits).toEqual([])
  })

  it("does not skip an epoch after a cancelled bump", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged(["/a"])
    epoch.cancel()
    epoch.fileChanged(["/a"])
    clock.fire()

    // The cancelled value must not be reused: two writes that both reach the
    // canvas would otherwise share one epoch, and LazyFrame's failure stamp
    // would match a frame it does not belong to.
    expect(commits).toHaveLength(1)
    expect(commits[0].epoch).toBe(2)
  })

  it("drops a cancelled burst's routes too", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged(["/a"])
    epoch.cancel()
    epoch.fileChanged(["/b"])
    clock.fire()

    // The routes of a cancelled burst must not leak into the next commit —
    // a canceled invalidation that still remounts /a is only half-cancelled.
    expect(routesOf(commits[0])).toEqual(["/b"])
  })
})

describe("eventAffectedRoutes", () => {
  // The shape the widened backend payload (#665) puts on the wire:
  // `{id, version, path, affected_routes}`.
  const event = (row: Record<string, unknown> | undefined) => ({
    table: "design_file",
    action: "updated",
    row,
  })

  it("reads the route list off a widened payload", () => {
    expect(eventAffectedRoutes(event({ id: 1, affected_routes: ["/a"] }))).toEqual(["/a"])
  })

  it("reads an empty list as an authoritative empty list, not as unknown", () => {
    expect(eventAffectedRoutes(event({ id: 1, affected_routes: [] }))).toEqual([])
  })

  it("returns null when the payload carries no route list", () => {
    // An older backend (id-only event), a delete from a writer that predates
    // the widening, or a payload of another shape entirely.
    expect(eventAffectedRoutes(event({ id: 1 }))).toBeNull()
    expect(eventAffectedRoutes(event(undefined))).toBeNull()
    expect(eventAffectedRoutes(event({ affected_routes: "all" }))).toBeNull()
  })

  it("drops non-string members rather than trusting the wire blindly", () => {
    expect(eventAffectedRoutes(event({ affected_routes: ["/a", 7, null, "/b"] }))).toEqual([
      "/a",
      "/b",
    ])
  })
})

describe("invalidatedBoardKeys", () => {
  it("names every board of an invalidated route, across its devices", () => {
    // A route is open on two devices; another route on one. Only the matching
    // route's boards — at EVERY device it is open at — are remounted.
    const keys = invalidatedBoardKeys(new Set(["/a"]), ["/a", "/b"], ["desktop", "phone"])
    expect(keys.sort()).toEqual(["/a@desktop", "/a@phone"])
  })

  it("names nothing for a route that is not open", () => {
    // The scoped win: a write to a page nobody has open remounts nothing.
    expect(invalidatedBoardKeys(new Set(["/c"]), ["/a", "/b"], ["desktop"])).toEqual([])
  })

  it("names nothing for an empty route set", () => {
    expect(invalidatedBoardKeys(new Set(), ["/a"], ["desktop"])).toEqual([])
  })
})
