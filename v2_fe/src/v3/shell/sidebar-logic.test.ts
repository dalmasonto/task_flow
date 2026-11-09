import { describe, expect, it } from "vitest"

import type { AuthUser } from "@/lib/auth-api"
import type { TaskflowWorkspace } from "@/lib/taskflow-api"
import type { Task } from "@/lib/workspace-view"

import { badgeText, chatBadge, liveAgents, sidebarDms, sidebarRooms } from "./sidebar-logic"

const NOW = Date.parse("2026-11-10T00:00:00Z")
const me = { id: 1, username: "dalmas", email: "d@example.com" } as unknown as AuthUser

function room(id: number, title: string, extra: Record<string, unknown> = {}) {
  return { id, project: 2, title, topic: null, kind: "project", archived: false, is_public: true, is_design: false, ...extra }
}

function agent(id: number, name: string, status: string, seen: string | null = "2026-11-09T23:59:50Z") {
  return { id, project: 2, display_name: name, runtime: name.includes("codex") ? "codex" : "claude-code", status, last_seen_at: seen }
}

function workspace(over: Partial<Record<keyof TaskflowWorkspace, unknown>> = {}): TaskflowWorkspace {
  return {
    agentChannelsLoaded: true,
    agentChannels: [],
    agentChannelMembers: [],
    agentMessages: [],
    messageAttachments: [],
    channelReadCursors: [],
    members: [],
    agents: [],
    agentSessions: [],
    ...over,
  } as unknown as TaskflowWorkspace
}

describe("sidebarRooms", () => {
  it("is empty until the channel list has loaded (not 'no rooms')", () => {
    expect(sidebarRooms(workspace({ agentChannelsLoaded: false, agentChannels: [room(1, "Project room")] }), me, null)).toEqual([])
  })

  it("takes unread and mentions from the server summary, and leaves out the design room", () => {
    const live = workspace({ agentChannels: [room(1, "Project room"), room(17, "Design room", { is_design: true })] })
    const rows = sidebarRooms(live, me, [{ channel: 1, is_design: false, archived: false, unread: 3, mentions: 5, last: null }])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: "Project room", unread: 3, mentions: 3, href: expect.stringMatching(/^\/v3\/chat\//) })
  })

  it("reads 0 without a summary (older server)", () => {
    expect(sidebarRooms(workspace({ agentChannels: [room(1, "Project room")] }), me, null)[0]).toMatchObject({ unread: 0, mentions: 0 })
  })
})

describe("sidebarDms", () => {
  it("names an agent DM for its agent and carries its model and liveness", () => {
    const live = workspace({
      agents: [agent(5, "reviewer (codex)", "connected")],
      agentChannels: [room(40, "dm", { kind: "direct", is_public: false })],
      agentChannelMembers: [
        { id: 1, channel: 40, member_kind: "user", user: 1, agent: null, display_name: "dalmas" },
        { id: 2, channel: 40, member_kind: "agent", user: null, agent: 5, display_name: "reviewer (codex)" },
      ],
    })
    const [dm] = sidebarDms(live, me, null, NOW)
    expect(dm).toMatchObject({ agentId: 5, agentModel: "codex", online: true })
  })
})

describe("liveAgents", () => {
  const tasks = [{ id: "1146", title: "Sidebar parity", owner: "Claude (main)", liveStatus: "in_progress" }] as unknown as Task[]

  it("lists online agents, working ones first, with what they are on", () => {
    const live = workspace({
      agents: [agent(5, "reviewer (codex)", "idle"), agent(1, "Claude (main)", "busy"), agent(9, "gone", "offline"), agent(7, "old", "busy", "2026-11-01T00:00:00Z")],
    })
    expect(liveAgents(live, tasks, NOW).map((a) => [a.name, a.doing])).toEqual([
      ["Claude (main)", "#1146 Sidebar parity"],
      ["reviewer (codex)", "Online"],
    ])
  })
})

describe("chat badge", () => {
  it("sums unread and flags a mention", () => {
    const rows = [
      { unread: 2, mentions: 0 },
      { unread: 3, mentions: 1 },
    ] as Parameters<typeof chatBadge>[0]
    expect(chatBadge(rows)).toEqual({ unread: 5, mention: true })
    expect(chatBadge([])).toEqual({ unread: 0, mention: false })
  })

  it("caps the text at 99+", () => {
    expect(badgeText(7)).toBe("7")
    expect(badgeText(120)).toBe("99+")
  })
})
