/// The v3 board (design: board.html, board-filters, board--empty,
/// board--loading). The store operations are v2's tested ones, through the
/// workspace: the optimistic move + write, per-column paging, server totals.
import { useState, type DragEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ChevronDownIcon, ColumnsIcon, KanbanIcon, ListIcon, PlusIcon, SearchIcon, TriangleAlertIcon, XIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import type { BoardColumnId } from "@/lib/board-columns"
import { columns, type ColumnId, type DropTarget, type Priority } from "@/lib/workspace-view"
import { cn } from "@/lib/utils"

import { StatusChip } from "../components/status-chip"
import { COLUMN_LABEL, COLUMN_TONE } from "../components/status-tones"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { activeView, EMPTY_FILTER, filterIsActive, VIEWS, viewFilter, type AssigneeFilter, type BoardFilter } from "./board-logic"
import { useBoardData, useBoardFilter } from "./use-board-data"
import { TaskCard } from "./TaskCard"

const ASSIGNEE_LABEL: Record<AssigneeFilter, string> = {
  all: "Anyone",
  agents: "Assigned to agents",
  people: "Assigned to people",
  unassigned: "Unassigned",
  mine: "Assigned to me",
}
const PRIORITY_LABEL: Record<Priority | "all", string> = { all: "Any priority", critical: "Critical", high: "High", normal: "Normal", low: "Low" }

export function ViewTabs({ active }: { active: "board" | "list" }) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5 text-sm" role="tablist" aria-label="View">
      {(
        [
          ["board", "/v3/board", ColumnsIcon, "Board"],
          ["list", "/v3/board/list", ListIcon, "List"],
        ] as const
      ).map(([id, to, Icon, label]) => (
        <Link
          key={id}
          to={to}
          role="tab"
          aria-selected={active === id}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded px-2",
            active === id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </div>
  )
}

function FilterChips({ filter, onChange, repos, shown }: { filter: BoardFilter; onChange: (f: BoardFilter) => void; repos: string[]; shown: number }) {
  return (
    <>
      <div className="relative w-full sm:w-56">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={filter.search}
          onChange={(e) => onChange({ ...filter, search: e.target.value })}
          placeholder="Search #id or title"
          aria-label="Search tasks"
          className="h-8 rounded-full pl-8"
        />
      </div>
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto text-sm">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className={cn("h-8 shrink-0 rounded-full font-normal", filter.statuses.length > 0 && "border-ring/50 bg-accent")}
              />
            }
          >
            {filter.statuses.length === 0
              ? "Any status"
              : filter.statuses.length === 1
                ? COLUMN_LABEL[filter.statuses[0]]
                : `${filter.statuses.length} statuses`}
            <ChevronDownIcon className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {columns.map((c) => (
              <DropdownMenuCheckboxItem
                key={c.id}
                checked={filter.statuses.includes(c.id)}
                onCheckedChange={(on) =>
                  onChange({
                    ...filter,
                    statuses: on
                      ? columns.map((x) => x.id).filter((id) => id === c.id || filter.statuses.includes(id))
                      : filter.statuses.filter((s) => s !== c.id),
                  })
                }
              >
                {COLUMN_LABEL[c.id]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Select items={ASSIGNEE_LABEL} value={filter.assignee} onValueChange={(v) => onChange({ ...filter, assignee: (v ?? "all") as AssigneeFilter })}>
          <SelectTrigger className={cn("h-8 w-auto shrink-0 rounded-full", filter.assignee !== "all" && "border-ring/50 bg-accent")} aria-label="Assignee">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ASSIGNEE_LABEL) as AssigneeFilter[]).map((k) => (
              <SelectItem key={k} value={k}>
                {ASSIGNEE_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select items={PRIORITY_LABEL} value={filter.priority} onValueChange={(v) => onChange({ ...filter, priority: (v ?? "all") as Priority | "all" })}>
          <SelectTrigger className={cn("h-8 w-auto shrink-0 rounded-full", filter.priority !== "all" && "border-ring/50 bg-accent")} aria-label="Priority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PRIORITY_LABEL) as (Priority | "all")[]).map((k) => (
              <SelectItem key={k} value={k}>
                {PRIORITY_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {repos.length > 1 ? (
          <Select
            items={{ all: "Any repo", ...Object.fromEntries(repos.map((r) => [r, r.split("/").pop() ?? r])) }}
            value={filter.repo}
            onValueChange={(v) => onChange({ ...filter, repo: v ?? "all" })}
          >
            <SelectTrigger className={cn("h-8 w-auto shrink-0 rounded-full", filter.repo !== "all" && "border-ring/50 bg-accent")} aria-label="Repository">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any repo</SelectItem>
              {repos.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {filterIsActive(filter) ? (
          <Button variant="ghost" size="sm" className="h-8 shrink-0 rounded-full" onClick={() => onChange(EMPTY_FILTER)}>
            <XIcon />
            Clear
          </Button>
        ) : null}
      </div>
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground md:inline">
        {shown} {shown === 1 ? "task" : "tasks"}
      </span>
    </>
  )
}

/// The toolbar under the header, shared with the list view.
function SavedViews({ filter, onFilter, count }: { filter: BoardFilter; onFilter: (f: BoardFilter) => void; count: (f: BoardFilter) => number }) {
  const active = activeView(filter)
  // "All" is the server's total; the other views count what's loaded, which
  // covers them (their columns are small; Done, the big one, isn't in any).
  const { board } = useWorkspace()
  return (
    <div role="tablist" aria-label="Saved views" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 pt-2 lg:px-6">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          aria-selected={active === v.id}
          onClick={() => onFilter(viewFilter(v.id))}
          className={cn(
            "-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm",
            active === v.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {v.label}
          <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{v.id === "all" ? board.total : count(viewFilter(v.id))}</span>
        </button>
      ))}
    </div>
  )
}

export function BoardToolbar({
  view,
  filter,
  onFilter,
  repos,
  shown,
  count,
}: {
  view: "board" | "list"
  filter: BoardFilter
  onFilter: (f: BoardFilter) => void
  repos: string[]
  shown: number
  count: (f: BoardFilter) => number
}) {
  return (
    <>
      <SavedViews filter={filter} onFilter={onFilter} count={count} />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 lg:px-6">
        <ViewTabs active={view} />
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
        <FilterChips filter={filter} onChange={onFilter} repos={repos} shown={shown} />
      </div>
    </>
  )
}

export function NewTaskButton() {
  return (
    <Button size="sm" render={<Link to="/v3/tasks/new" />} nativeButton={false}>
      <PlusIcon />
      <span className="hidden sm:inline">New task</span>
    </Button>
  )
}

function BoardEmpty() {
  return (
    <Empty className="mx-auto mt-10 h-auto max-w-lg flex-none rounded-2xl border border-dashed p-8">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KanbanIcon />
        </EmptyMedia>
        <EmptyTitle>No tasks yet</EmptyTitle>
        <EmptyDescription>
          Tasks are how your agents know what to work on. Add one yourself, or ask an agent in chat to read the repo and draft the first few.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full gap-2">
        <Button className="w-full" render={<Link to="/v3/tasks/new" />} nativeButton={false}>
          <PlusIcon />
          Create your first task
        </Button>
        <Button variant="outline" className="w-full" render={<Link to="/v3/chat" />} nativeButton={false}>
          Ask an agent to propose tasks
        </Button>
        <p className="pt-2 text-xs text-muted-foreground">
          Agents can create tasks too, with <code className="font-mono">create_task</code>.
        </p>
      </EmptyContent>
    </Empty>
  )
}

function BoardSkeleton() {
  return (
    <div className="flex h-full gap-3 overflow-hidden p-4 lg:px-6" aria-busy="true" aria-label="Loading the board">
      {columns.map((c, i) => (
        <div key={c.id} className="flex h-full w-[85vw] shrink-0 flex-col sm:w-80">
          <Skeleton className="mb-2 h-6 w-28" />
          <div className="flex-1 space-y-2 rounded-xl bg-muted/50 p-2">
            {Array.from({ length: 4 - (i % 3) }, (_, k) => (
              <Skeleton key={k} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function BoardPage() {
  const navigate = useNavigate()
  const { activeProject, isSyncing, board } = useWorkspace()
  const [filter, setFilter] = useBoardFilter()
  const { shown, card, count, repos, all } = useBoardData(filter)
  const [dragged, setDragged] = useState<string | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)

  const drop = (e: DragEvent, column: ColumnId) => {
    e.preventDefault()
    if (dragged) board.placeTask(dragged, target ?? { columnId: column, taskId: null, position: "after" })
    setDragged(null)
    setTarget(null)
  }

  const overCard = (e: DragEvent<HTMLElement>, column: ColumnId, taskId: string) => {
    if (!dragged) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? "before" : "after"
    if (target?.taskId !== taskId || target.position !== position) setTarget({ columnId: column, taskId, position })
  }

  let body
  if (!activeProject) {
    body = (
      <Empty className="mx-auto mt-16 max-w-md rounded-2xl border border-dashed">
        <EmptyHeader>
          <EmptyTitle>No project yet</EmptyTitle>
          <EmptyDescription>A board belongs to a project. Create one to start.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => navigate("/v3/projects/new")}>
            <PlusIcon />
            New project
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else if (all.length === 0 && isSyncing) {
    body = <BoardSkeleton />
  } else if (all.length === 0 && board.total === 0) {
    body = <BoardEmpty />
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full snap-x snap-mandatory gap-3 p-4 lg:px-6">
          {/* The design's right-edge fade: says there's more board off screen. */}
          <div
            className="pointer-events-none sticky left-full z-10 order-last -ml-20 hidden h-full w-20 shrink-0 bg-gradient-to-l from-background to-transparent lg:block"
            aria-hidden
          />
          {columns
            .filter((col) => filter.statuses.length === 0 || filter.statuses.includes(col.id))
            .map((col) => {
              const inColumn = shown.filter((t) => t.status === col.id)
              const loaded = all.filter((t) => t.status === col.id).length
              const total = board.columnTotals[col.id as BoardColumnId] ?? loaded
              const loading = board.loadingColumns.has(col.id as BoardColumnId)
              return (
                <section
                  key={col.id}
                  aria-label={COLUMN_LABEL[col.id]}
                  className="flex h-full w-[85vw] shrink-0 snap-start flex-col sm:w-80"
                  onDragOver={(e) => {
                    if (!dragged) return
                    e.preventDefault()
                    if (!inColumn.length && target?.columnId !== col.id) setTarget({ columnId: col.id, taskId: null, position: "after" })
                  }}
                  onDrop={(e) => drop(e, col.id)}
                >
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <StatusChip tone={COLUMN_TONE[col.id]} />
                    <span className="text-xs tabular-nums text-muted-foreground">{filterIsActive(filter) ? `${inColumn.length} of ${total}` : total}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto"
                      aria-label={`Add a task to ${COLUMN_LABEL[col.id]}`}
                      render={<Link to={`/v3/tasks/new?status=${col.id}`} />}
                      nativeButton={false}
                    >
                      <PlusIcon />
                    </Button>
                  </div>
                  <div
                    className={cn(
                      "min-h-0 flex-1 space-y-2 overflow-y-auto rounded-xl bg-muted/50 p-2 transition-colors",
                      dragged && target?.columnId === col.id && "bg-accent/60",
                    )}
                  >
                    {inColumn.map((t) => (
                      <div key={t.id} onDragOver={(e) => overCard(e, col.id, t.id)} className="relative">
                        {target?.taskId === t.id && target.position === "before" ? <DropLine /> : null}
                        <TaskCard
                          card={card(t)}
                          dragging={dragged === t.id}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move"
                            e.dataTransfer.setData("text/plain", `#${t.id}`)
                            setDragged(t.id)
                          }}
                          onDragEnd={() => {
                            setDragged(null)
                            setTarget(null)
                          }}
                        />
                        {target?.taskId === t.id && target.position === "after" ? <DropLine /> : null}
                      </div>
                    ))}
                    {!inColumn.length ? (
                      <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                        {filterIsActive(filter) ? "Nothing here matches." : "Nothing here yet."}
                      </p>
                    ) : null}
                    {loaded < total ? (
                      <Button variant="ghost" size="sm" className="w-full" disabled={loading} onClick={() => board.loadMore(col.id as BoardColumnId, loaded)}>
                        {loading ? "Loading…" : `Load ${Math.min(25, total - loaded)} more of ${total - loaded}`}
                      </Button>
                    ) : null}
                  </div>
                </section>
              )
            })}
        </div>
      </div>
    )
  }

  return (
    <V3Shell title="Board" flush actions={activeProject ? <NewTaskButton /> : null}>
      <div className="flex h-full min-h-0 flex-col">
        {activeProject && all.length > 0 ? (
          <BoardToolbar view="board" filter={filter} onFilter={setFilter} repos={repos} shown={shown.length} count={count} />
        ) : null}
        {board.syncError ? (
          <Alert variant="destructive" className="mx-4 mt-3 w-auto rounded-xl lg:mx-6">
            <TriangleAlertIcon />
            <AlertDescription className="text-foreground">{board.syncError}</AlertDescription>
          </Alert>
        ) : null}
        {body}
      </div>
    </V3Shell>
  )
}

function DropLine() {
  return <div className="my-1 h-0.5 rounded-full bg-ring" aria-hidden />
}
