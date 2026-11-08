import { describe, expect, it } from "vitest"

import type { AgentChatContext } from "@/lib/workspace-view"

import { byRecent, chatRow, filterChats } from "./chat-logic"

const chat = (id: string, extra: Partial<AgentChatContext> = {}) =>
  ({ id, mode: "channel", title: id, detail: "A room.", status: "", members: [], primaryAgent: "", unread: 0, messages: [], ...extra }) as AgentChatContext

describe("chatRow", () => {
  it("previews the last message as who: text, with You for mine", () => {
    const c = chat("r", { messages: [{ id: "1", from: "Claude (main)", body: "On **it**, #1025", time: "", status: "", createdAt: "2026-11-08T10:00:00Z" }] as AgentChatContext["messages"] })
    expect(chatRow(c).preview).toBe("Claude: On it, 1025")
    const mine = chat("r", { messages: [{ id: "1", from: "user", body: "hi", time: "", status: "" }] as AgentChatContext["messages"] })
    expect(chatRow(mine).preview).toBe("You: hi")
  })
  it("knows a room from an agent DM, a person DM and a group", () => {
    expect(chatRow(chat("a")).kind).toBe("room")
    expect(chatRow(chat("b", { mode: "direct", liveAgentId: 5 })).kind).toBe("agent")
    expect(chatRow(chat("c", { mode: "direct", liveMemberUserId: 3 })).kind).toBe("person")
    expect(chatRow(chat("d", { mode: "direct" })).kind).toBe("group")
  })
})

describe("filterChats", () => {
  const rows = [chatRow(chat("design", { unread: 2 })), chatRow(chat("reviewer", { mode: "direct", liveAgentId: 5 }))]
  it("filters by unread, agents and a search", () => {
    expect(filterChats(rows, "unread", "").map((r) => r.id)).toEqual(["design"])
    expect(filterChats(rows, "agents", "").map((r) => r.id)).toEqual(["reviewer"])
    expect(filterChats(rows, "all", "REV").map((r) => r.id)).toEqual(["reviewer"])
  })
  it("sorts newest first, empty last", () => {
    const a = { ...rows[0], at: "2026-11-08T09:00:00Z" }
    const b = { ...rows[1], at: null }
    const c = { ...rows[0], id: "x", at: "2026-11-08T10:00:00Z" }
    expect([a, b, c].sort(byRecent).map((r) => r.id)).toEqual(["x", "design", "reviewer"])
  })
})
