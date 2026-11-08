import { describe, expect, it } from "vitest"

import type { TaskflowAgent, TaskflowTask } from "@/api/client"
import type { Task } from "@/lib/workspace-view"

import { activeView, boardRepos, cardInfo, EMPTY_FILTER, filterBoard, filterIsActive, viewFilter } from "./board-logic"

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
