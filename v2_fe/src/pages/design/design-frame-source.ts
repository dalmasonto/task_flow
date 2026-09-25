/// Which board a sandbox frame's message came from, resolved by identity.
///
/// A module rather than an export from `design-canvas.tsx`, for the reason
/// `design-comments.ts` and `design-selection.ts` are modules: a `.tsx` that
/// exports non-components costs a `react-refresh/only-export-components` error
/// per export. `design-frame-source.test.ts` feeds this function plain
/// `{key, win}` pairs (the repo has no jsdom), so the file stays pure and
/// DOM-free — `frameSources()`, which does read the DOM, stays in
/// `design-canvas.tsx`.

/// The board key whose frame sent this message, matched by WindowProxy
/// IDENTITY.
///
/// NEVER read `name` off `event.source` — and never "solve" this by matching
/// `event.source.name` against a board key again, however right the `name=
/// {board.key}` on the iframe makes it look. `event.source` is the sandbox
/// iframe's WindowProxy and the sandbox is a DIFFERENT ORIGIN from the app in
/// every deployment, so that read throws:
///
///   Uncaught SecurityError: Failed to read a named property 'name' from
///   'Window': Blocked a frame with origin "https://taskflow.supercodehive.com"
///   from accessing a cross-origin frame. at Array.find (<anonymous>)
///
/// The throw escaped the whole `onMessage` handler, so `design:select` was
/// never processed and inspect did nothing at all — it had never worked
/// cross-origin. Comparing WindowProxy references is allowed across origins;
/// reading their properties is not. `frames` therefore carries `win` for
/// identity and `key` for the answer, and getting `key` is `frameSources()`'s
/// job (in `design-canvas.tsx`), not this function's.
export function boardKeyForSource<T>(
  frames: { key: string; win: T | null }[],
  source: T | null
): string | null {
  if (!source) return null
  return frames.find((f) => f.win === source)?.key ?? null
}
