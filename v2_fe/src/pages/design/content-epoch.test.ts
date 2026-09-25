import { describe, expect, it } from "vitest"

import { CONTENT_EPOCH_SETTLE_MS, createContentEpoch } from "./content-epoch"
import type { SettleTimers } from "./settle-gate"

/// A clock the test drives by hand, in the one shape the epoch needs: it holds
/// AT MOST one armed timer. Re-arming without clearing is the bug that commits a
/// value from the middle of a burst (see `settle-gate`'s own comment on why it
/// disarms before re-arming), and a fake clock that silently overwrote the
/// first callback would hide it — so this one throws instead.
///
/// The window's DURATION is not this file's subject: `settle-gate.test.ts`
/// drives a real deadline queue and pins the timing. These tests pin what the
/// epoch does with the gate — one commit per burst, and the burst's LAST value.
function armableTimers() {
  let armed: (() => void) | null = null
  let ids = 0
  let arms = 0
  const timers: SettleTimers = {
    set(fn) {
      if (armed) throw new Error("armed a second timer without clearing the first")
      armed = fn
      arms++
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
  }
}

function harness(settleMs?: number) {
  const clock = armableTimers()
  const commits: number[] = []
  const epoch = createContentEpoch(
    settleMs === undefined ? { timers: clock.timers } : { settleMs, timers: clock.timers },
  )
  epoch.setCommit((value) => commits.push(value))
  return { clock, commits, epoch }
}

describe("createContentEpoch", () => {
  it("commits a lone write, and not before the window elapses", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged()
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
      epoch.fileChanged()
      expect(commits).toEqual([])
    }
    expect(clock.arms()).toBe(20)

    clock.fire()
    expect(commits).toHaveLength(1)
    expect(commits[0]).toBeGreaterThan(0)
  })

  it("uses the trailing write's value, not the burst's first", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged()
    clock.fire()
    const afterFirst = commits[0]

    // A burst whose window is re-armed part-way through: the value that must
    // commit is the last one pushed, so the epoch that reaches React is the
    // burst's, not a stale earlier one.
    epoch.fileChanged()
    epoch.fileChanged()
    epoch.fileChanged()
    clock.fire()

    expect(commits).toHaveLength(2)
    expect(commits[1]).toBeGreaterThan(afterFirst)
  })

  it("does not drop the trailing write when the burst is cut short", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged()
    epoch.fileChanged()
    clock.fire()

    // Exactly one commit, and it carries the SECOND write. A coalescer that
    // keeps the first value and drops the trailing one passes the burst test
    // above and still misses the write the human is waiting for.
    expect(commits).toHaveLength(1)
    expect(commits[0]).toBe(2)
  })

  it("commits again after each pause, with a strictly increasing epoch", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged()
    clock.fire()
    epoch.fileChanged()
    clock.fire()
    epoch.fileChanged()
    clock.fire()

    // A gate that latches after its first fire leaves the canvas stale for the
    // rest of the session; equal or decreasing epochs would let LazyFrame match
    // a retired failure's epoch stamp (`failed.epoch === epoch`).
    expect(commits).toHaveLength(3)
    expect(commits[0]).toBeLessThan(commits[1])
    expect(commits[1]).toBeLessThan(commits[2])
  })

  it("coalesces a burst at the module's OWN default window", () => {
    // The window is re-armed per event, so any settle at all coalesces a burst
    // tighter than it. This pins that the default is not degenerate (a 0ms
    // window would restore one bump per event) without pinning its exact value.
    expect(CONTENT_EPOCH_SETTLE_MS).toBeGreaterThanOrEqual(120)
    const { clock, commits, epoch } = harness()
    epoch.fileChanged()
    expect(clock.arms()).toBe(1)
    clock.fire()
    expect(commits).toHaveLength(1)
  })

  it("advances by the number of WRITES, not the number of commits", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged()
    epoch.fileChanged()
    epoch.fileChanged()
    clock.fire()
    epoch.fileChanged()
    clock.fire()

    // The gate replaces what it holds, so a burst commits only its last value.
    // That is safe here only because the value is a version rather than a
    // payload: the three writes of the first burst must still MOVE the counter
    // three, so a burst of three can never look to anything comparing epochs
    // like a burst of one (which is what a "commit the event payload" design
    // would do — silently invalidating one route out of the burst's three).
    expect(commits).toEqual([3, 4])
  })

  it("cancel drops a pending bump, and disarms its window", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged()
    // The surface calls this when it unsubscribes (project switch, unmount): a
    // bump that lands afterwards remounts a canvas the human has left.
    epoch.cancel()

    expect(clock.armed()).toBe(false)
    clock.fire()
    expect(commits).toEqual([])
  })

  it("does not skip an epoch after a cancelled bump", () => {
    const { clock, commits, epoch } = harness()

    epoch.fileChanged()
    epoch.cancel()
    epoch.fileChanged()
    clock.fire()

    // The cancelled value must not be reused: two writes that both reach the
    // canvas would otherwise share one epoch, and LazyFrame's failure stamp
    // would match a frame it does not belong to.
    expect(commits).toHaveLength(1)
    expect(commits[0]).toBe(2)
  })
})
