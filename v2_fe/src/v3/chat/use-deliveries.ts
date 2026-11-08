/// #5988 item 7: delivery receipts for the open room's loaded messages.
///
/// A receipt is written AFTER its message (the agent's MCP types it into the
/// pane, then reports), so besides reading on each new set of messages and on
/// tab focus, this re-reads once ~10 s after the newest message arrived.
/// Empty on a server without the route.
import { useEffect, useState } from "react"

import { fetchDeliveries, type Delivery } from "@/lib/deliveries-api"

export const RECEIPT_SETTLE_MS = 10_000

export function useDeliveries(channel: number | null, messages: { id: number; createdAt?: string | null }[]): Record<string, Delivery[]> {
  const idsKey = messages.map((m) => m.id).join(",")
  const newest = messages.reduce((max, m) => Math.max(max, m.createdAt ? Date.parse(m.createdAt) || 0 : 0), 0)
  const [loaded, setLoaded] = useState<{ channel: number; map: Record<string, Delivery[]> } | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const again = () => document.visibilityState === "visible" && setTick((n) => n + 1)
    document.addEventListener("visibilitychange", again)
    return () => document.removeEventListener("visibilitychange", again)
  }, [])

  useEffect(() => {
    if (channel == null || !idsKey) return
    const ctl = new AbortController()
    fetchDeliveries(channel, idsKey.split(",").map(Number), ctl.signal)
      .then((got) => {
        if (ctl.signal.aborted || got == null) return
        setLoaded((cur) => ({ channel, map: { ...(cur?.channel === channel ? cur.map : {}), ...got } }))
      })
      .catch(() => undefined)
    return () => ctl.abort()
  }, [channel, idsKey, tick])

  useEffect(() => {
    if (!newest) return
    const due = newest + RECEIPT_SETTLE_MS - Date.now()
    if (due <= 0) return
    const t = setTimeout(() => setTick((n) => n + 1), due + 500)
    return () => clearTimeout(t)
  }, [newest])

  return loaded?.channel === channel ? loaded.map : {}
}
