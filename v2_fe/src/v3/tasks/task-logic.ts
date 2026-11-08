/// Pure rules for the v3 task page (tested in task-logic.test.ts).
import type { TaskflowTaskActivity, TaskflowTaskRelation } from "@/api/client"

export type ActivityLine = { id: number; comment: boolean; who: string; agent: boolean; verb: string; body: string | null; at: string | null }

const VERBS: Record<string, string> = {
  created: "created this task",
  updated: "edited this task",
  status_changed: "moved this task",
  reviewed: "reviewed this task",
  review_requested: "asked for a review",
  timer_started: "started a work session",
  timer_paused: "paused the work session",
  timer_stopped: "ended the work session",
  claimed: "claimed this task",
}

/// One timeline row. Comments carry their body as the message; events get a
/// readable verb and keep their body (e.g. "Not started → In progress") as detail.
export function activityLine(row: TaskflowTaskActivity): ActivityLine {
  const comment = row.action === "commented" || row.action === "comment"
  return {
    id: row.id,
    comment,
    who: row.actor_label || "Someone",
    agent: row.actor_kind === "agent",
    verb: comment ? "commented" : (VERBS[row.action] ?? row.action.replace(/_/g, " ")),
    body: row.body_markdown?.trim() || null,
    at: row.created_at,
  }
}

/// Newest last, so the timeline reads top to bottom like a conversation.
export function taskTimeline(rows: TaskflowTaskActivity[], taskId: number, commentsOnly = false): ActivityLine[] {
  return rows
    .filter((r) => r.task === taskId)
    .map(activityLine)
    .filter((l) => !commentsOnly || l.comment)
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.id - b.id)
}

export type RelationGroup = "blocks" | "blocked_by" | "duplicates" | "related" | "parent" | "children"

export const RELATION_LABEL: Record<RelationGroup, string> = {
  blocks: "Blocks",
  blocked_by: "Blocked by",
  duplicates: "Duplicates",
  related: "Related",
  parent: "Parent",
  children: "Subtasks",
}

/// This task's links, from its side: "A blocks B" reads "Blocks B" on A and
/// "Blocked by A" on B. `other` is the task at the far end.
export function groupRelations(rels: TaskflowTaskRelation[], taskId: number): Record<RelationGroup, { relationId: number; other: number }[]> {
  const out: Record<RelationGroup, { relationId: number; other: number }[]> = { blocks: [], blocked_by: [], duplicates: [], related: [], parent: [], children: [] }
  for (const r of rels) {
    const mine = r.source_task === taskId
    if (!mine && r.target_task !== taskId) continue
    const other = mine ? r.target_task : r.source_task
    const group: RelationGroup =
      r.kind === "blocks" ? (mine ? "blocks" : "blocked_by") : r.kind === "parent_child" ? (mine ? "children" : "parent") : r.kind === "duplicates" ? "duplicates" : "related"
    out[group].push({ relationId: r.id, other })
  }
  return out
}

/// What the "add a link" form sends for a chosen group. "Blocked by X" is
/// stored as "X blocks this"; "Parent X" as "X parent_child this".
export function relationToCreate(group: RelationGroup, taskId: number, other: number): { source_task: number; target_task: number; kind: TaskflowTaskRelation["kind"] } {
  switch (group) {
    case "blocks":
      return { source_task: taskId, target_task: other, kind: "blocks" }
    case "blocked_by":
      return { source_task: other, target_task: taskId, kind: "blocks" }
    case "duplicates":
      return { source_task: taskId, target_task: other, kind: "duplicates" }
    case "parent":
      return { source_task: other, target_task: taskId, kind: "parent_child" }
    case "children":
      return { source_task: taskId, target_task: other, kind: "parent_child" }
    case "related":
      return { source_task: taskId, target_task: other, kind: "related_to" }
  }
}

/// `#721`, `721` or `TSK721` → 721; anything else → null.
export function parseTaskNumber(input: string): number | null {
  const m = input.trim().match(/^(?:#|tsk)?(\d+)$/i)
  return m ? Number(m[1]) : null
}
