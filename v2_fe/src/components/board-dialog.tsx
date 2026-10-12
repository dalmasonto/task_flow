/// #662: the board as a dialog — near-full-screen, over whatever page you were
/// on, rendering the SAME `TaskBoard` against the SAME store as the board route.
///
/// Opening a card stacks the task detail sheet on top (it is App's, rendered
/// above this one); Escape closes one layer at a time because Base UI dialogs
/// each handle their own top-most dismissal, and closing this one leaves the
/// page underneath exactly as it was — no navigation, no remount.

import * as React from "react"

import { TaskBoard } from "@/components/task-board"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { BoardColumnId } from "@/lib/board-columns"
import type { DropTarget, Task } from "@/lib/workspace-view"

export function BoardDialog({
  open,
  onOpenChange,
  tasks,
  total,
  selectedTaskId = null,
  loadingColumns,
  columnTotals,
  syncError = null,
  onOpenTask,
  onPlaceTask,
  onLoadMore,
  blockEscape = false,
  headerActions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: Task[]
  total: number
  selectedTaskId?: string | null
  loadingColumns?: ReadonlySet<BoardColumnId>
  columnTotals?: Partial<Record<BoardColumnId, number>>
  syncError?: string | null
  onOpenTask: (taskId: string) => void
  onPlaceTask: (taskId: string, target: DropTarget) => void
  onLoadMore?: (columnId: BoardColumnId, loaded: number) => void
  /// True while a dialog opened FROM this board is on top (the task sheet):
  /// Escape belongs to that layer, not to this one. Without it, one Escape
  /// closes the board underneath the sheet — the nesting failure #662 warns
  /// about, and the exact behaviour Base UI gives a nested plain div.
  blockEscape?: boolean
  /// Page-level buttons (in the dialog: New Task, and a link to the full board).
  headerActions?: React.ReactNode
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next && blockEscape && details?.reason === "escape-key") return
        onOpenChange(next)
      }}
    >
      <DialogContent
        // ~95vw × 92vh. The board needs vertical room for its columns, so the
        // body is a fixed-height flex column and the board itself scrolls.
        //
        // z-40/30 rather than the kit's z-50: the task sheet opens OVER this
        // dialog (#662) and it is a plain fixed layer at z-50, so the board has
        // to sit under it. Everything else that opens FROM the board — the
        // task sheet's own dialogs, the attachment preview — is at z-50+ and
        // still lands on top.
        className="z-40 flex h-[92vh] w-[95vw] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[95vw]"
        overlayClassName="z-30"
        aria-label="Task board"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle>Board</DialogTitle>
          <DialogDescription className="sr-only">
            The project's task board. Open a task to see or edit it; closing this returns you to the page behind.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <TaskBoard
            tasks={tasks}
            total={total}
            selectedTaskId={selectedTaskId}
            loadingColumns={loadingColumns}
            columnTotals={columnTotals}
            syncError={syncError}
            onOpenTask={onOpenTask}
            onPlaceTask={onPlaceTask}
            onLoadMore={onLoadMore}
            headerActions={headerActions}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
