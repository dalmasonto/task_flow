/// Workflow (design: project-workflow.html): the steps tasks move through.
///
/// The design lets a team name its own statuses, set limits and reorder
/// columns. The backend has a fixed status set today, so this page shows that
/// set honestly: the board's five columns, the statuses each one holds, the
/// words agents use (`update_task_status`), and how many tasks sit in each
/// right now (the server's column totals). Custom statuses need a backend.
import { Link } from "react-router-dom"
import { KanbanIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { BOARD_COLUMN_IDS, columnStatuses, type BoardColumnId } from "@/lib/board-columns"

import { StatusChip } from "../components/status-chip"
import { COLUMN_LABEL, COLUMN_TONE } from "../components/status-tones"
import { useWorkspace } from "../workspace"
import { ProjectShell, Section } from "./ProjectShell"

const COLUMN_NOTE: Record<BoardColumnId, string> = {
  not_started: "Not picked up yet. New tasks start here.",
  in_progress: "Someone is working on it. Moving a task here starts its work timer.",
  review: "Waiting on a reviewer. Agents ask for review with partial_done.",
  blocked: "Stuck, or paused for now.",
  done: "Counts as finished. Archived tasks stay here, out of the way.",
}

export function ProjectWorkflowPage() {
  const { live, board } = useWorkspace()
  const loaded = !!live && Object.keys(board.columnTotals).length > 0

  return (
    <ProjectShell
      actions={
        <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/v3/board" />}>
          <KanbanIcon />
          View board
        </Button>
      }
    >
      <Section
        title="Task statuses"
        description={
          <>
            Every task is in one of these columns. Agents see the status names in <code className="rounded bg-muted px-1 font-mono text-xs">list_tasks</code> and set them with{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">update_task_status</code>.
          </>
        }
      >
        <ol className="divide-y rounded-xl border bg-card">
          {BOARD_COLUMN_IDS.map((col) => (
            <li key={col} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <StatusChip tone={COLUMN_TONE[col]} label={COLUMN_LABEL[col]} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-muted-foreground">{COLUMN_NOTE[col]}</p>
                <p className="mt-0.5 flex flex-wrap gap-1">
                  {columnStatuses(col).map((s) => (
                    <code key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {s}
                    </code>
                  ))}
                </p>
              </div>
              {loaded ? (
                <span className="text-sm tabular-nums text-muted-foreground">
                  {board.columnTotals[col] ?? 0} {(board.columnTotals[col] ?? 0) === 1 ? "task" : "tasks"}
                </span>
              ) : (
                <Skeleton className="h-4 w-14" />
              )}
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">Naming your own statuses, setting column limits and reordering them aren&apos;t available yet. The set above is the same for every project.</p>
      </Section>
    </ProjectShell>
  )
}
