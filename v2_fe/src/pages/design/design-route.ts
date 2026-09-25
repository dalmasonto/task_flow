/// Where a sandbox frame ACTUALLY is, and whether that is where its board
/// points.
///
/// A page's own links navigate inside its frame (that is what `rewrite_hrefs`
/// in `composer.rs` builds), so a board can end up showing a different page
/// than the one it was created for. The frame announces the path it is at
/// (`design:route`, posted by the composer's `PICKER_RUNTIME`), and the rules
/// that turn that into an app route live here.
///
/// A module rather than an export from `design-canvas.tsx`, for the reason
/// `design-frame-source.ts` and `design-selection.ts` are modules: a `.tsx` that
/// exports non-components costs a `react-refresh/only-export-components` error
/// per export. Everything here is pure and DOM-free — the path arrives as an
/// ARGUMENT rather than being read off `location` — so `design-route.test.ts`
/// can reach the rules in the repo's node-only vitest environment (no jsdom).
///
/// Why the CHROME converts the path and not the frame: the conversion is the
/// part with the edge cases (a token that contains dots, the bare root, a
/// trailing slash), and a JS string inside a Rust `const` has no unit-test seam
/// at all — the plan's own note on that runtime (Task 15, Step 3) refuses a Rust
/// test that merely asserts the string contains a word. So the frame reports the
/// path it is at, honestly, and the one rule that has to be right is tested
/// here. Nothing is lost by that placement: a frame's message is untrusted input
/// either way, and this parser is what decides how much of it to believe.

/// The prefix a composed page is served under, minus the token: `/s/{token}`.
/// Literal, because the sandbox origin mounts its pages there (`urls.rs`) and
/// the frame's path can be nothing else.
const SANDBOX_ROOT = "/s/"

/// Longest path this parser will read. A real one is ~90 characters (`/s/`, a
/// 40-odd character token, a route), and the cap bounds what a hostile or
/// buggy sender can push through the header.
export const MAX_FRAME_PATH = 512

/// The app route a sandbox frame is at, given its `location.pathname`.
///
/// `null` is "this is not a path I can read" — a message from a window that is
/// not one of our frames, an empty path, or one past [`MAX_FRAME_PATH`]. The
/// caller ignores it rather than reporting a route.
///
/// Deliberately not a URL parse: the path is `/s/{token}{route}`, the token is
/// its FIRST segment, and everything after it is the route. The token is
/// `{project}.{expiry:x}.{sig}` (`sandbox.rs`) — dotted, hex-encoded, ~40
/// characters — so no rule here may key on its own shape; only the position
/// matters. The bare root (`/s/{token}`, which is what `sandboxUrl` builds for
/// route `/`) reads as `/`. Not the same job as `rewrite_hrefs`, which builds
/// these paths rather than reading them.
export function routeFromSandboxPath(pathname: string): string | null {
  if (pathname.length === 0 || pathname.length > MAX_FRAME_PATH) return null
  if (!pathname.startsWith(SANDBOX_ROOT)) return null
  // A query or a fragment is not part of the path. `location.pathname` carries
  // neither, and cutting here is what makes the rest of this function safe to
  // read as "the path": without it, `?` and `#` would be reported as part of a
  // route the header then prints.
  const end = pathname.search(/[?#]/)
  const path = end === -1 ? pathname : pathname.slice(0, end)
  const rest = path.slice(SANDBOX_ROOT.length)
  const slash = rest.indexOf("/")
  const token = slash === -1 ? rest : rest.slice(0, slash)
  // `/s/` and `/s//app`: there is no token, so there is no route to name. Read
  // literally, the second is a project id of "".
  if (!token) return null
  return normalizeRoute(slash === -1 ? "" : rest.slice(slash))
}

/// The route to show beside a board's name because its frame is NOT on the page
/// the board points at, or `null` when it is there (or when nothing usable has
/// been reported).
export function divergedRoute(boardRoute: string, reported: string | null): string | null {
  // Nothing reported is not "somewhere else": a frame that has not announced
  // yet must render as the board always did, not as a board gone missing.
  if (!reported) return null
  const current = normalizeRoute(reported)
  return current === normalizeRoute(boardRoute) ? null : current
}

/// A route spelled the way the manifest spells one: `/` for the root, and no
/// trailing slash. `page_path_for_route` (`manifest.rs`) trims that slash and
/// `rewrite_hrefs` (`composer.rs`) normalizes it away when it builds these
/// paths, so `/app/` and `/app` are one route everywhere except in the string —
/// which is why the comparison above cannot be `===` on the raw values.
function normalizeRoute(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

/// One frame's report: where it said it was, and WHICH frame document said it.
///
/// The stamp is `(epoch, token)` — the two parts of the iframe's own key,
/// `` `${frameSrc}|${epoch}` `` in `LazyFrame`, where `frameSrc` is the token's
/// sandbox URL for this board plus `?board={boardKey}`. The board key is the
/// third part of that key and is what the report is held under (see
/// `ArtboardCard`), so an equal stamp means the SAME DOCUMENT is still mounted.
/// Nothing coarser would do: a stamp of the epoch alone reads as fresh after a
/// remount caused by a new `sandboxToken`, which moves `frameSrc` and leaves
/// both epoch halves exactly where they were.
///
/// That is not hypothetical — it is a project switch. The surface is not keyed
/// by project (`App.tsx` mounts one `DesignSurfacePage`), so a switch refetches
/// the token (`DesignSurfacePage`'s manifest/token/layout effect) and remounts
/// every frame WITHOUT moving either epoch, while `route@device` keys repeat
/// across projects: every project has `/` at the default device. The token was
/// minted per project (`sandbox.rs::mint` encodes the project id), so it is what
/// tells A's report apart from B's frame.
export type FrameReport = { route: string; epoch: number; token: string }

/// Where a board's frame is, per the report held for it — `null` unless that
/// report came from the document CURRENTLY mounted.
///
/// A stale stamp is not an error to report, it is simply no longer a claim
/// about anything on screen: the frame has been remounted at the route its
/// `src` names, and the header must go back to saying so.
export function reportedRoute(
  report: FrameReport | null | undefined,
  epoch: number,
  token: string | null,
): string | null {
  return report && report.epoch === epoch && report.token === token ? report.route : null
}

/// Is the frame saying what it already said?
///
/// The one caller is a `useState` updater: a report that repeats what is
/// already held returns the CURRENT value, React drops the update, and a board
/// whose frame re-announces where it already was costs no render at all. A
/// frame re-announces on every `pageshow` (a Back, a Forward, a reload), so
/// "reported the same thing again" is the common case, not an edge one.
export function sameFrameReport(current: FrameReport | null, next: FrameReport): boolean {
  return (
    current !== null &&
    current.route === next.route &&
    current.epoch === next.epoch &&
    current.token === next.token
  )
}
