/// Ordering for the workspace load: which of two overlapping loads may apply
/// its response.
///
/// Extracted from App.tsx's `loadLiveWorkspace`, which had no in-flight check at
/// all. Two invocations overlap routinely — a refresh click plus the SSE
/// stream's `onReconnect`, or a project switch while a reconnect's catch-up is
/// still running (that one closes over the `activeProjectId` of its own render,
/// so it re-loads the PREVIOUS project) — and whichever response lands last wins
/// the `setActiveProjectId`. So the older load's answer overwrote the user's
/// newer choice *even when that choice was perfectly valid*, which is what makes
/// the project move intermittently rather than deterministically. Everything
/// downstream hangs off that write: column pages, activity page, workspace
/// epoch (every slice refetches), the board fetch, and the SSE stream's own
/// identity — one stale response is a visible reload of the dashboard.
///
/// `justResolvedProjectRef` in App.tsx suppresses one re-fire; it says nothing
/// about ordering. This is the ordering.
///
/// Pure and tiny on purpose: "is this response from the newest load that has
/// STARTED" is a decision on two numbers, so it can be held still in a test.
/// The wiring around it is what no test here can reach: App.tsx cannot be
/// rendered in this repo's node environment (it reads `window.localStorage`
/// through `hasStoredAuthSession` while rendering), and the checks live in an
/// EFFECT — which `renderToStaticMarkup`, the only renderer this repo has, does
/// not run for any component.
export type LoadSequence = {
  /// Claim the next token. Call once per load, BEFORE the first await.
  begin: () => number
  /// May the load that was handed `seq` still apply its response?
  isCurrent: (seq: number) => boolean
}

/// The counter belongs to this object, not the module: App.tsx keeps one
/// instance in a ref so it survives the loader's re-creation (the loader's
/// identity depends on `activeProjectId`, so it is rebuilt whenever the active
/// project changes — a fresh counter each rebuild would silently never
/// supersede anything).
export function createLoadSequence(): LoadSequence {
  // 0 means "no load has started" — the first issued token is 1. Chosen so the
  // initial value of anything holding a sequence (a ref, before its first
  // begin) is honestly "nothing is in flight" rather than a token 0 that would
  // compare equal to itself.
  let latest = 0
  return {
    // Strictly increasing: two loads starting in the same tick still get
    // distinct tokens, so the later one always supersedes the earlier.
    begin() {
      latest += 1
      return latest
    },
    // Strict equality, deliberately: `<=` / `>=` would both admit a superseded
    // response, which is the whole bug. `latest > 0` is what stops a token that
    // was never issued from reading as current.
    isCurrent(seq) {
      return latest > 0 && seq === latest
    },
  }
}
