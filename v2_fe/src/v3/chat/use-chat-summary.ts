/// #5983: the chat list's mention counts and followed threads.
///
/// There is no realtime group for either (a per-project group would tell
/// everyone who follows what), so both refetch, debounced, when something
/// that changes them happens: any unread count moves (`signal`), or a thread
/// reply arrives on App's one stream (the thread bus). `null` means the
/// server predates the endpoint, and the list hides Mentions / Threads.
import { useCallback, useEffect, useState } from "react"

import { fetchFollowedThreads, fetchRoomSummaries, type FollowedThread, type RoomSummary } from "@/lib/chat-summary-api"
import { subscribeThreadEvents } from "@/lib/thread-bus"

const DEBOUNCE_MS = 400

type Loaded = { project: number; summary: RoomSummary[] | null; following: FollowedThread[] | null }

export function useChatSummary(project: number | null, signal: string) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => subscribeThreadEvents((e) => (e.kind === "delete" || e.message.thread_root != null ? reload() : undefined)), [reload])

  useEffect(() => {
    if (project == null) return
    const ctl = new AbortController()
    const t = setTimeout(() => {
      // Each read stands alone: an error in one keeps the other's answer.
      void Promise.all([fetchRoomSummaries(project, ctl.signal).catch(() => undefined), fetchFollowedThreads(project, ctl.signal).catch(() => undefined)]).then(([summary, following]) => {
        if (ctl.signal.aborted) return
        setLoaded((cur) => {
          const same = cur?.project === project ? cur : null
          return { project, summary: summary === undefined ? (same?.summary ?? null) : summary, following: following === undefined ? (same?.following ?? null) : following }
        })
      })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [project, signal, tick])

  const current = loaded?.project === project ? loaded : null
  return { summary: current?.summary ?? null, following: current?.following ?? null, reload }
}
