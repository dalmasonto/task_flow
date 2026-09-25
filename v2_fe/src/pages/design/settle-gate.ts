/// The settle gate: a trailing-edge debounce for a stream of live values.
///
/// WHY THIS EXISTS. The canvas used to write its pan/zoom transform into React
/// state on every wheel and pointermove event. A two-finger pan therefore
/// re-rendered `DesignSurfacePage` and the whole board subtree 60–120 times a
/// second, and — because `transform` is in the dependency list of the viewport
/// persist effect — armed an IndexedDB write behind every one of them. Two
/// problems per finger movement.
///
/// The gesture now lives in a ref and is painted straight onto the wrapper
/// element; this gate is what decides WHEN that live value is allowed back into
/// React state: once per gesture, after the events stop, with the LAST value.
///
/// It is DOM-free on purpose. The settle is the part with the classic bugs — a
/// debounce that never fires, one that fires per event, one that keeps the
/// FIRST event of the burst and drops the trailing one — and none of them are
/// testable unless the timing can be driven from a test (`settle-gate.test.ts`
/// does, through `timers`).

/** The two timer calls the gate needs, injected so a test can drive time.
 *  Production uses `windowTimers`; the test uses a deterministic queue. */
export type SettleTimers = {
  set(fn: () => void, ms: number): number
  clear(id: number): void
}

/** `window.setTimeout`/`clearTimeout`, in the shape above. The body only ever
 *  runs in a browser — importing the module is safe in the node test env. */
export const windowTimers: SettleTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
}

export type SettleGate<T> = {
  /** Record the live value and (re)start the settle window. Every call defers
   *  the commit, so a burst commits once and a lone event still commits. */
  push(value: T): void
  /** Commit the pending value NOW — a gesture that has an end (pointerup).
   *  No-op when nothing is pending. */
  flush(): void
  /** Drop the pending value without committing — it has been superseded. */
  cancel(): void
  /** True while a pushed value is waiting out its window. */
  pending(): boolean
  /** Where a settle delivers its value. Set it before the first push (the
   *  canvas does, in a layout effect, because the callback belongs to a render
   *  that the timer outlives). A settle with none set THROWS rather than
   *  swallowing the value — silently dropping it is this file's whole subject. */
  setCommit(commit: (value: T) => void): void
}

export type SettleGateOptions = {
  /** How long the events must stop for before the value commits. Short enough
   *  to feel immediate, long enough to swallow a trackpad burst (events arrive
   *  every 8–16ms). */
  settleMs: number
  timers?: SettleTimers
}

export function createSettleGate<T>({
  settleMs,
  timers = windowTimers,
}: SettleGateOptions): SettleGate<T> {
  // Held in one-field boxes, not as `T | null`: a falsy `T` is a value the
  // caller can legitimately push, and `null` has to keep meaning "nothing".
  let held: { value: T } | null = null
  let timer: number | null = null
  let commit: ((value: T) => void) | null = null

  const disarm = () => {
    if (timer !== null) {
      timers.clear(timer)
      timer = null
    }
  }

  const fire = () => {
    timer = null
    const pending = held
    // Cleared BEFORE the callback: `commit` re-renders React, and a push that
    // lands from inside it must open a new window rather than be swallowed.
    held = null
    if (!pending) return
    if (!commit) throw new Error("settle-gate: a settle fired with no commit set")
    commit(pending.value)
  }

  return {
    push(value) {
      // The trailing edge is the whole point: whatever was held is replaced,
      // never kept, so the value that commits is the one the human last saw.
      held = { value }
      // Re-arm rather than keep the running timer. A timer left running from
      // the first event of a burst commits a value from the middle of the
      // gesture and then drops the rest of it.
      disarm()
      timer = timers.set(fire, settleMs)
    },
    flush() {
      disarm()
      fire()
    },
    cancel() {
      disarm()
      held = null
    },
    pending: () => held !== null,
    setCommit(next) {
      commit = next
    },
  }
}
