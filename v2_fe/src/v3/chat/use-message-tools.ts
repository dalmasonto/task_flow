/// #5988 item 8: tools per agent message for the open room, read once per
/// set of loaded agent messages (what an agent ran before posting doesn't
/// change afterwards). Empty on a server without the route.
import { useEffect, useState } from "react"

import { fetchMessageTools, type MessageTools } from "@/lib/tools-api"

export function useMessageTools(channel: number | null, agentMessageIds: number[]): Record<string, MessageTools> {
  const idsKey = agentMessageIds.join(",")
  const [loaded, setLoaded] = useState<{ channel: number; map: Record<string, MessageTools> } | null>(null)
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
  }, [channel, idsKey])
  return loaded?.channel === channel ? loaded.map : {}
}
