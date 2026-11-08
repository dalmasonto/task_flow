/// Status tones shared by the chip and anything that maps onto it.
import type { TaskflowTaskStatus } from "@/api/client"
import type { ColumnId } from "@/lib/workspace-view"

export type StatusTone = "running" | "idle" | "todo" | "paused" | "blocked" | "review" | "done" | "failed"

/// Board column → chip tone.
export const COLUMN_TONE: Record<ColumnId, StatusTone> = {
  not_started: "todo",
  in_progress: "running",
  review: "review",
  blocked: "blocked",
  done: "done",
}

/// What v3 calls each column (the chips' words), for labels and headings.
export const COLUMN_LABEL: Record<ColumnId, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  review: "In review",
  blocked: "Blocked",
  done: "Done",
}

/// Flat statuses (#5933): each of the server's seven gets its own tone and
/// word. Prefer these over COLUMN_* anywhere a task's status is shown.
export const STATUS_TONE: Record<TaskflowTaskStatus, StatusTone> = {
  not_started: "todo",
  in_progress: "running",
  paused: "paused",
  blocked: "blocked",
  partial_done: "review",
  done: "done",
  archived: "idle",
}

export const STATUS_LABEL: Record<TaskflowTaskStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  paused: "Paused",
  blocked: "Blocked",
  partial_done: "In review",
  done: "Done",
  archived: "Archived",
}
