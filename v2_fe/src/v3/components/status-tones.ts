/// Status tones shared by the chip and anything that maps onto it.
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
