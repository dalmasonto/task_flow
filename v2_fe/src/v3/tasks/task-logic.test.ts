import { describe, expect, it } from "vitest"

import type { TaskflowTaskActivity, TaskflowTaskRelation } from "@/api/client"

import { activityLine, groupRelations, parseTaskNumber, relationToCreate, taskTimeline } from "./task-logic"

const act = (id: number, action: string, extra: Partial<TaskflowTaskActivity> = {}) =>
  ({ id, task: 7, action, actor_label: "Claude (main)", actor_kind: "agent", body_markdown: null, created_at: `2026-11-08T10:0${id}:00Z`, ...extra }) as TaskflowTaskActivity

describe("timeline", () => {
  it("reads events and comments the way people say them", () => {
    expect(activityLine(act(1, "status_changed", { body_markdown: "Not started → In progress" }))).toMatchObject({ comment: false, verb: "moved this task", body: "Not started → In progress", agent: true })
    expect(activityLine(act(2, "commented", { body_markdown: "Looks good" }))).toMatchObject({ comment: true, verb: "commented", body: "Looks good" })
    expect(activityLine(act(3, "some_new_action")).verb).toBe("some new action")
  })
  it("keeps only this task, oldest first, and can show comments only", () => {
    const rows = [act(3, "commented"), act(1, "created"), act(2, "updated", { task: 99 })]
    expect(taskTimeline(rows, 7).map((l) => l.id)).toEqual([1, 3])
    expect(taskTimeline(rows, 7, true).map((l) => l.id)).toEqual([3])
  })
})

describe("relations", () => {
  const rel = (id: number, source: number, target: number, kind: TaskflowTaskRelation["kind"]) => ({ id, source_task: source, target_task: target, kind }) as TaskflowTaskRelation
  it("groups links from this task's side", () => {
    const g = groupRelations([rel(1, 7, 8, "blocks"), rel(2, 9, 7, "blocks"), rel(3, 7, 10, "related_to"), rel(4, 11, 7, "parent_child"), rel(5, 1, 2, "blocks")], 7)
    expect(g.blocks).toEqual([{ relationId: 1, other: 8 }])
    expect(g.blocked_by).toEqual([{ relationId: 2, other: 9 }])
    expect(g.related).toEqual([{ relationId: 3, other: 10 }])
    expect(g.parent).toEqual([{ relationId: 4, other: 11 }])
  })
  it("stores 'blocked by' and 'parent' the right way round", () => {
    expect(relationToCreate("blocked_by", 7, 9)).toEqual({ source_task: 9, target_task: 7, kind: "blocks" })
    expect(relationToCreate("parent", 7, 11)).toEqual({ source_task: 11, target_task: 7, kind: "parent_child" })
    expect(relationToCreate("related", 7, 10)).toEqual({ source_task: 7, target_task: 10, kind: "related_to" })
  })
  it("parses a task number however it's typed", () => {
    expect([parseTaskNumber("#721"), parseTaskNumber("721"), parseTaskNumber(" TSK721 "), parseTaskNumber("seven")]).toEqual([721, 721, 721, null])
  })
})
