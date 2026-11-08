import { describe, expect, it } from "vitest"

import type { AgentChatContext } from "@/lib/workspace-view"

import { byRecent, chatRow, filterChats, followLine, rowBadge, stripChips, withMentions } from "./chat-logic"

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

describe("mentions and badges (#5983)", () => {
  const base = chatRow(chat("live:channel:7", { liveChannelId: 7, unread: 3 }))
  it("takes mentions from the server summary, never more than the live unread", () => {
    const [r] = withMentions([base], [{ channel: 7, mentions: 5 }])
    expect(r.mentions).toBe(3)
    expect(withMentions([{ ...base, unread: 0 }], [{ channel: 7, mentions: 2 }])[0].mentions).toBe(0)
    expect(withMentions([base], null)[0].mentions).toBe(0)
    expect(withMentions([base], [{ channel: 8, mentions: 2 }])[0].mentions).toBe(0)
  })
  it("filters the Mentions tab", () => {
    const rows = withMentions([base, chatRow(chat("live:channel:8", { liveChannelId: 8, unread: 1 }))], [{ channel: 7, mentions: 1 }])
    expect(filterChats(rows, "mentions", "").map((r) => r.id)).toEqual(["live:channel:7"])
  })
  it("badges @N in primary when mentioned, a plain count otherwise", () => {
    expect(rowBadge({ ...base, mentions: 1 })).toEqual({ text: "@3", mention: true, label: "3 unread, you are mentioned" })
    expect(rowBadge(base)).toEqual({ text: "3", mention: false, label: "3 unread" })
    expect(rowBadge({ ...base, unread: 120 })?.text).toBe("99+")
    expect(rowBadge({ ...base, unread: 0 })).toBeNull()
  })
  it("describes a followed thread like the design", () => {
    expect(followLine({ replies: 4, last_repliers: ["Claude (main)", "Dalmas"] }, "design-room")).toBe("#design-room, 4 replies, Claude replied last")
    expect(followLine({ replies: 1, last_repliers: [] }, null)).toBe("1 reply")
  })
})

describe("stripChips", () => {
  it("reduces mention chips to @Name, leaving other links and loose brackets alone", () => {
    expect(stripChips("hi [@leakprobe](user:4) and [@zz-qa bot](agent:7), see [@Board](page:/board)")).toBe("hi @leakprobe and @zz-qa bot, see @Board")
    expect(stripChips("a [@x](http://a.b) and [@y")).toBe("a [@x](http://a.b) and [@y")
  })
  it("previews a mention as a name, not markup", () => {
    const c = chat("r", { messages: [{ id: "1", from: "zz-qa bot", body: "[@leakprobe](user:4) QA ping", time: "", status: "" }] as AgentChatContext["messages"] })
    expect(chatRow(c).preview).toBe("zz-qa bot: @leakprobe QA ping")
  })
})
