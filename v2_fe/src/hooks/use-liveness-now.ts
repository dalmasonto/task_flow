import { useEffect, useState } from "react"


/// How often the app re-evaluates liveness.
///
/// Liveness is a function of TIME, not of data: an agent that dies sends nothing,
/// so no realtime event arrives and no re-render happens. Deriving it only when
/// the workspace changes froze the last known answer — a dead agent kept showing
/// a green "online" dot indefinitely, because the `now` used to judge it was
/// itself minutes stale. This tick is the clock that makes staleness observable.
export const LIVENESS_TICK_MS = 30_000


/// A wall-clock reading that refreshes on a fixed interval, so time-derived state
/// (online dots, "connected" badges) goes stale on its own.
///
/// Returns the timestamp rather than a bare counter so callers PASS it into the
/// mappers. That keeps `now` an explicit input — a mapper that reads the clock
/// internally looks pure but silently depends on when it ran, which is what let
/// a dead agent keep a green dot.
export function useLivenessNow(enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), LIVENESS_TICK_MS)
    return () => window.clearInterval(timer)
  }, [enabled])
  return now
}
