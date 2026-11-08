/// #5988 item 7: delivery receipts for the open room's loaded messages.
///
/// A receipt is written AFTER its message (the agent's MCP types it into the
/// pane, then reports). Live (BATCH_LIVE), the `message_deliveries` group
/// says when to re-read; until then, a re-read ~10 s after the newest message.
/// Tab focus re-reads either way, for a tab that missed an event. Empty on a
/// server without the route.
import { useEffect, useState } from "react"

import { BATCH_LIVE, subscribeBatchEvents } from "@/lib/batch-live"
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
    const off = subscribeBatchEvents("deliveries", () => setTick((n) => n + 1))
    return () => {
      document.removeEventListener("visibilitychange", again)
      off()
    }
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
    if (!newest || BATCH_LIVE) return
    const due = newest + RECEIPT_SETTLE_MS - Date.now()
    if (due <= 0) return
    const t = setTimeout(() => setTick((n) => n + 1), due + 500)
    return () => clearTimeout(t)
  }, [newest])

  return loaded?.channel === channel ? loaded.map : {}
}
