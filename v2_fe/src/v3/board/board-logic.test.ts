import { describe, expect, it } from "vitest"

import type { TaskflowAgent, TaskflowTask } from "@/api/client"
import type { Task } from "@/lib/workspace-view"

import { activeView, boardRepos, cardInfo, EMPTY_FILTER, filterBoard, filterIsActive, leaseLabel, leaseLeft, viewFilter } from "./board-logic"

const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, title: `Task ${id}`, priority: "normal", status: "in_progress", owner: "", operatorName: "", tags: [], ...extra }) as Task
const raw = (id: number, extra: Partial<TaskflowTask> = {}) =>
  ({ id, assigned_agent_id: null, assigned_user: null, assignee_label: null, review_gate: null, github_repo: null, due_at: null, ...extra }) as TaskflowTask
const now = Date.parse("2026-11-08T12:00:00Z")

describe("cardInfo", () => {
  it("names an agent assignee with its model, and shortens the repo", () => {
    const agents = [{ id: 5, display_name: "reviewer (codex)", runtime: "codex" }] as TaskflowAgent[]
    const c = cardInfo(task("7"), raw(7, { assigned_agent_id: 5, github_repo: "dalmasonto/task_flow", review_gate: " codex review " }), agents, 2, now)
    expect(c.assignee).toEqual({ name: "reviewer (codex)", model: "codex", isAgent: true })
    expect([c.repo, c.gate, c.files]).toEqual(["task_flow", "codex review", 2])
  })
  it("marks an overdue open task, and drops the due date once done", () => {
    expect(cardInfo(task("1"), raw(1, { due_at: "2026-11-01T00:00:00Z" }), [], 0, now).due?.overdue).toBe(true)
    expect(cardInfo(task("1", { status: "done" }), raw(1, { due_at: "2026-11-01T00:00:00Z" }), [], 0, now).due).toBeNull()
  })
  it("treats the old placeholder gate as no gate", () => {
    expect(cardInfo(task("4"), raw(4, { review_gate: "No review gate defined." }), [], 0, now).gate).toBeNull()
  })
  it("leaves unknown fields off instead of inventing them", () => {
    const c = cardInfo(task("3"), undefined, [], 0, now)
    expect([c.assignee, c.gate, c.repo, c.due]).toEqual([null, null, null, null])
  })
})

describe("filterBoard", () => {
  const tasks = [task("1", { priority: "high" }), task("2"), task("3")]
  const raws = new Map([
    ["1", raw(1, { assigned_agent_id: 5, github_repo: "a/x" })],
    ["2", raw(2, { assigned_user: 9, github_repo: "a/y" })],
    ["3", raw(3)],
  ])
  const ids = (f: Partial<typeof EMPTY_FILTER>, me: number | null = 9) => filterBoard(tasks, raws, { ...EMPTY_FILTER, ...f }, me).map((t) => t.id)
  it("filters by who it's assigned to", () => {
    expect(ids({ assignee: "agents" })).toEqual(["1"])
    expect(ids({ assignee: "people" })).toEqual(["2"])
    expect(ids({ assignee: "unassigned" })).toEqual(["3"])
    expect(ids({ assignee: "mine" })).toEqual(["2"])
    expect(ids({ assignee: "mine" }, null)).toEqual([])
  })
  it("combines priority, repo and search", () => {
    expect(ids({ priority: "high" })).toEqual(["1"])
    expect(ids({ repo: "a/y" })).toEqual(["2"])
    expect(ids({ search: "#3" })).toEqual(["3"])
    expect(filterIsActive(EMPTY_FILTER)).toBe(false)
    expect(filterIsActive({ ...EMPTY_FILTER, search: " x " })).toBe(true)
  })
  it("lists repos only from loaded tasks", () => {
    expect(boardRepos(raws.values())).toEqual(["a/x", "a/y"])
  })
})

describe("saved views", () => {
  const tasks = [task("1", { status: "in_progress" }), task("2", { status: "blocked" }), task("3", { status: "review" })]
  const raws = new Map([
    ["1", raw(1, { assigned_agent_id: 5 })],
    ["2", raw(2, { assigned_user: 9 })],
    ["3", raw(3)],
  ])
  it("each preset keeps what its name says", () => {
    expect(filterBoard(tasks, raws, viewFilter("agents"), 9).map((t) => t.id)).toEqual(["1"])
    expect(filterBoard(tasks, raws, viewFilter("review"), 9).map((t) => t.id)).toEqual(["3"])
    expect(filterBoard(tasks, raws, viewFilter("blocked_me"), 9).map((t) => t.id)).toEqual(["2"])
  })
  it("recognises a preset, and stops once the filter is changed", () => {
    expect(activeView(viewFilter("review"))).toBe("review")
    expect(activeView(EMPTY_FILTER)).toBe("all")
    expect(activeView({ ...viewFilter("review"), search: "x" })).toBeNull()
  })
})

describe("leaseLeft / leaseLabel (#1126)", () => {
  const now = Date.parse("2026-11-08T12:00:00Z")
  const raw = (status: string, updated: string, agent: number | null = 7) => ({ assigned_agent_id: agent, status, updated_at: updated }) as Parameters<typeof leaseLeft>[0]
  it("runs from the later of the heartbeat and the last edit", () => {
    expect(leaseLeft(raw("in_progress", "2026-11-08T11:40:00Z"), { last_seen_at: "2026-11-08T11:50:00Z" }, 30, now)).toBe(20)
    expect(leaseLeft(raw("in_progress", "2026-11-08T11:55:00Z"), { last_seen_at: "2026-11-08T11:00:00Z" }, 30, now)).toBe(25)
    expect(leaseLeft(raw("not_started", "2026-11-08T11:00:00Z"), undefined, 30, now)).toBe(-30)
    expect(leaseLeft(raw("in_progress", "2026-11-08T11:30:40Z"), undefined, 30, now)).toBe(1)
  })
  it("applies only to claimed active work", () => {
    expect(leaseLeft(raw("partial_done", "2026-11-08T11:55:00Z"), undefined, 30, now)).toBeNull()
    expect(leaseLeft(raw("blocked", "2026-11-08T11:55:00Z"), undefined, 30, now)).toBeNull()
    expect(leaseLeft(raw("in_progress", "2026-11-08T11:55:00Z", null), undefined, 30, now)).toBeNull()
    expect(leaseLeft(raw("in_progress", "2026-11-08T11:55:00Z"), undefined, null, now)).toBeNull()
  })
  it("labels it", () => {
    expect(leaseLabel(42)).toBe("42m")
    expect(leaseLabel(65)).toBe("1h 5m")
    expect(leaseLabel(0)).toBe("Releasing")
    expect(leaseLabel(null)).toBeNull()
  })
})
