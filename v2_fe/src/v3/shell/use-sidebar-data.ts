/// Live data for the sidebar's sections and badges (tf-shell).
///
/// Three server reads back it, all debounced together: the room summary
/// (unread and mentions per room, #5983), the inbox's "needs you" count and the
/// open decisions. None has its own realtime group, so they refetch when
/// something that moves them happens: a message arrives or a read cursor moves
/// on App's one stream, or the page changes (reading an inbox or ruling a
/// decision happens on a page, and leaving it should settle the badge).
import { useEffect, useMemo, useState } from "react"
import { useLocation } from "react-router-dom"

import { useLivenessNow } from "@/hooks/use-liveness-now"
import { fetchRoomSummaries, type RoomSummary } from "@/lib/chat-summary-api"
import { liveId } from "@/lib/live-mappers"

import { listDecisions } from "../decisions/decisions-api"
import { fetchInbox, type InboxItem } from "../inbox/inbox-api"
import { useWorkspace } from "../workspace"
import { chatBadge, liveAgents, sidebarDms, sidebarRooms } from "./sidebar-logic"

const DEBOUNCE_MS = 600

/// #1034: an agent paused on a question for THIS person (the inbox's pending
/// prompt items), for the shell's "waiting on you" banner.
export type WaitingPrompt = Extract<InboxItem, { prompt: number }> & { kind: "prompt" }

type Remote = { project: number; summary: RoomSummary[] | null; inbox: number | null; decisions: number | null; waiting: WaitingPrompt[] | null }

export function useSidebarData() {
  const { live, currentUser, projectTasks, activeProject } = useWorkspace()
  const { pathname } = useLocation()
  const now = useLivenessNow()
  const project = activeProject ? liveId(activeProject.id) : null
  const [remote, setRemote] = useState<Remote | null>(null)

  // What moves the counts: the newest message, and my own read cursors.
  const lastMessage = live?.agentMessages.reduce((max, m) => ("id" in m ? Math.max(max, m.id) : max), 0) ?? 0
  const myCursors =
    live?.channelReadCursors
      .filter((c) => c.member_kind === "user" && c.member_user === currentUser?.id)
      .map((c) => `${c.channel}:${c.last_read_message ?? 0}`)
      .join(",") ?? ""
  // #1034: a prompt raised or answered arrives on App's one stream (the row is
  // upserted even when the chat slice isn't loaded), so it moves the signal
  // and the banner follows within the debounce.
  const promptSig = live?.agentPrompts.map((p) => `${p.id}:${p.status}`).join(",") ?? ""
  const signal = `${lastMessage}|${myCursors}|${pathname}|${promptSig}`

  useEffect(() => {
    if (project == null) return
    const ctl = new AbortController()
    const t = setTimeout(() => {
      // Each read stands alone: one failing keeps the others (and the last
      // good value of its own, rather than flashing the badge away).
      void Promise.all([
        fetchRoomSummaries(project, ctl.signal).catch(() => undefined),
        fetchInbox("needs_you", project, ctl.signal).catch(() => undefined),
        listDecisions(project, ctl.signal)
          .then((ds) => ds.filter((d) => d.status === "open").length)
          .catch(() => undefined),
      ]).then(([summary, page, decisions]) => {
        const inbox = page?.counts.needs_you
        const waiting = page?.items.filter((i): i is WaitingPrompt => i.kind === "prompt" && i.can_answer !== false)
        if (ctl.signal.aborted) return
        setRemote((cur) => {
          const same = cur?.project === project ? cur : null
          return {
            project,
            summary: summary === undefined ? (same?.summary ?? null) : summary,
            inbox: inbox === undefined ? (same?.inbox ?? null) : inbox,
            decisions: decisions === undefined ? (same?.decisions ?? null) : decisions,
            waiting: waiting === undefined ? (same?.waiting ?? null) : waiting,
          }
        })
      })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [project, signal])

  const current = remote?.project === project ? remote : null
  const summary = current?.summary ?? null
  const rooms = useMemo(() => sidebarRooms(live, currentUser, summary), [live, currentUser, summary])
  const dms = useMemo(() => sidebarDms(live, currentUser, summary, now), [live, currentUser, summary, now])
  const agents = useMemo(() => liveAgents(live, projectTasks, now), [live, projectTasks, now])
  const chat = useMemo(() => chatBadge([...rooms, ...dms]), [rooms, dms])

  return { rooms, dms, agents, chat, inbox: current?.inbox ?? 0, decisions: current?.decisions ?? 0, waiting: current?.waiting ?? [] }
}
