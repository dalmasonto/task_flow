/// #5949: a room's pins and the reactions on its loaded messages.
///
/// No realtime group yet (it lands with the deploy that serves it), so both
/// refetch when the room or its loaded messages change, when the tab comes
/// back into view, and after your own pin/react. `supported` is false on a
/// server without pins, and the chat hides pin and react there.
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { fetchPins, fetchReactions, setPinned, toggleReaction, type Pin, type Reaction } from "@/lib/pins-api"

export function useRoomExtras(channel: number | null, ids: number[]) {
  const idsKey = ids.join(",")
  const [pins, setPins] = useState<{ channel: number; list: Pin[] | null } | null>(null)
  const [reacts, setReacts] = useState<{ channel: number; map: Record<string, Reaction[]> } | null>(null)
  const [pinTick, setPinTick] = useState(0)
  const [reactTick, setReactTick] = useState(0)

  useEffect(() => {
    const again = () => {
      if (document.visibilityState !== "visible") return
      setPinTick((t) => t + 1)
      setReactTick((t) => t + 1)
    }
    document.addEventListener("visibilitychange", again)
    return () => document.removeEventListener("visibilitychange", again)
  }, [])

  useEffect(() => {
    if (channel == null) return
    const ctl = new AbortController()
    fetchPins(channel, ctl.signal)
      .then((list) => !ctl.signal.aborted && setPins({ channel, list }))
      .catch(() => undefined)
    return () => ctl.abort()
  }, [channel, pinTick])

  useEffect(() => {
    if (channel == null || !idsKey) return
    const ctl = new AbortController()
    const asked = idsKey.split(",")
    fetchReactions(channel, asked.map(Number), ctl.signal)
      .then((got) => {
        if (ctl.signal.aborted || got == null) return
        // Replace what was asked (a reaction someone removed must clear), keep the rest.
        setReacts((cur) => {
          const base = cur?.channel === channel ? { ...cur.map } : {}
          for (const id of asked) delete base[id]
          return { channel, map: { ...base, ...got } }
        })
      })
      .catch(() => undefined)
    return () => ctl.abort()
  }, [channel, idsKey, reactTick])

  const list = pins?.channel === channel ? pins.list : undefined
  const reactions = reacts?.channel === channel ? reacts.map : {}

  const togglePin = useCallback(
    async (message: number, pin: boolean) => {
      if (channel == null) return
      try {
        await setPinned(channel, message, pin)
        toast.success(pin ? "Pinned to the room" : "Unpinned")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't change the pin.")
      } finally {
        setPinTick((t) => t + 1)
      }
    },
    [channel],
  )

  const react = useCallback(
    async (message: number, emoji: string) => {
      if (channel == null) return
      try {
        const next = await toggleReaction(channel, message, emoji)
        setReacts((cur) => ({ channel, map: { ...(cur?.channel === channel ? cur.map : {}), [String(message)]: next } }))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't react.")
      }
    },
    [channel],
  )

  return {
    /// undefined while loading, null on a server without pins.
    pins: list,
    supported: list != null,
    pinned: new Set((list ?? []).map((p) => p.message)),
    reactions,
    togglePin,
    react,
  }
}
