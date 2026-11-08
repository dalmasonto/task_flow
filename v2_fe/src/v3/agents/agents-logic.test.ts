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

describe("describeRule", () => {
  const base = { target_task: null, target_message: null, watch_channel: null, mentions_only: false, fire_at: null }
  it("says each trigger as a sentence", async () => {
    const { describeRule } = await import("./agents-logic")
    const room = (id: number) => `#room-${id}`
    expect(describeRule({ ...base, trigger: "task_unblocked", target_task: 721 }, room)).toBe("When #721 is unblocked")
    expect(describeRule({ ...base, trigger: "reply_to_message", target_message: 5700 }, room)).toBe("When someone replies to #MSG5700")
    expect(describeRule({ ...base, trigger: "message_in_room", watch_channel: 1, mentions_only: true }, room)).toBe("When it's mentioned in #room-1")
    expect(describeRule({ ...base, trigger: "message_in_room" }, room)).toBe("On any message")
  })
})
