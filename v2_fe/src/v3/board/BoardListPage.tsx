/// The board as a list (design: board-list.html): the same tasks and filters
/// as the kanban, grouped by status into collapsible sections. The design's
/// "Working on" and "Lease" columns arrive with their backends (live tool,
/// claim leases); until then they're left out rather than shown empty.
import { Link } from "react-router-dom"
import { ChevronRightIcon, PlusIcon, UserIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import type { BoardColumnId } from "@/lib/board-columns"
import { columns } from "@/lib/workspace-view"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { StatusChip } from "../components/status-chip"
import { COLUMN_LABEL, COLUMN_TONE } from "../components/status-tones"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { filterIsActive } from "./board-logic"
import { BoardToolbar, NewTaskButton } from "./BoardPage"
import { PriorityMark } from "./TaskCard"
import { useBoardData, useBoardFilter } from "./use-board-data"

const GRID = "grid grid-cols-[1rem_3.5rem_minmax(0,1fr)_1.5rem] items-center gap-3 md:grid-cols-[1rem_3.5rem_minmax(0,1fr)_9rem_5rem_6rem]"

export function BoardListPage() {
  const { activeProject, board } = useWorkspace()
  const now = useLivenessNow()
  const [filter, setFilter] = useBoardFilter()
  const { shown, card, count, repos, all } = useBoardData(filter)

  return (
    <V3Shell title="Board" flush actions={activeProject ? <NewTaskButton /> : null}>
      <div className="flex h-full min-h-0 flex-col">
        <BoardToolbar view="list" filter={filter} onFilter={setFilter} repos={repos} shown={shown.length} count={count} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={cn(GRID, "sticky top-0 z-10 border-b border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground lg:px-6")}>
            <span>
              <span className="sr-only">Priority</span>
            </span>
            <span>ID</span>
            <span>Title</span>
            <span className="hidden md:block">Assignee</span>
            <span className="hidden md:block">Due</span>
            <span className="hidden text-right md:block">Updated</span>
          </div>
          {columns.filter((col) => filter.statuses.length === 0 || filter.statuses.includes(col.id)).map((col) => {
            const rows = shown.filter((t) => t.status === col.id)
            const loaded = all.filter((t) => t.status === col.id).length
            const total = board.columnTotals[col.id as BoardColumnId] ?? loaded
            return (
              <Collapsible key={col.id} defaultOpen={col.id !== "done"} className="group/section border-b border-border">
                <div className="flex items-center gap-2 bg-muted/40 px-4 py-1.5 lg:px-6">
                  <CollapsibleTrigger className="inline-flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring" aria-label={`${COLUMN_LABEL[col.id]}, ${rows.length} shown`}>
                    <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[open]/section:rotate-90" aria-hidden />
                    <StatusChip tone={COLUMN_TONE[col.id]} />
                    <span className="text-xs tabular-nums text-muted-foreground">{filterIsActive(filter) ? `${rows.length} of ${total}` : total}</span>
                  </CollapsibleTrigger>
                  <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={`Add a task to ${COLUMN_LABEL[col.id]}`} render={<Link to={`/v3/tasks/new?status=${col.id}`} />} nativeButton={false}>
                    <PlusIcon />
                  </Button>
                </div>
                <CollapsibleContent>
                  {rows.length ? (
                    <ul>
                      {rows.map((t) => {
                        const c = card(t)
                        return (
                          <li key={t.id} className="border-t border-border/60 first:border-t-0">
                            <Link to={`/v3/tasks/${t.id}`} className={cn(GRID, "px-4 py-2.5 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none lg:px-6")}>
                              <PriorityMark priority={c.priority} />
                              <span className="font-mono text-xs text-muted-foreground tabular-nums">#{c.id}</span>
                              <span className="min-w-0">
                                <span className="block truncate font-medium">{c.title}</span>
                                {c.gate || c.repo ? (
                                  <span className="block truncate text-xs text-muted-foreground">{[c.repo, c.gate && `Gate: ${c.gate}`].filter(Boolean).join(" · ")}</span>
                                ) : null}
                              </span>
                              <span className="flex min-w-0 items-center gap-2">
                                {c.assignee ? (
                                  <>
                                    <ActorAvatar model={c.assignee.isAgent ? c.assignee.model : null} name={c.assignee.name} size="xs" />
                                    <span className="hidden truncate text-xs text-muted-foreground md:inline">{c.assignee.name}</span>
                                  </>
                                ) : (
                                  <span className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-border" title="Unassigned">
                                    <UserIcon className="size-3" aria-hidden />
                                  </span>
                                )}
                              </span>
                              <span className={cn("hidden text-xs md:block", c.due?.overdue ? "text-destructive" : "text-muted-foreground")}>{c.due?.label ?? "—"}</span>
                              <span className="hidden text-right text-xs text-muted-foreground tabular-nums md:block">{timeAgo(c.updatedAt, now) ?? "—"}</span>
                            </Link>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p className="px-4 py-3 text-xs text-muted-foreground lg:px-6">{filterIsActive(filter) ? "Nothing here matches." : "Nothing here yet."}</p>
                  )}
                  {loaded < total ? (
                    <div className="px-4 pb-2 lg:px-6">
                      <Button variant="ghost" size="sm" disabled={board.loadingColumns.has(col.id as BoardColumnId)} onClick={() => board.loadMore(col.id as BoardColumnId, loaded)}>
                        {board.loadingColumns.has(col.id as BoardColumnId) ? "Loading…" : `Load ${Math.min(25, total - loaded)} more of ${total - loaded}`}
                      </Button>
                    </div>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      </div>
    </V3Shell>
  )
}
