/// #662: the task board, extracted from `App.tsx`'s `/dashboard/board` route so
/// it can also render inside the board dialog (over the design page first).
///
/// It owns everything that is only about LOOKING at the board — the search box,
/// the priority filter, the drag state, the column layout — and takes the task
/// rows plus the three actions that touch the store (`onOpenTask`,
/// `onPlaceTask`, `onLoadMore`). The host keeps what the board cannot know: the
/// tasks themselves, the project, and the dialogs a card may open.
///
/// The route and the dialog render THE SAME component with the same store, so
/// a fix on one is a fix on both — which is the point of extracting it, and the
/// reason the dialog needs no board of its own.

import * as React from "react"
import { MoreHorizontalIcon, SearchIcon } from "lucide-react"

import { BoardLoadMoreSentinel, DropIndicator, EndDropIndicator, TaskCard } from "@/components/board"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ALL_PRIORITIES, BOARD_PRIORITIES, filterBoardTasks } from "@/lib/board-filter"
import type { BoardColumnId } from "@/lib/board-columns"
import { columns, nextStatus, previousStatus, type ColumnId, type DropTarget, type Task } from "@/lib/workspace-view"
import { cn } from "@/lib/utils"

export function TaskBoard({
  tasks,
  total,
  selectedTaskId = null,
  loadingColumns,
  syncError = null,
  columnTotals,
  onOpenTask,
  onPlaceTask,
  onLoadMore,
  headerActions,
}: {
  /// Every task row the app has loaded for the project.
  tasks: Task[]
  /// The server's total — `tasks` may be a paged subset of it.
  total: number
  selectedTaskId?: string | null
  loadingColumns?: ReadonlySet<BoardColumnId>
  /// A realtime/sync failure worth showing above the columns.
  syncError?: string | null
  /// The SERVER's per-column task totals. A paged column that says "25 tasks"
  /// because only 25 are loaded would be a lie, so the count comes from here
  /// and falls back to what is loaded only when the host has no totals.
  columnTotals?: Partial<Record<BoardColumnId, number>>
  onOpenTask: (taskId: string) => void
  /// Move a task to a column, at a position — the optimistic move + write.
  onPlaceTask: (taskId: string, target: DropTarget) => void
  onLoadMore?: (columnId: BoardColumnId, loaded: number) => void
  /// Page-level buttons (Activity, Invite, Edit, API, Task, Chat). The route
  /// passes the full set; the dialog passes what makes sense inside it.
  headerActions?: React.ReactNode
}) {
  const [boardSearch, setBoardSearch] = React.useState("")
  const [boardPriority, setBoardPriority] = React.useState<string>(ALL_PRIORITIES)
  const boardFilteredTasks = React.useMemo(
    () => filterBoardTasks(tasks, { search: boardSearch, priority: boardPriority }),
    [tasks, boardSearch, boardPriority]
  )
  const boardFilterActive = boardSearch.trim() !== "" || boardPriority !== ALL_PRIORITIES

  // Drag state is the board's own: nothing outside it renders a drop indicator.
  const [draggedTaskId, setDraggedTaskId] = React.useState<string | null>(null)
  const [dropTarget, setDropTarget] = React.useState<DropTarget | null>(null)

  const handleDrop = (event: React.DragEvent<HTMLElement>, fallbackColumn: ColumnId) => {
    event.preventDefault()
    if (draggedTaskId) {
      onPlaceTask(draggedTaskId, dropTarget ?? { columnId: fallbackColumn, taskId: null, position: "after" })
      setDraggedTaskId(null)
    }
    setDropTarget(null)
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>, status: ColumnId) => {
    const nextTarget = event.relatedTarget as Node | null
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
      setDropTarget((current) => (current?.columnId === status ? null : current))
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col px-3 py-3 sm:px-4 lg:px-5">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div className="shrink-0 rounded-lg border bg-card p-2.5">
          <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center">
              <div className="relative md:w-80">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={boardSearch}
                  onChange={(event) => setBoardSearch(event.target.value)}
                  placeholder="Search #id, title, owner, tag"
                  className="pl-8"
                  aria-label="Search tasks"
                />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {[ALL_PRIORITIES, ...BOARD_PRIORITIES].map((option) => {
                  const active = boardPriority === option
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setBoardPriority(option)}
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-medium capitalize ring-1 transition",
                        active
                          ? "bg-primary/10 text-primary ring-primary/30"
                          : "bg-background text-muted-foreground ring-border hover:bg-muted"
                      )}
                    >
                      {option === ALL_PRIORITIES ? "All" : option}
                    </button>
                  )
                })}
                {boardFilterActive ? (
                  <>
                    <span className="ml-1 text-xs text-muted-foreground">
                      {boardFilteredTasks.length} of {tasks.length}
                      {/* #315: the filter only sees loaded pages, so say so
                          when the server holds more than the board fetched. */}
                      {total > tasks.length ? ` loaded (${total} total)` : null}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setBoardSearch("")
                        setBoardPriority(ALL_PRIORITIES)
                      }}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Clear
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            {headerActions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{headerActions}</div> : null}
          </div>
          {syncError ? (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {syncError}
            </p>
          ) : null}
        </div>

        {/* Board columns scroll horizontally. On small screens each column
            snaps to ~full screen width (one at a time); from lg up the five
            columns flex to fill the row. The region is height-gated: it takes
            the remaining vertical space (flex-1 + min-h-0) and each column's
            card list scrolls internally, so the header above stays fixed
            instead of the whole page scrolling. */}
        <div className="min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto pb-2 lg:snap-none">
          <div className="flex h-full gap-3">
            {columns.map((column) => {
              // #26: newest first (id descending) so a freshly created task —
              // including one arriving over SSE — lands at the TOP, and
              // pagination pulls older cards in as you scroll. Dragging a card
              // to another column still changes its status; within a column the
              // id-sort wins, so manual reordering is dropped.
              const columnTasks = boardFilteredTasks
                .filter((task) => task.status === column.id)
                .sort((a, b) => {
                  const na = Number(a.id)
                  const nb = Number(b.id)
                  if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na
                  return b.id.localeCompare(a.id)
                })
              // #314: what the column has FETCHED, before the search / priority
              // filter. "Left to load" is total minus this; the filtered count
              // made a filter look like 100 unloaded tasks.
              const columnLoaded = tasks.filter((task) => task.status === column.id).length
              const columnTotal = columnTotals?.[column.id] ?? columnLoaded
              const ColumnIcon = column.icon
              return (
                <div
                  key={column.id}
                  className={cn(
                    "flex h-full max-h-full w-[calc(100vw-2rem)] shrink-0 snap-center flex-col overflow-hidden rounded-lg border bg-card transition sm:w-[21rem] lg:w-auto lg:min-w-0 lg:flex-1 lg:snap-align-none",
                    draggedTaskId && dropTarget?.columnId === column.id && "border-primary/60 bg-primary/5 ring-2 ring-primary/25"
                  )}
                  onDragEnter={() => setDropTarget({ columnId: column.id, taskId: null, position: "after" })}
                  onDragOver={(event) => {
                    event.preventDefault()
                    setDropTarget((current) =>
                      current?.columnId === column.id && current.taskId === null
                        ? current
                        : { columnId: column.id, taskId: null, position: "after" }
                    )
                  }}
                  onDragLeave={(event) => handleDragLeave(event, column.id)}
                  onDrop={(event) => handleDrop(event, column.id)}
                >
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={cn("inline-flex size-7 items-center justify-center rounded-md ring-1", column.tone)}>
                        <ColumnIcon className="size-3.5" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold">{column.title}</h3>
                        {/* The column's TOTAL, not how many are loaded — a
                            paged column showing "25 tasks" would be a lie. */}
                        <p className="text-xs text-muted-foreground">{columnTotal} tasks</p>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon-sm" aria-label={`${column.title} actions`}>
                      <MoreHorizontalIcon />
                    </Button>
                  </div>
                  <div data-board-scroll className="scrollbar-y relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-muted/25 p-2.5">
                    {draggedTaskId && dropTarget?.columnId === column.id && dropTarget.taskId === null ? (
                      <EndDropIndicator label={`Drop at end of ${column.title}`} />
                    ) : null}
                    {columnTasks.map((task) => (
                      <div key={task.id} className="relative">
                        {draggedTaskId && dropTarget?.taskId === task.id && dropTarget.position === "before" ? (
                          <DropIndicator label={`Drop before ${task.title}`} position="before" />
                        ) : null}
                        <TaskCard
                          task={task}
                          selected={selectedTaskId === task.id}
                          dragging={draggedTaskId === task.id}
                          onSelect={() => onOpenTask(task.id)}
                          onDragStart={() => setDraggedTaskId(task.id)}
                          onDragOver={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            const bounds = event.currentTarget.getBoundingClientRect()
                            const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after"
                            if (draggedTaskId && draggedTaskId !== task.id) {
                              setDropTarget({ columnId: column.id, taskId: task.id, position })
                            }
                          }}
                          onDrop={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            handleDrop(event, column.id)
                          }}
                          onDragEnd={() => {
                            setDraggedTaskId(null)
                            setDropTarget(null)
                          }}
                          onMoveNext={() => onPlaceTask(task.id, { columnId: nextStatus(task.status), taskId: null, position: "after" })}
                          onMovePrevious={() => onPlaceTask(task.id, { columnId: previousStatus(task.status), taskId: null, position: "after" })}
                        />
                        {draggedTaskId && dropTarget?.taskId === task.id && dropTarget.position === "after" ? (
                          <DropIndicator label={`Drop after ${task.title}`} position="after" />
                        ) : null}
                      </div>
                    ))}
                    {columnTasks.length === 0 ? (
                      <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed bg-background px-3 text-center text-sm text-muted-foreground">
                        {boardFilterActive
                          ? `No loaded tasks in ${column.title.toLowerCase()} match`
                          : columnLoaded < columnTotal
                            ? "Loading tasks…"
                            : `No tasks in ${column.title.toLowerCase()}`}
                      </div>
                    ) : null}
                    {columnLoaded < columnTotal && onLoadMore ? (
                      <BoardLoadMoreSentinel
                        onLoadMore={() => onLoadMore(column.id, columnLoaded)}
                        remaining={columnTotal - columnLoaded}
                        loading={loadingColumns?.has(column.id) ?? false}
                      />
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
