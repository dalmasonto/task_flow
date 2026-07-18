import * as React from "react"

const MOBILE_BREAKPOINT = 768
// Tailwind's `lg` breakpoint. The chat master/detail layout switches to
// side-by-side at `lg`, so anything gating on that layout (e.g. auto-opening
// a conversation) must use this width, not MOBILE_BREAKPOINT, or the two
// disagree in the 768–1024px band.
const LG_BREAKPOINT = 1024

function makeBreakpointHook(query: string, snapshot: () => boolean) {
  const subscribe = (callback: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener("change", callback)
    return () => mql.removeEventListener("change", callback)
  }
  return () => React.useSyncExternalStore(subscribe, snapshot, () => false)
}

export const useIsMobile = makeBreakpointHook(
  `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
  () => window.innerWidth < MOBILE_BREAKPOINT
)

// True below Tailwind's `lg` breakpoint (i.e. when the chat layout is a single
// full-screen pane rather than side-by-side).
export const useIsBelowLg = makeBreakpointHook(
  `(max-width: ${LG_BREAKPOINT - 1}px)`,
  () => window.innerWidth < LG_BREAKPOINT
)
