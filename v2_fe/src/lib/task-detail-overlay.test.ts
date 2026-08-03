import { describe, it, expect } from "vitest"
import { overlayTaskDetail, pruneTaskDetail } from "@/lib/task-detail-overlay"
import type { TaskflowWorkspace, WorkspaceTaskDetailSlice } from "@/lib/taskflow-api"

// A workspace whose task-detail arrays are EMPTY — simulating a large project
// where the open task's rows fell past the project-wide 100-row cap / the feed's
// first page, which is what made the sheet show false "No X yet" states.
function emptyWorkspace(): TaskflowWorkspace {
  return {
    taskAttachments: [],
    taskRelations: [],
    taskReviews: [],
    taskActivity: [],
    taskSessions: [],
  } as unknown as TaskflowWorkspace
}

function detailForTask(taskId: number): { taskId: number } & WorkspaceTaskDetailSlice {
  return {
    taskId,
    taskAttachments: [{ id: 11, task: taskId }],
    taskRelations: [{ id: 21, source_task: taskId, target_task: 99 }],
    taskReviews: [{ id: 31, task: taskId }],
    taskActivity: [{ id: 41, task: taskId }],
    taskSessions: [{ id: 51, task: taskId }],
  } as unknown as { taskId: number } & WorkspaceTaskDetailSlice
}

describe("overlayTaskDetail (live base wins, gaps filled)", () => {
  it("fills in the open task's rows when the workspace arrays are empty (no false empty state)", () => {
    const merged = overlayTaskDetail(emptyWorkspace(), detailForTask(5))
    expect(merged.taskAttachments.map((r) => r.id)).toContain(11)
    expect(merged.taskRelations.map((r) => r.id)).toContain(21)
    expect(merged.taskReviews.map((r) => r.id)).toContain(31)
    expect(merged.taskActivity.map((r) => r.id)).toContain(41)
    expect(merged.taskSessions.map((r) => r.id)).toContain(51)
  })

  it("lets a newer LIVE base row win over the stale detail snapshot for the same id", () => {
    // Base already holds an updated copy of the relation (e.g. realtime edit);
    // the detail snapshot has the OLD copy. The base's version must be kept.
    const base = {
      ...emptyWorkspace(),
      taskRelations: [{ id: 21, source_task: 5, target_task: 99, kind: "blocks" }],
    } as unknown as TaskflowWorkspace
    const stale = detailForTask(5) // its relation 21 has no `kind`
    const merged = overlayTaskDetail(base, stale)
    const rel = merged.taskRelations.filter((r) => r.id === 21)
    expect(rel).toHaveLength(1) // not duplicated
    expect((rel[0] as unknown as { kind?: string }).kind).toBe("blocks") // base won
  })

  it("does not resurrect a deleted row: base lacks it AND pruned detail lacks it", () => {
    // Simulate a relation delete: realtime removed id 21 from the base, and we
    // prune it from the detail store. The overlay must NOT add it back.
    const base = emptyWorkspace() // relation 21 removed from base
    const pruned = pruneTaskDetail(detailForTask(5), "taskRelations", 21)
    const merged = overlayTaskDetail(base, pruned)
    expect(merged.taskRelations.map((r) => r.id)).not.toContain(21)
  })

  it("returns a new object and does not mutate the input workspace", () => {
    const base = emptyWorkspace()
    const merged = overlayTaskDetail(base, detailForTask(5))
    expect(merged).not.toBe(base)
    expect(base.taskActivity).toHaveLength(0) // untouched — the feeds read this
  })
})

describe("pruneTaskDetail", () => {
  it("removes the row from the named field", () => {
    const pruned = pruneTaskDetail(detailForTask(5), "taskSessions", 51)
    expect(pruned.taskSessions.map((r) => r.id)).not.toContain(51)
  })

  it("returns the same object when the id is not present (no needless re-render)", () => {
    const detail = detailForTask(5)
    expect(pruneTaskDetail(detail, "taskSessions", 9999)).toBe(detail)
  })
})
