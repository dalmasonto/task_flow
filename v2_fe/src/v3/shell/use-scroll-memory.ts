/// #1093: "keep scroll position when navigating back". The v3 shell scrolls in
/// its own <main>, not the window, so the browser's scroll restoration never
/// applies: Back from a task always landed at the top of a long board or list.
///
/// Remembers the scroll offset per history entry (location.key) and restores it
/// on a POP (Back/Forward) only; a fresh navigation (PUSH/REPLACE) starts at the
/// top, as a new page should. Restoration retries for a short while, because the
/// page's content often arrives a frame or two after the route renders.
import { useEffect, useLayoutEffect, type RefObject } from "react"
import { useLocation, useNavigationType } from "react-router-dom"

const MAX_ENTRIES = 200
const offsets = new Map<string, number>()

/// Exported for tests: remember one entry, bounded (oldest dropped first).
export function rememberOffset(key: string, top: number, store = offsets): void {
  store.delete(key)
  store.set(key, top)
  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }
}

export function useScrollMemory(ref: RefObject<HTMLElement | null>): void {
  const location = useLocation()
  const navType = useNavigationType()

  // Record continuously (cheap: one Map write per scroll frame), so the offset is
  // right even when the route unmounts its content before a cleanup could read it.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const key = location.key
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => rememberOffset(key, el.scrollTop))
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener("scroll", onScroll)
    }
  }, [ref, location.key])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const saved = navType === "POP" ? offsets.get(location.key) : undefined
    if (saved == null) {
      el.scrollTop = 0
      return
    }
    // Content may still be loading: retry until it is tall enough, ~1 s at most.
    let tries = 0
    let frame = 0
    const restore = () => {
      el.scrollTop = saved
      if (Math.abs(el.scrollTop - saved) > 1 && tries++ < 60) frame = requestAnimationFrame(restore)
    }
    restore()
    return () => cancelAnimationFrame(frame)
  }, [ref, location.key, navType])
}
