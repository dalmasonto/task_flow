/// One async read for a component: `{ data, error, loading }`, keyed by `key`
/// so a change of key shows loading again without a synchronous reset inside
/// the effect, and a stale response (an older key) is dropped. `key = null`
/// means "nothing to load yet". `reload()` refetches under the same key.
import { useCallback, useEffect, useState } from "react"

export function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ key: string; tick: number; data?: T; error: string | null } | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (key == null) return
    const ctl = new AbortController()
    load(ctl.signal)
      .then((data) => !ctl.signal.aborted && setState({ key, tick, data, error: null }))
      .catch((e: unknown) => !ctl.signal.aborted && setState({ key, tick, error: e instanceof Error ? e.message : "Couldn't load this." }))
    return () => ctl.abort()
    // `load` is a fresh closure every render; the key says when to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  const current = state && state.key === key ? state : null
  return { data: current?.data, error: current?.error ?? null, loading: key != null && !current, reload }
}
