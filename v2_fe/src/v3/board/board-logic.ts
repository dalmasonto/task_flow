/// Rules for the v3 board (tested in board-logic.test.ts): what a card shows
/// and which tasks the filter chips keep. Live data only; a field with no data
/// is left off the card rather than faked.
import type { TaskflowAgent, TaskflowTask } from "@/api/client"
import { matchesBoardSearch } from "@/lib/board-filter"
import type { Priority, Task } from "@/lib/workspace-view"

import { statusOf, type TaskStatus } from "../lib/task-status"
import { guessModel, type ModelId } from "../components/actor-models"

export type CardAssignee = { name: string; model: ModelId | null; isAgent: boolean }

export type CardInfo = {
  id: string
  title: string
  priority: Priority
  assignee: CardAssignee | null
  gate: string | null
  repo: string | null
  files: number
  due: { label: string; overdue: boolean } | null
  updatedAt: string | null
  /// Time left on the claim lease ("42m"), for a claimed task that's active.
  lease: string | null
}

/// #1126: minutes left on an agent's claim, or null when no lease applies.
/// Only active work is released (`not_started`, `in_progress`), and the lease
/// runs from `max(agent.last_seen_at, task.updated_at)`; any heartbeat or edit
/// renews it. Negative means the sweep will release it soon.
export function leaseLeft(raw: Pick<TaskflowTask, "assigned_agent_id" | "status" | "updated_at"> | undefined, agent: Pick<TaskflowAgent, "last_seen_at"> | undefined, leaseMinutes: number | null, now: number): number | null {
  if (!raw || raw.assigned_agent_id == null || leaseMinutes == null) return null
  if (raw.status !== "not_started" && raw.status !== "in_progress") return null
  const anchor = Math.max(Date.parse(agent?.last_seen_at ?? "") || 0, Date.parse(raw.updated_at ?? "") || 0)
  if (!anchor) return null
  // Rounded up, so a claim with 40 s left reads "1m", not "Releasing".
  return Math.ceil((anchor + leaseMinutes * 60_000 - now) / 60_000)
}

/// "42m" / "1h 5m" / "Releasing" for the card chip.
export function leaseLabel(left: number | null): string | null {
  if (left == null) return null
  if (left <= 0) return "Releasing"
  if (left < 60) return `${left}m`
  return `${Math.floor(left / 60)}h ${left % 60}m`
}

const DAY = 86_400_000

function dueLabel(iso: string, now: number): { label: string; overdue: boolean } | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const label = new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(Math.abs(t - now) > 300 * DAY ? { year: "numeric" } : {}) })
  return { label, overdue: t < now }
}

/// Older tasks store a placeholder sentence instead of leaving the gate empty;
/// that isn't a gate.
function realGate(gate: string | null | undefined): string | null {
  const g = gate?.trim() ?? ""
  return !g || /^no review gate/i.test(g) ? null : g
}

export function cardInfo(task: Task, raw: TaskflowTask | undefined, agents: TaskflowAgent[], files: number, now: number, leaseMinutes: number | null = null): CardInfo {
  let assignee: CardAssignee | null = null
  const agent = raw?.assigned_agent_id != null ? agents.find((a) => a.id === raw.assigned_agent_id) : undefined
  if (raw?.assigned_agent_id != null) {
    const name = agent?.display_name ?? raw.assignee_label ?? "Agent"
    assignee = { name, model: guessModel(agent?.runtime) ?? guessModel(name), isAgent: true }
  } else if (raw?.assigned_user != null) {
    assignee = { name: raw.assignee_label ?? "Member", model: null, isAgent: false }
  }
  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    assignee,
    gate: realGate(raw?.review_gate),
    // "owner/name" reads as just "name" on a card.
    repo: raw?.github_repo ? (raw.github_repo.split("/").pop() ?? raw.github_repo) : null,
    files,
    due: raw?.due_at && task.status !== "done" ? dueLabel(raw.due_at, now) : null,
    updatedAt: raw?.updated_at ?? raw?.created_at ?? null,
    lease: leaseLabel(leaseLeft(raw, agent, leaseMinutes, now)),
  }
}

export type AssigneeFilter = "all" | "agents" | "people" | "unassigned" | "mine"

/// `statuses` empty = every status. Flat statuses (#5933): Paused is its own.
export type BoardFilter = { search: string; priority: Priority | "all"; assignee: AssigneeFilter; repo: string | "all"; statuses: TaskStatus[] }

export const EMPTY_FILTER: BoardFilter = { search: "", priority: "all", assignee: "all", repo: "all", statuses: [] }

export function filterIsActive(f: BoardFilter): boolean {
  return f.search.trim() !== "" || f.priority !== "all" || f.assignee !== "all" || f.repo !== "all" || f.statuses.length > 0
}

function matchesAssignee(raw: TaskflowTask | undefined, who: AssigneeFilter, me: number | null): boolean {
  switch (who) {
    case "all":
      return true
    case "agents":
      return raw?.assigned_agent_id != null
    case "people":
      return raw?.assigned_user != null
    case "unassigned":
      return raw?.assigned_agent_id == null && raw?.assigned_user == null
    case "mine":
      return me != null && raw?.assigned_user === me
  }
}

export function filterBoard(tasks: Task[], rawById: Map<string, TaskflowTask>, f: BoardFilter, me: number | null): Task[] {
  return tasks.filter((t) => {
    const raw = rawById.get(t.id)
    return (
      (f.statuses.length === 0 || f.statuses.includes(statusOf(t))) &&
      (f.priority === "all" || t.priority === f.priority) &&
      (f.repo === "all" || raw?.github_repo === f.repo) &&
      matchesAssignee(raw, f.assignee, me) &&
      matchesBoardSearch(t, f.search)
    )
  })
}

/// The repos on loaded tasks, for the repo chip; only worth a chip when 2+.
export function boardRepos(raws: Iterable<TaskflowTask>): string[] {
  const set = new Set<string>()
  for (const r of raws) if (r.github_repo) set.add(r.github_repo)
  return [...set].sort()
}

/// The design's saved views, as built-in presets over the same filter. (Views
/// people save themselves need a backend; until then these four are fixed.)
export type ViewId = "all" | "agents" | "review" | "blocked_me"

export const VIEWS: { id: ViewId; label: string; filter: Partial<BoardFilter> }[] = [
  { id: "all", label: "All tasks", filter: {} },
  { id: "agents", label: "Agents at work", filter: { assignee: "agents", statuses: ["in_progress"] } },
  { id: "review", label: "Needs review", filter: { statuses: ["partial_done"] } },
  { id: "blocked_me", label: "Blocked on me", filter: { assignee: "mine", statuses: ["blocked"] } },
]

export function viewFilter(id: ViewId): BoardFilter {
  return { ...EMPTY_FILTER, ...(VIEWS.find((v) => v.id === id)?.filter ?? {}) }
}

/// Which preset the current filter is exactly, if any (so the tab lights up).
export function activeView(f: BoardFilter): ViewId | null {
  for (const v of VIEWS) {
    const p = viewFilter(v.id)
    if (p.search === f.search && p.priority === f.priority && p.assignee === f.assignee && p.repo === f.repo && p.statuses.join() === f.statuses.join()) return v.id
  }
  return null
}
