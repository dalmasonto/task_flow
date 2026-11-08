import { describe, expect, it } from "vitest"

import type { TaskflowAgent, TaskflowAgentSession } from "@/api/client"
import type { Task } from "@/lib/workspace-view"

import { paletteAgents, paletteTasks, taskSearchValue } from "./palette-logic"

const agent = (id: number, display_name: string, extra: Partial<TaskflowAgent> = {}) =>
  ({ id, display_name, runtime: null, status: "offline", last_seen_at: null, ...extra }) as TaskflowAgent
const now = Date.parse("2026-11-08T02:00:00Z")
const liveSession = (agentId: number) =>
  ({ agent: agentId, status: "connected", last_seen_at: new Date(now - 5_000).toISOString() }) as TaskflowAgentSession

describe("paletteAgents", () => {
  it("puts online agents first, drops revoked ones, and reads the model", () => {
    const rows = paletteAgents(
      [agent(1, "Zed (claude)"), agent(2, "reviewer (codex)", { runtime: "codex" }), agent(3, "Gone", { status: "revoked" })],
      [liveSession(2)],
      now,
    )
    expect(rows.map((r) => [r.id, r.status, r.model])).toEqual([
      [2, "running", "codex"],
      [1, "offline", "claude"],
    ])
    expect(rows[1].detail).toBe("Never connected")
  })
})

describe("tasks", () => {
  it("matches a task by every way people type its number", () => {
    expect(taskSearchValue({ id: "721", title: "Agents can DM" })).toBe("#721 TSK721 721 Agents can DM")
  })
  it("lists open work before done work", () => {
    const t = (id: string, status: Task["status"]) => ({ id, title: id, status }) as Task
    expect(paletteTasks([t("1", "done"), t("2", "in_progress"), t("3", "not_started")]).map((x) => x.id)).toEqual(["2", "3", "1"])
  })
})

describe("activeNavId", () => {
  it("doesn't mistake the new-project page for project settings", async () => {
    const { activeNavId } = await import("./nav")
    expect(activeNavId("/v3/projects/new")).toBeNull()
    expect(activeNavId("/v3/project/members")).toBe("settings")
    expect(activeNavId("/v3/tasks/12")).toBe("board")
    expect(activeNavId("/v3/sessions")).toBe("board")
  })
})
