/// Pure rules for the v3 reviews page (tested in reviews-logic.test.ts).
import type { TaskflowReviewRequest, TaskflowTask, TaskflowTaskReview } from "@/api/client"

export type ReviewTab = "waiting" | "mine" | "done"

export type ReviewQueues = {
  /// Open requests that name me as the reviewer, oldest first (first asked, first answered).
  waiting: TaskflowReviewRequest[]
  /// Open requests I made, oldest first.
  mine: TaskflowReviewRequest[]
  /// Answered or cancelled requests involving me, newest first.
  done: TaskflowReviewRequest[]
}

const byCreated = (a: TaskflowReviewRequest, b: TaskflowReviewRequest) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id - b.id

export function reviewQueues(requests: TaskflowReviewRequest[], me: number | null): ReviewQueues {
  const forMe = (r: TaskflowReviewRequest) => me != null && r.reviewer_kind === "user" && r.reviewer_user === me
  const byMe = (r: TaskflowReviewRequest) => me != null && r.requester_kind === "user" && r.requester_user === me
  return {
    waiting: requests.filter((r) => r.status === "open" && forMe(r)).sort(byCreated),
    mine: requests.filter((r) => r.status === "open" && byMe(r)).sort(byCreated),
    done: requests
      .filter((r) => r.status !== "open" && (forMe(r) || byMe(r)))
      .sort((a, b) => (b.closed_at ?? b.created_at ?? "").localeCompare(a.closed_at ?? a.created_at ?? "") || b.id - a.id),
  }
}

/// Tasks sitting in review that nobody has been asked to review: without
/// this they'd be invisible here, since only named requests make the queues.
export function unnamedInReview(tasks: TaskflowTask[], requests: TaskflowReviewRequest[]): TaskflowTask[] {
  const asked = new Set(requests.filter((r) => r.status === "open").map((r) => r.task))
  return tasks.filter((t) => t.status === "partial_done" && !asked.has(t.id)).sort((a, b) => (a.updated_at ?? "").localeCompare(b.updated_at ?? "") || a.id - b.id)
}

/// The newest verdicts, for "Recently completed".
export function recentVerdicts(reviews: TaskflowTaskReview[], limit = 8): TaskflowTaskReview[] {
  return [...reviews].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id).slice(0, limit)
}

/// "asked you" / "asked you and reviewer (codex)": who else this task's open
/// requests went to, so a person knows they aren't the only reviewer.
export function askedLine(req: TaskflowReviewRequest, all: TaskflowReviewRequest[]): string {
  const others = all.filter((r) => r.task === req.task && r.status === "open" && r.id !== req.id).map((r) => r.reviewer_label)
  return others.length ? `asked you and ${[...new Set(others)].join(", ")}` : "asked you"
}
