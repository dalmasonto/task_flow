/// The v3 board (design: board.html, board-filters, board--empty,
/// board--loading). The store operations are v2's tested ones, through the
/// workspace: the optimistic move + write, per-column paging, server totals.
import { useState, type DragEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ChevronDownIcon, ColumnsIcon, EyeIcon, EyeOffIcon, KanbanIcon, ListIcon, PlusIcon, SearchIcon, TimerIcon, TriangleAlertIcon, XIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import type { ColumnId, Priority, Task } from "@/lib/workspace-view"
import { cn } from "@/lib/utils"

import { TaskStatusChip } from "../components/status-chip"
import { STATUS_LABEL } from "../components/status-tones"
import { pageGroupOf, statusOf, STATUS_ORDER } from "../lib/task-status"
import { useMoveTask } from "../lib/use-move-task"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { activeView, EMPTY_FILTER, filterIsActive, VIEWS, viewFilter, type AssigneeFilter, type BoardFilter } from "./board-logic"
import { columnKeyOf, columnStats, type BoardColumn } from "./columns"
import { useBoardColumns } from "./use-board-columns"
import { useBoardData, useBoardFilter } from "./use-board-data"
import { TaskCard } from "./TaskCard"
import { NewTaskLink } from "../components/task-link"

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
                ? STATUS_LABEL[filter.statuses[0]]
                : `${filter.statuses.length} statuses`}
            <ChevronDownIcon className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {STATUS_ORDER.map((st) => (
              <DropdownMenuCheckboxItem
                key={st}
                checked={filter.statuses.includes(st)}
                onCheckedChange={(on) =>
                  onChange({
                    ...filter,
                    statuses: on ? STATUS_ORDER.filter((x) => x === st || filter.statuses.includes(x)) : filter.statuses.filter((x) => x !== st),
                  })
                }
              >
                {STATUS_LABEL[st]}
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
          <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
            {v.id === "all" ? board.total : count(viewFilter(v.id))}
          </span>
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
    <>
      <Button variant="ghost" size="sm" render={<Link to="/v3/sessions" />} nativeButton={false} className="hidden sm:inline-flex">
        <TimerIcon />
        Sessions
      </Button>
      <Button size="sm" render={<NewTaskLink />} nativeButton={false}>
        <PlusIcon />
        <span className="hidden sm:inline">New task</span>
      </Button>
    </>
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
        <Button className="w-full" render={<NewTaskLink />} nativeButton={false}>
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
      {STATUS_ORDER.slice(0, 6).map((c, i) => (
        <div key={c} className="flex h-full w-[85vw] shrink-0 flex-col sm:w-72">
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
  const { shown, card, count, repos, all, rawById } = useBoardData(filter)
  const [dragged, setDragged] = useState<string | null>(null)
  const [target, setTarget] = useState<{ column: string; taskId: string | null; position: "before" | "after" } | null>(null)
  const cols = useBoardColumns()
  const move = useMoveTask()
  const [showHidden, setShowHidden] = useState(false)
  const rawOf = (id: string) => rawById.get(id)
  const keyOfTask = (t: Task) => columnKeyOf(cols.columns, statusOf(t), rawOf(t.id)?.status_column)

  // #5933/#1b: a drop in another column moves the task to that column's
  // status (and the column itself when the project has named columns). A drop
  // inside the same column only reorders, through v2's placeTask.
  const drop = (e: DragEvent, col: BoardColumn) => {
    e.preventDefault()
    const task = dragged ? all.find((t) => t.id === dragged) : undefined
    if (task) {
      const from = keyOfTask(task)
      if (from === col.key) {
        const group = pageGroupOf(col.kind) as ColumnId
        if (target?.taskId) board.placeTask(task.id, { columnId: group, taskId: target.taskId, position: target.position })
      } else {
        move(task.id, col.kind, cols.custom ? col.key : null)
      }
    }
    setDragged(null)
    setTarget(null)
  }

  const overCard = (e: DragEvent<HTMLElement>, column: string, taskId: string) => {
    if (!dragged) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? "before" : "after"
    if (target?.taskId !== taskId || target.position !== position) setTarget({ column, taskId, position })
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
          {cols.columns
            .filter((col) => (showHidden || !col.hidden) && (filter.statuses.length === 0 || filter.statuses.includes(col.kind)))
            .map((col) => {
              const inColumn = shown.filter((t) => keyOfTask(t) === col.key)
              const loaded = all.filter((t) => keyOfTask(t) === col.key).length
              // App pages the board by v2's five groups (paused loads with
              // blocked, archived with done), so "more" is the group's.
              const group = pageGroupOf(col.kind)
              const groupLoaded = all.filter((t) => pageGroupOf(statusOf(t)) === group).length
              const groupTotal = board.columnTotals[group] ?? groupLoaded
              const { total, more } = columnStats(col, cols.custom, loaded, groupLoaded, groupTotal)
              const loading = board.loadingColumns.has(group)
              const canAdd = col.kind !== "archived"
              return (
                <section
                  key={col.key}
                  aria-label={col.label}
                  className="flex h-full w-[85vw] shrink-0 snap-start flex-col sm:w-72"
                  onDragOver={(e) => {
                    if (!dragged) return
                    e.preventDefault()
                    if (!inColumn.length && target?.column !== col.key) setTarget({ column: col.key, taskId: null, position: "after" })
                  }}
                  onDrop={(e) => drop(e, col)}
                >
                  <div className="mb-2 flex items-center gap-2 px-1">
                    {cols.custom ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: col.color ?? "var(--muted-foreground)" }} aria-hidden />
                        <span className="truncate">{col.label}</span>
                      </span>
                    ) : (
                      <TaskStatusChip status={col.kind} />
                    )}
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {filterIsActive(filter) ? `${inColumn.length} of ${total ?? `${loaded}+`}` : (total ?? (more ? `${loaded}+` : loaded))}
                    </span>
                    {col.hidden ? <span className="text-xs text-muted-foreground">(hidden)</span> : null}
                    {canAdd ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="ml-auto"
                        aria-label={`Add a task to ${col.label}`}
                        render={<NewTaskLink status={col.kind} column={cols.custom ? col.key : null} />}
                        nativeButton={false}
                      >
                        <PlusIcon />
                      </Button>
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "min-h-0 flex-1 space-y-2 overflow-y-auto rounded-xl bg-muted/50 p-2 transition-colors",
                      dragged && target?.column === col.key && "bg-accent/60",
                    )}
                  >
                    {inColumn.map((t) => (
                      <div key={t.id} onDragOver={(e) => overCard(e, col.key, t.id)} className="relative">
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
                        {filterIsActive(filter) ? "Nothing here matches." : more ? "None loaded yet." : "Nothing here yet."}
                      </p>
                    ) : null}
                    {more ? (
                      <Button variant="ghost" size="sm" className="w-full" disabled={loading} onClick={() => board.loadMore(group, groupLoaded)}>
                        {loading ? "Loading…" : total != null ? `Load more (${total - loaded} left)` : "Load more"}
                      </Button>
                    ) : null}
                  </div>
                </section>
              )
            })}
          {cols.columns.some((c) => c.hidden) ? (
            <div className="flex shrink-0 items-start pt-0.5">
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? <EyeOffIcon /> : <EyeIcon />}
                {showHidden ? "Hide hidden columns" : `Show hidden (${cols.columns.filter((c) => c.hidden).map((c) => c.label).join(", ")})`}
              </Button>
            </div>
          ) : null}
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
