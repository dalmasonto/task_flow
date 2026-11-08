/// Rules for the v3 board (tested in board-logic.test.ts): what a card shows
/// and which tasks the filter chips keep. Live data only; a field with no data
/// is left off the card rather than faked.
import type { TaskflowAgent, TaskflowTask } from "@/api/client"
import { matchesBoardSearch } from "@/lib/board-filter"
import type { Priority, Task } from "@/lib/workspace-view"

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

export function cardInfo(task: Task, raw: TaskflowTask | undefined, agents: TaskflowAgent[], files: number, now: number): CardInfo {
  let assignee: CardAssignee | null = null
  if (raw?.assigned_agent_id != null) {
    const agent = agents.find((a) => a.id === raw.assigned_agent_id)
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
  }
}

export type AssigneeFilter = "all" | "agents" | "people" | "unassigned" | "mine"

export type BoardFilter = { search: string; priority: Priority | "all"; assignee: AssigneeFilter; repo: string | "all" }

export const EMPTY_FILTER: BoardFilter = { search: "", priority: "all", assignee: "all", repo: "all" }

export function filterIsActive(f: BoardFilter): boolean {
  return f.search.trim() !== "" || f.priority !== "all" || f.assignee !== "all" || f.repo !== "all"
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
