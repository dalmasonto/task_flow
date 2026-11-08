import { describe, expect, it } from "vitest"

import type { TaskflowAgent, TaskflowAgentSession, TaskflowTask } from "@/api/client"

import { AGENT_CAPABILITIES } from "@/lib/agent-scopes"

import { agentRows, countByState, keyScopes } from "./agents-logic"

const now = Date.parse("2026-11-08T12:00:00Z")
const agent = (id: number, name: string, extra: Partial<TaskflowAgent> = {}) => ({ id, display_name: name, runtime: null, status: "offline", last_seen_at: null, ...extra }) as TaskflowAgent
const live = (agentId: number) => ({ agent: agentId, status: "connected", last_seen_at: new Date(now - 5_000).toISOString() }) as TaskflowAgentSession

describe("agentRows", () => {
  it("sorts live, then idle, then offline, and skips revoked agents", () => {
    const rows = agentRows(
      [agent(1, "Zed (claude)"), agent(2, "reviewer (codex)", { runtime: "codex" }), agent(3, "Idle one"), agent(4, "Gone", { status: "revoked" })],
      [live(2), live(3)],
      [{ id: 9, title: "Design review", status: "in_progress", assigned_agent_id: 2 } as TaskflowTask],
      now,
    )
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      [2, "live"],
      [3, "idle"],
      [1, "offline"],
    ])
    expect(rows[0].task).toEqual({ id: 9, title: "Design review" })
    expect(rows[0].model).toBe("codex")
    expect(countByState(rows)).toEqual({ all: 3, live: 1, idle: 1, offline: 1 })
  })
})

describe("keyScopes", () => {
  it("sends denials for default-on capabilities turned off and grants for opt-in ones turned on", () => {
    const defaults = Object.fromEntries(AGENT_CAPABILITIES.map((c) => [c.id, c.defaultOn]))
    expect(keyScopes(defaults)).toEqual({ scopes: [], denied_scopes: [] })
    const optIn = AGENT_CAPABILITIES.find((c) => !c.defaultOn)
    const on = AGENT_CAPABILITIES.find((c) => c.defaultOn)!
    const changed = { ...defaults, [on.id]: false, ...(optIn ? { [optIn.id]: true } : {}) }
    expect(keyScopes(changed)).toEqual({ scopes: optIn ? [optIn.id] : [], denied_scopes: [on.id] })
  })
})
