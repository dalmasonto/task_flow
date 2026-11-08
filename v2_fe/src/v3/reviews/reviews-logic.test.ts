import { describe, expect, it } from "vitest"

import type { TaskflowReviewRequest, TaskflowTask, TaskflowTaskReview } from "@/api/client"

import { askedLine, recentVerdicts, reviewQueues, unnamedInReview } from "./reviews-logic"

const req = (id: number, over: Partial<TaskflowReviewRequest> = {}): TaskflowReviewRequest => ({
  id,
  project: 2,
  task: 10,
  requester_kind: "agent",
  requester_user: null,
  requester_agent: 1,
  requester_label: "Claude (main)",
  reviewer_kind: "user",
  reviewer_user: 7,
  reviewer_agent: null,
  reviewer_label: "dalmas",
  reviewer_key: "user-7",
  link: null,
  focus_markdown: null,
  status: "open",
  review: null,
  closed_at: null,
  created_at: `2026-11-08T0${id}:00:00Z`,
  ...over,
})

describe("reviewQueues", () => {
  it("splits waiting on me, requested by me, and done", () => {
    const rs = [
      req(3),
      req(1),
      req(2, { reviewer_kind: "agent", reviewer_user: null, reviewer_agent: 5, requester_kind: "user", requester_user: 7, requester_agent: null }),
      req(4, { status: "answered", closed_at: "2026-11-08T09:00:00Z" }),
      req(5, { status: "cancelled", closed_at: "2026-11-08T08:00:00Z" }),
      req(6, { reviewer_user: 99 }),
    ]
    const q = reviewQueues(rs, 7)
    expect(q.waiting.map((r) => r.id)).toEqual([1, 3])
    expect(q.mine.map((r) => r.id)).toEqual([2])
    expect(q.done.map((r) => r.id)).toEqual([4, 5])
  })
  it("shows nothing when signed out", () => {
    expect(reviewQueues([req(1)], null).waiting).toEqual([])
  })
})

describe("unnamedInReview", () => {
  const task = (id: number, status: TaskflowTask["status"]) => ({ id, status, updated_at: null }) as unknown as TaskflowTask
  it("keeps review-status tasks with no open request", () => {
    const out = unnamedInReview([task(10, "partial_done"), task(11, "partial_done"), task(12, "in_progress")], [req(1, { task: 10 }), req(2, { task: 11, status: "answered" })])
    expect(out.map((t) => t.id)).toEqual([11])
  })
})

describe("recentVerdicts", () => {
  it("newest first, capped", () => {
    const rv = (id: number, at: string) => ({ id, created_at: at }) as TaskflowTaskReview
    expect(recentVerdicts([rv(1, "2026-11-01"), rv(2, "2026-11-03"), rv(3, "2026-11-02")], 2).map((r) => r.id)).toEqual([2, 3])
  })
})

describe("askedLine", () => {
  it("names the other open reviewers on the same task", () => {
    const mine = req(1)
    expect(askedLine(mine, [mine])).toBe("asked you")
    expect(askedLine(mine, [mine, req(2, { reviewer_label: "reviewer (codex)" }), req(3, { task: 11, reviewer_label: "x" })])).toBe("asked you and reviewer (codex)")
  })
})
