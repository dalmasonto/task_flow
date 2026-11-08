import { describe, expect, it } from "vitest"

import type { TaskflowAgentMessage, TaskflowAgentSession } from "@/api/client"

import { agentConnectState, handshakeStage, initCommand, kickoffBody, linkDrafts, projectRoom, taskflowJson, validateAgents, type AgentDraft, type LinkedAgent } from "./onboarding-logic"

const msg = (id: number, agent: number | null): TaskflowAgentMessage =>
  ({ id, sender_kind: agent == null ? "user" : "agent", sender_agent: agent }) as unknown as TaskflowAgentMessage

describe("validateAgents", () => {
  it("accepts two named agents with distinct profiles", () => {
    expect(
      validateAgents([
        { model: "claude", displayName: "Claude (main)", profile: "main" },
        { model: "codex", displayName: "reviewer", profile: "reviewer" },
      ]),
    ).toEqual([null, null])
  })
  it("refuses a shared profile, a bad profile and a blank name", () => {
    const e = validateAgents([
      { model: "claude", displayName: " ", profile: "main" },
      { model: "codex", displayName: "x", profile: "main" },
      { model: "codex", displayName: "y", profile: "Bad Profile" },
    ])
    expect(e[0]).toMatch(/name/)
    expect(e[1]).toMatch(/own profile/)
    expect(e[2]).toMatch(/Profile/)
  })
})

describe("initCommand", () => {
  it("names only the harnesses taskflow init knows, once each", () => {
    expect(initCommand(["claude", "codex", "claude"])).toContain("taskflow init --harness claude,codex")
    expect(initCommand(["deepseek"])).toMatch(/taskflow init$/)
  })
})

describe("taskflowJson", () => {
  it("writes every profile, the first as default, and flags a missing key", () => {
    const j = JSON.parse(
      taskflowJson("https://api.example.com", 7, [
        { model: "claude", displayName: "Claude (main)", profile: "main", agentId: 1, key: "tfk_a" },
        { model: "codex", displayName: "reviewer", profile: "reviewer", agentId: 2, key: null },
      ]),
    )
    expect(j).toMatchObject({ server: "https://api.example.com", project: 7, default_profile: "main" })
    expect(j.profiles.main.key).toBe("tfk_a")
    expect(j.profiles.reviewer.key).toMatch(/AGENTS_PAGE/)
  })
})

describe("agentConnectState", () => {
  const now = Date.parse("2026-11-08T10:00:00Z")
  const s = (agent: number, status: string, last: string) => ({ agent, status, last_seen_at: last }) as unknown as TaskflowAgentSession
  it("is connected only with a live, recent session", () => {
    expect(agentConnectState(1, [s(1, "connected", "2026-11-08T09:59:50Z")], now).state).toBe("connected")
    expect(agentConnectState(1, [s(1, "connected", "2026-11-08T08:00:00Z")], now).state).toBe("waiting")
    expect(agentConnectState(1, [s(2, "connected", "2026-11-08T09:59:50Z")], now).state).toBe("waiting")
  })
})

describe("handshake", () => {
  it("addresses the second agent by chip, so it gets the notice", () => {
    expect(kickoffBody({ displayName: "Claude (main)" }, { displayName: "reviewer", agentId: 9 })).toContain("[@reviewer](agent:9)")
  })
  it("moves through its stages from the room's messages", () => {
    expect(handshakeStage([], null, 1, 2)).toBe("not-started")
    expect(handshakeStage([msg(10, null)], 10, 1, 2)).toBe("first-speaking")
    expect(handshakeStage([msg(10, null), msg(11, 1)], 10, 1, 2)).toBe("waiting-reply")
    expect(handshakeStage([msg(10, null), msg(11, 1), msg(12, 2)], 10, 1, 2)).toBe("complete")
  })
  it("ignores the second agent speaking before the first", () => {
    expect(handshakeStage([msg(10, null), msg(11, 2), msg(12, 1)], 10, 1, 2)).toBe("waiting-reply")
  })
})

describe("projectRoom", () => {
  const ch = (id: number, extra: Partial<{ kind: string; archived: boolean; is_design: boolean }> = {}) =>
    ({ id, kind: "project", archived: false, is_design: false, ...extra }) as Parameters<typeof projectRoom>[0][number]
  it("skips the design room even when it sorts first", () => {
    expect(projectRoom([ch(24, { is_design: true }), ch(23)])?.id).toBe(23)
    expect(projectRoom([ch(5, { is_design: true }), ch(9)])?.id).toBe(9)
  })
  it("skips archived and non-project rooms, and is null when none is left", () => {
    expect(projectRoom([ch(1, { archived: true }), ch(2, { kind: "task" }), ch(3)])?.id).toBe(3)
    expect(projectRoom([ch(1, { is_design: true })])).toBeNull()
  })
})

describe("linkDrafts", () => {
  const drafts: AgentDraft[] = [
    { model: "claude", displayName: "Claude (main)", profile: "main" },
    { model: "codex", displayName: "reviewer (codex)", profile: "reviewer" },
  ]
  it("keeps agent 1's key when agent 2 fails, and a retry links only agent 2", async () => {
    let stored: LinkedAgent[] = []
    const calls: string[] = []
    let failSecond = true
    const link = async (d: AgentDraft) => {
      calls.push(d.profile)
      if (d.profile === "reviewer" && failSecond) throw new Error("429")
      return { agent_id: calls.length, display_name: d.displayName, key: `tfk_${d.profile}` }
    }
    await expect(linkDrafts(drafts, stored, link, (s) => (stored = s))).rejects.toThrow("429")
    expect(stored.map((a) => [a.profile, a.key])).toEqual([["main", "tfk_main"]])

    failSecond = false
    const out = await linkDrafts(drafts, stored, link, (s) => (stored = s))
    expect(calls).toEqual(["main", "reviewer", "reviewer"]) // exactly one agent 1
    expect(out.map((a) => [a.profile, a.key])).toEqual([["main", "tfk_main"], ["reviewer", "tfk_reviewer"]])
    expect(stored).toEqual(out)
  })
})
