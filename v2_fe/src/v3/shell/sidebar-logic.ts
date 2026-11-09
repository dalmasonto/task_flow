/// The sidebar's live sections from the design's `tf-shell`: Live now, Rooms
/// and Direct messages, plus the Chat badge. Pure, so it is tested without
/// rendering (sidebar-logic.test.ts).
///
/// Unread and mention counts come from the server's room summary (#5983), not
/// from loaded messages: the sidebar is on every page, and only the chat page
/// loads message history, so counting loaded messages would read 0 elsewhere.
import type { AuthUser } from "@/lib/auth-api"
import type { RoomSummary } from "@/lib/chat-summary-api"
import { chatIdToSlug, isAgentOnline, mapLiveChannelChats, mapLiveDirectChats } from "@/lib/live-mappers"
import type { TaskflowWorkspace } from "@/lib/taskflow-api"
import type { Task } from "@/lib/workspace-view"

import { guessModel, type ModelId } from "../components/actor-models"

export type SidebarChat = {
  id: string
  title: string
  href: string
  unread: number
  mentions: number
  /// DMs only: the agent on the other end, for its avatar.
  agentModel: ModelId | null
  agentId: number | null
  online: boolean
}

export type LiveAgent = {
  id: number
  name: string
  model: ModelId | null
  /// What it is doing: its in-progress task, else "Online".
  doing: string
}

function counts(summary: RoomSummary[] | null, channel: number | undefined) {
  const s = channel == null ? undefined : summary?.find((r) => r.channel === channel)
  const unread = s?.unread ?? 0
  return { unread, mentions: Math.min(s?.mentions ?? 0, unread) }
}

export function sidebarRooms(live: TaskflowWorkspace | null, user: AuthUser | null, summary: RoomSummary[] | null): SidebarChat[] {
  if (!live?.agentChannelsLoaded) return []
  return mapLiveChannelChats(live, user).map((c) => ({
    id: c.id,
    title: c.title,
    href: `/v3/chat/${chatIdToSlug(c.id)}`,
    ...counts(summary, c.liveChannelId),
    agentModel: null,
    agentId: null,
    online: false,
  }))
}

export function sidebarDms(live: TaskflowWorkspace | null, user: AuthUser | null, summary: RoomSummary[] | null, now: number): SidebarChat[] {
  if (!live?.agentChannelsLoaded) return []
  return mapLiveDirectChats(live, user, now).map((c) => {
    const agent = c.liveAgentId == null ? undefined : live.agents.find((a) => a.id === c.liveAgentId)
    return {
      id: c.id,
      title: c.title,
      href: `/v3/chat/${chatIdToSlug(c.id)}`,
      ...counts(summary, c.liveChannelId),
      agentModel: agent ? (guessModel(agent.runtime) ?? guessModel(agent.display_name)) : null,
      agentId: agent?.id ?? null,
      online: agent ? isAgentOnline(agent.id, live.agents, [], now) : false,
    }
  })
}

/// Working agents first (they have a task in progress), then the rest online,
/// each group by name.
export function liveAgents(live: TaskflowWorkspace | null, tasks: Task[], now: number): LiveAgent[] {
  if (!live) return []
  const rows = live.agents
    .filter((a) => a.status !== "revoked" && isAgentOnline(a.id, live.agents, [], now))
    .map((a) => {
      const task = tasks.find((t) => t.owner === a.display_name && (t.liveStatus ?? "") === "in_progress")
      return { id: a.id, name: a.display_name, model: guessModel(a.runtime) ?? guessModel(a.display_name), doing: task ? `#${task.id} ${task.title}` : "Online" }
    })
  const working = (r: LiveAgent) => Number(r.doing !== "Online")
  return rows.sort((x, y) => working(y) - working(x) || x.name.localeCompare(y.name))
}

/// The Chat item's badge: total unread across rooms and DMs, and whether any
/// of it mentions me (the design's "@12" in primary).
export function chatBadge(rows: SidebarChat[]): { unread: number; mention: boolean } {
  return { unread: rows.reduce((n, r) => n + r.unread, 0), mention: rows.some((r) => r.mentions > 0) }
}

/// "99+" past two digits, like the chat list.
export function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n)
}
