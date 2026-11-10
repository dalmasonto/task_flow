/// The v3 conversation list's rules (tested in chat-logic.test.ts).
import type { AgentChatContext } from "@/lib/workspace-view"

export type ChatFilter = "all" | "unread" | "mentions" | "threads" | "agents"

export type ChatRow = {
  id: string
  title: string
  preview: string
  at: string | null
  unread: number
  /// Unread messages that mention or target me (#5983), from the server summary.
  mentions: number
  channelId: number | null
  kind: "room" | "agent" | "person" | "group"
  agentName: string | null
  online: boolean
  /// Rooms: a few members to draw as the room's avatar (agents first).
  faces?: { name: string; agent: boolean }[]
}

/// One list row. The preview is the last message as "Who: text", flattened
/// to a line; "You" for your own (v2's mapper marks those `from: "user"`).
/// `[@Name](user:3)` / `(agent:5)` / `(page:/x)` → `@Name`, as the server's
/// summary does, so one-line previews never show raw chip markup.
export function stripChips(text: string): string {
  return text.replace(/\[@([^\]\n]+)\]\((?:user|agent|page):[^)\s]+\)/g, "@$1")
}

export function chatRow(chat: AgentChatContext): ChatRow {
  const last = [...chat.messages].reverse().find((m) => m.body.trim())
  const who = last ? (last.from === "user" || last.from === "You" ? "You" : last.from.split(" (")[0]) : null
  const text = last ? stripChips(last.body).replace(/[#*_`>[\]()]/g, "").replace(/\s+/g, " ").trim() : ""
  const kind: ChatRow["kind"] = chat.mode === "channel" ? "room" : chat.liveAgentId ? "agent" : chat.liveMemberUserId ? "person" : "group"
  return {
    id: chat.id,
    title: chat.title,
    preview: last ? `${who}: ${text}` : chat.detail.replace(/\s+/g, " ").trim(),
    at: last?.createdAt ?? null,
    unread: chat.unread,
    mentions: 0,
    channelId: chat.liveChannelId ?? null,
    faces: [...chat.members].sort((a, b) => Number(b.type === "agent") - Number(a.type === "agent")).slice(0, 3).map((m) => ({ name: m.name, agent: m.type === "agent" })),
    kind,
    agentName: chat.liveAgentId ? chat.title : null,
    online: chat.online ?? false,
  }
}

export function filterChats(rows: ChatRow[], filter: ChatFilter, query: string): ChatRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (filter === "all" || (filter === "unread" && r.unread > 0) || (filter === "mentions" && r.mentions > 0) || (filter === "agents" && r.kind === "agent")) &&
      (!q || r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)),
  )
}

/// Newest activity first, conversations with nothing yet at the end.
export function byRecent(a: ChatRow, b: ChatRow): number {
  return (b.at ?? "").localeCompare(a.at ?? "")
}

/// Fold the server's mention counts into the rows. The live unread count is
/// the truth for "is anything new": opening a room zeroes it at once, so the
/// mention badge clears with it instead of waiting for the next summary.
export function withMentions(rows: ChatRow[], summary: { channel: number; mentions: number }[] | null): ChatRow[] {
  if (!summary) return rows
  const by = new Map(summary.map((s) => [s.channel, s.mentions]))
  return rows.map((r) => {
    const m = r.channelId == null ? 0 : (by.get(r.channelId) ?? 0)
    return { ...r, mentions: r.unread > 0 ? Math.min(m, r.unread) : 0 }
  })
}

/// chat.html: "@3" in primary when I'm mentioned, a muted "3" otherwise.
export function rowBadge(r: ChatRow): { text: string; mention: boolean; label: string } | null {
  if (r.unread <= 0) return null
  const n = r.unread > 99 ? "99+" : String(r.unread)
  return r.mentions > 0 ? { text: `@${n}`, mention: true, label: `${r.unread} unread, you are mentioned` } : { text: n, mention: false, label: `${r.unread} unread` }
}

/// chat-inbox.html's thread line: "#design-room, 4 replies, Claude replied last".
export function followLine(t: { replies: number; last_repliers: string[] }, room: string | null): string {
  const parts = [`${t.replies} ${t.replies === 1 ? "reply" : "replies"}`]
  if (room) parts.unshift(`#${room}`)
  const who = t.last_repliers[0]?.split(" (")[0]
  if (who) parts.push(`${who} replied last`)
  return parts.join(", ")
}

/// chat.html's list times: "15:21" today, "Yesterday", the weekday within the
/// last week ("Mon"), then a date ("24 Jul", with the year once it isn't this
/// year's). Local time, 24-hour like the design.
export function listTime(at: string, now: number): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ""
  const today = new Date(now)
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000)
  if (days <= 0) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  if (days === 1) return "Yesterday"
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "short" })
  return d.toLocaleDateString("en-GB", d.getFullYear() === today.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" })
}

/// Does a message body mention this person by identity (`[@Name](user:3)`),
/// or everyone (`@here` / `@all`)? Drives chat.html's "for you" row tint.
export function mentionsUser(body: string, userId: number): boolean {
  return body.includes(`](user:${userId})`) || /(^|\s)@(here|all|everyone)\b/i.test(body)
}
