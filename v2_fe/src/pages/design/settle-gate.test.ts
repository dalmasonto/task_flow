import { describe, expect, it } from "vitest"

import { createSettleGate, type SettleTimers } from "./settle-gate"

/** Structurally the canvas's `CanvasTransform` — the gate is generic, and this
 *  keeps the test off the React/DOM import graph (the test env is `node`). */
type T = { x: number; y: number; scale: number }
const t = (n: number): T => ({ x: n, y: n * 2, scale: 1 })

/** A deterministic stand-in for setTimeout. `advance(ms)` runs every callback
 *  whose deadline falls inside the window, oldest first, re-scanning after each
 *  one so a callback that schedules another is picked up too. No global timer
 *  patching, so the gate's own scheduling is what is under test. */
function fakeClock() {
  let now = 0
  let nextId = 1
  const jobs = new Map<number, { at: number; fn: () => void }>()
  const timers: SettleTimers = {
    set(fn, ms) {
      const id = nextId++
      jobs.set(id, { at: now + ms, fn })
      return id
    },
    clear(id) {
      jobs.delete(id)
    },
  }
  return {
    timers,
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        let due: { id: number; at: number; fn: () => void } | null = null
        for (const [id, job] of jobs) {
          if (job.at > target) continue
          if (!due || job.at < due.at) due = { id, at: job.at, fn: job.fn }
        }
        if (!due) break
        jobs.delete(due.id)
        // Time moves BEFORE the callback runs, so anything it schedules is
        // measured from its own firing point, exactly as a real timer would.
        now = due.at
        due.fn()
      }
      now = target
    },
  }
}

/** A gate over a real clock/commit pair, as the canvas builds it. */
function harness(settleMs = 120) {
  const clock = fakeClock()
  const commits: T[] = []
  const gate = createSettleGate<T>({ settleMs, timers: clock.timers })
  gate.setCommit((value) => commits.push(value))
  return { clock, commits, gate }
}

describe("createSettleGate", () => {
  it("commits a lone event, once the settle window passes", () => {
    const { clock, commits, gate } = harness()

    gate.push(t(1))
    expect(commits).toEqual([])
    clock.advance(119)
    expect(commits).toEqual([])

    clock.advance(1)
    // A gate that never fires leaves the canvas's committed state — and so the
    // viewport the next session hydrates — permanently behind the gesture.
    expect(commits).toEqual([t(1)])
  })

  it("commits ONCE for a whole burst, with the last event's value", () => {
    const { clock, commits, gate } = harness()

    // 20 events 8ms apart — a trackpad's rate. The window is 120ms, so no event
    // in the burst is ever 120ms from the one before it.
    for (let i = 1; i <= 20; i++) {
      gate.push(t(i))
      clock.advance(8)
    }
    // Firing per event is the bug this task exists to remove: 20 wheel events
    // must not be 20 commits (`setTransform`, and a re-render of this canvas and
    // every board under it, each board holding a live iframe). The Dexie write
    // is not a per-event cost either way — the persist effect debounces at 400ms
    // of its own — so the render is the whole of it.
    expect(commits).toEqual([])

    clock.advance(120)
    // One commit, and it is the LAST value — a coalescer that keeps the first
    // event's value parks the canvas 20 events behind where the hand stopped.
    expect(commits).toEqual([t(20)])
  })

  it("restarts the window on every event, so a slow burst is not cut short", () => {
    const { clock, commits, gate } = harness()

    gate.push(t(1))
    clock.advance(119) // one tick short of settling
    gate.push(t(2))

    clock.advance(119)
    // A fixed-window throttle commits t(1) here and drops t(2) entirely — the
    // trailing edge is the event the human is still generating.
    expect(commits).toEqual([])

    clock.advance(1)
    expect(commits).toEqual([t(2)])
  })

  it("commits again after each pause, in order", () => {
    const { clock, commits, gate } = harness()

    gate.push(t(1))
    clock.advance(120)
    gate.push(t(2))
    clock.advance(120)

    // A gate that latches after its first fire passes the burst tests above and
    // still freezes the canvas on every gesture but the first.
    expect(commits).toEqual([t(1), t(2)])
  })

  it("flush commits the pending value at once, and only once", () => {
    const { clock, commits, gate } = harness()

    gate.push(t(1))
    gate.flush()
    expect(commits).toEqual([t(1)])
    expect(gate.pending()).toBe(false)

    // The timer must have been cleared by the flush: a live one fires a second
    // commit of a value that is no longer the live one.
    clock.advance(1000)
    expect(commits).toEqual([t(1)])
  })

  it("flush with nothing pending commits nothing", () => {
    const { clock, commits, gate } = harness()

    // Every pointerup flushes (a drag that never moved), so this must be a
    // no-op rather than a commit of a stale value or of a default.
    gate.flush()
    clock.advance(1000)

    expect(commits).toEqual([])
  })

  it("cancel drops the pending value, and disarms its timer", () => {
    const { clock, commits, gate } = harness()

    gate.push(t(1))
    gate.cancel()

    expect(gate.pending()).toBe(false)
    clock.advance(1000)
    // A cancel that keeps the value — or does nothing at all — leaves
    // `pending()` true and then commits t(1), a position the caller has since
    // moved away from, which is what drags the canvas back. (Dropping the value
    // while leaving the timer armed is not caught here, and does not need to
    // be: the timer fires with nothing held and commits nothing.)
    expect(commits).toEqual([])
  })

  it("throws — rather than swallows the value — if a settle has no commit", () => {
    const clock = fakeClock()
    const gate = createSettleGate<T>({ settleMs: 10, timers: clock.timers })

    // A gate that quietly drops this is the "never fires" bug from the other
    // end: the canvas's committed state would stay behind the gesture forever,
    // with nothing in the console to say so. Unreachable in the app — the
    // canvas sets the commit in a layout effect, before any event can push.
    gate.push(t(1))
    expect(() => clock.advance(10)).toThrow(/no commit set/)
  })

  it("setCommit replaces the callback, for a value pushed after it", () => {
    const clock = fakeClock()
    const first: T[] = []
    const second: T[] = []
    const gate = createSettleGate<T>({ settleMs: 10, timers: clock.timers })

    // The canvas sets this on EVERY render, so the gate must call the newest
    // one — a captured-once callback would call a stale prop from an old render.
    gate.setCommit((value) => first.push(value))
    gate.push(t(1))
    gate.setCommit((value) => second.push(value))
    gate.push(t(2))
    clock.advance(10)

    expect(first).toEqual([])
    expect(second).toEqual([t(2)])
  })

  it("holds a falsy value, and commits it", () => {
    const clock = fakeClock()
    const commits: (number | null)[] = []
    const gate = createSettleGate<number | null>({ settleMs: 10, timers: clock.timers })
    gate.setCommit((value) => commits.push(value))

    // "pending" must be tracked by a boxed value, not by the truthiness of the
    // value: a gate that reads `null` (or 0, or "") as "nothing pending" commits
    // nothing here, and a falsy value is one a caller can legitimately push.
    gate.push(null)
    expect(gate.pending()).toBe(true)
    clock.advance(10)

    expect(commits).toEqual([null])
  })
})
