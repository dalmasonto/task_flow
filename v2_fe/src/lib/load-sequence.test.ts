import { describe, it, expect } from "vitest"
import { createLoadSequence } from "./load-sequence"

/// Ordering for the workspace load — the guard that was missing.
///
/// `loadLiveWorkspace` has no in-flight check: two overlapping invocations (a
/// refresh click plus an SSE `onReconnect`, or a project switch while a
/// reconnect's catch-up is still running) resolve in whatever order the network
/// finishes, and the OLDER one's `setActiveProjectId` overwrites the user's
/// NEWER choice. Every downstream reset hangs off that write, so it reads as the
/// page reloading onto a different project — intermittently, which is exactly
/// how the user reported it ("random page reloads as different projects try to
/// take that spot"). `justResolvedProjectRef` suppresses one re-fire; it does
/// not order responses.
///
/// The check is "is this response from the newest load that has STARTED" — a
/// decision on two numbers, so it is testable here where the effect is not.
/// (Not because nothing here renders a component — `pages-panel.test.ts` and
/// `design-inspector.test.ts` render real ones through `renderToStaticMarkup`.
/// It is THIS path that cannot be exercised: App itself cannot be rendered in
/// the node environment, because it calls `hasStoredAuthSession` —
/// `window.localStorage` — while rendering, and, more fundamentally, effects do
/// not run under static rendering at all, so a wiring test could not reach a
/// `useEffect` whichever component it mounted.)
///
/// Every test names what would have to change for it to fail. What these do NOT
/// prove is stated at the foot of the file.
describe("createLoadSequence", () => {
  // Fails if `begin` stops advancing — returning the same token for every load
  // (the status quo, where every response is "current") makes the guard a no-op
  // that still reads like a guard. This is the failure that would be invisible:
  // the code looks guarded and the race is still open.
  it("hands out a new, strictly increasing token for every load it starts", () => {
    const loads = createLoadSequence()
    const first = loads.begin()
    const second = loads.begin()
    const third = loads.begin()
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
  })

  // THE BUG, encoded: the token that started a load which a later load has
  // superseded must NOT be current — however the two happen to complete, and
  // even though its own request succeeded and its answer would be perfectly
  // valid on its own.
  //
  // Fails if `isCurrent` compares against anything other than the newest token
  // (a count, the first token), or if the comparison is `<=`/`>=` instead of
  // `===` — both of which admit a superseded response.
  it("discards a superseded load's response once a newer load has started", () => {
    const loads = createLoadSequence()
    const older = loads.begin()
    const newer = loads.begin()
    expect(loads.isCurrent(older)).toBe(false)
    expect(loads.isCurrent(newer)).toBe(true)
    // Strict equality, not a range: a token from before and a token from after
    // are both "not the newest".
    expect(loads.isCurrent(older - 1)).toBe(false)
    expect(loads.isCurrent(newer + 1)).toBe(false)
  })

  // The load that is still in flight must keep its claim while it finishes: a
  // guard that only compares against the PREVIOUS token would drop the live
  // load's own response as soon as one supersede happened.
  it("keeps the newest load current no matter how many loads preceded it", () => {
    const loads = createLoadSequence()
    for (let i = 0; i < 5; i += 1) loads.begin()
    const live = loads.begin()
    expect(loads.isCurrent(live)).toBe(true)
  })

  // A guard that has started nothing must not accept a response — the initial
  // value of whatever holds the sequence must not read as a current load.
  // Fails if `isCurrent` is written as `seq >= latest` / `seq <= latest` with
  // `latest` starting at 0, which accepts token 0 and any token at all.
  it("treats nothing as current before a single load has started", () => {
    const loads = createLoadSequence()
    expect(loads.isCurrent(0)).toBe(false)
    expect(loads.isCurrent(1)).toBe(false)
  })

  // The counter is the guard's OWN state, which is why App.tsx can hold it in a
  // ref that outlives the loader's re-creation. Fails if the counter is moved to
  // module scope: two guards would then share an ordering that only one of them
  // participates in, and a token from a load in one would be honoured by the
  // other — the race, wearing the guard's clothes.
  it("counts per sequence, not globally", () => {
    const one = createLoadSequence()
    const other = createLoadSequence()
    const fromOne = one.begin()
    expect(other.isCurrent(fromOne)).toBe(false)
    expect(one.isCurrent(fromOne)).toBe(true)
  })

  // The interleaving the user hit, at the level this module owns: the user picks
  // project B while a load for project A is still in flight, and A's response
  // lands LAST — the slow case, not the fast one. With no guard the second
  // "apply" wins and the active project moves to A: the user's own choice,
  // overruled by a request that started before they made it.
  //
  // Fails if the guard stops being consulted per response (the status quo: both
  // applied, in arrival order), or if `isCurrent` ever answers true for a
  // superseded token.
  it("applies only the user's newest choice when an older response lands last", () => {
    const loads = createLoadSequence()
    const applied: string[] = []
    // The load path's rule, in the shape App.tsx applies it: check after the
    // await, before the state write.
    const applyResponse = (seq: number, project: string) => {
      if (!loads.isCurrent(seq)) return
      applied.push(project)
    }

    const loadForA = loads.begin() // starts first (slower request)
    const loadForB = loads.begin() // the user's newer pick
    applyResponse(loadForB, "B") // arrives first
    applyResponse(loadForA, "A") // arrives late, must be dropped
    expect(applied).toEqual(["B"])
  })
})

/// What this file does NOT prove: that App.tsx actually consults the guard after
/// each await, before each setState. That is wiring inside a component's effect,
/// and this repo renders only through `renderToStaticMarkup` — where effects do
/// not run, and which App could not be handed anyway — so it is verified by
/// inspection at App.tsx's `loadLiveWorkspace` (see the task-24 report for what
/// each check has to sit between). What is proved here is the semantic the
/// wiring relies on: a superseded response is distinguishable from the newest
/// one, for every token, in both directions.
