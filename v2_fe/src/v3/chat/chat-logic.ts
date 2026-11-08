/// The v3 conversation list's rules (tested in chat-logic.test.ts).
import type { AgentChatContext } from "@/lib/workspace-view"

export type ChatFilter = "all" | "unread" | "agents"

export type ChatRow = {
  id: string
  title: string
  preview: string
  at: string | null
  unread: number
  kind: "room" | "agent" | "person" | "group"
  agentName: string | null
  online: boolean
}

/// One list row. The preview is the last message as "Who: text", flattened
/// to a line; "You" for your own (v2's mapper marks those `from: "user"`).
export function chatRow(chat: AgentChatContext): ChatRow {
  const last = [...chat.messages].reverse().find((m) => m.body.trim())
  const who = last ? (last.from === "user" || last.from === "You" ? "You" : last.from.split(" (")[0]) : null
  const text = last ? last.body.replace(/[#*_`>[\]()]/g, "").replace(/\s+/g, " ").trim() : ""
  const kind: ChatRow["kind"] = chat.mode === "channel" ? "room" : chat.liveAgentId ? "agent" : chat.liveMemberUserId ? "person" : "group"
  return {
    id: chat.id,
    title: chat.title,
    preview: last ? `${who}: ${text}` : chat.detail.replace(/\s+/g, " ").trim(),
    at: last?.createdAt ?? null,
    unread: chat.unread,
    kind,
    agentName: chat.liveAgentId ? chat.title : null,
    online: chat.online ?? false,
  }
}

export function filterChats(rows: ChatRow[], filter: ChatFilter, query: string): ChatRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (filter === "all" || (filter === "unread" && r.unread > 0) || (filter === "agents" && r.kind === "agent")) &&
      (!q || r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)),
  )
}

/// Newest activity first, conversations with nothing yet at the end.
export function byRecent(a: ChatRow, b: ChatRow): number {
  return (b.at ?? "").localeCompare(a.at ?? "")
}
