/// What the ⌘K palette lists, from live workspace data only (tested in
/// palette-logic.test.ts). The palette never fetches: it reads App's state.
import type { TaskflowAgent, TaskflowAgentSession } from "@/api/client"
import { isAgentOnline } from "@/lib/live-mappers"
import type { Task } from "@/lib/workspace-view"

import { agentModelId, type ActorStatus, type ModelId } from "../components/actor-models"

export type PaletteAgent = { id: number; name: string; model: ModelId | null; status: ActorStatus; detail: string }

/// Agents of the active project, online first, then by name. Revoked agents
/// are left out: they can't be messaged and have no terminal.
export function paletteAgents(agents: TaskflowAgent[], sessions: TaskflowAgentSession[], now: number): PaletteAgent[] {
  return agents
    .filter((a) => a.status !== "revoked")
    .map((a) => {
      const live = isAgentOnline(a.id, agents, sessions, now)
      return {
        id: a.id,
        name: a.display_name,
        model: agentModelId(a),
        status: (live ? "running" : "offline") as ActorStatus,
        detail: live ? "Online now" : a.last_seen_at ? "Offline" : "Never connected",
      }
    })
    .sort((x, y) => Number(y.status === "running") - Number(x.status === "running") || x.name.localeCompare(y.name))
}

/// The text cmdk matches a task on: its number in every form people type
/// (`#721`, `721`, `TSK721`) plus the title.
export function taskSearchValue(task: Pick<Task, "id" | "title">): string {
  const n = task.id.replace(/\D/g, "")
  return `#${n} TSK${n} ${n} ${task.title}`
}

/// Open work first (what you'd jump to), most recently loaded order otherwise.
export function paletteTasks(tasks: Task[], limit = 50): Task[] {
  const open = tasks.filter((t) => t.status !== "done")
  return [...open, ...tasks.filter((t) => t.status === "done")].slice(0, limit)
}
