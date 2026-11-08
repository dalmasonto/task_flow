/// #5988 item 8: tools per agent message for the open room.
///
/// What an agent ran before posting barely changes afterwards, but its hooks
/// post activity in batches, so a tool row can land a few seconds AFTER the
/// message (reviewer, #6011). So: read once per set of loaded agent messages,
/// and once more ~30 s after the newest one arrived. Empty on a server
/// without the route.
import { useEffect, useState } from "react"

import { fetchMessageTools, type MessageTools } from "@/lib/tools-api"

export const SETTLE_MS = 30_000

export function useMessageTools(channel: number | null, messages: { id: number; createdAt?: string | null }[]): Record<string, MessageTools> {
  const idsKey = messages.map((m) => m.id).join(",")
  const newest = messages.reduce((max, m) => Math.max(max, m.createdAt ? Date.parse(m.createdAt) || 0 : 0), 0)
  const [loaded, setLoaded] = useState<{ channel: number; map: Record<string, MessageTools> } | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (channel == null || !idsKey) return
    const ctl = new AbortController()
    fetchMessageTools(channel, idsKey.split(",").map(Number), ctl.signal)
      .then((got) => {
        if (ctl.signal.aborted || got == null) return
        setLoaded((cur) => ({ channel, map: { ...(cur?.channel === channel ? cur.map : {}), ...got } }))
      })
      .catch(() => undefined)
    return () => ctl.abort()
  }, [channel, idsKey, tick])

  // The settle re-read, only while the newest message is still young.
  useEffect(() => {
    if (!newest) return
    const due = newest + SETTLE_MS - Date.now()
    if (due <= 0) return
    const t = setTimeout(() => setTick((n) => n + 1), due + 500)
    return () => clearTimeout(t)
  }, [newest])

  return loaded?.channel === channel ? loaded.map : {}
}
