/// Rules for the v3 agents pages (tested in agents-logic.test.ts).
import type { TaskflowAgent, TaskflowAgentSession, TaskflowTask } from "@/api/client"
import { AGENT_CAPABILITIES } from "@/lib/agent-scopes"
import { isAgentOnline } from "@/lib/live-mappers"

import { guessModel, type ModelId } from "../components/actor-models"

export type AgentState = "live" | "idle" | "offline"

export type AgentRow = {
  id: number
  name: string
  model: ModelId | null
  state: AgentState
  /// The task it's on: in progress and assigned to it.
  task: { id: number; title: string } | null
  lastSeen: string | null
  runtime: string | null
}

/// Live = online and on a task; idle = online with nothing in progress;
/// offline = no live session. Revoked agents aren't listed at all.
export function agentRows(agents: TaskflowAgent[], sessions: TaskflowAgentSession[], tasks: TaskflowTask[], now: number): AgentRow[] {
  return agents
    .filter((a) => a.status !== "revoked")
    .map((a) => {
      const online = isAgentOnline(a.id, agents, sessions, now)
      const t = tasks.find((x) => x.assigned_agent_id === a.id && x.status === "in_progress")
      const seen = sessions.filter((s) => s.agent === a.id).map((s) => s.last_seen_at ?? "").sort().pop() || a.last_seen_at
      return {
        id: a.id,
        name: a.display_name,
        model: guessModel(a.runtime) ?? guessModel(a.display_name),
        state: (online ? (t ? "live" : "idle") : "offline") as AgentState,
        task: t ? { id: t.id, title: t.title } : null,
        lastSeen: seen || null,
        runtime: a.runtime,
      }
    })
    .sort((x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || x.name.localeCompare(y.name))
}

const STATE_ORDER: Record<AgentState, number> = { live: 0, idle: 1, offline: 2 }

export function countByState(rows: AgentRow[]): Record<AgentState | "all", number> {
  return { all: rows.length, live: rows.filter((r) => r.state === "live").length, idle: rows.filter((r) => r.state === "idle").length, offline: rows.filter((r) => r.state === "offline").length }
}

/// What the create sends for the toggles: default-on capabilities turned off
/// are denials; opt-in ones turned on are grants (both owner/admin-only).
export function keyScopes(checked: Record<string, boolean>): { scopes: string[]; denied_scopes: string[] } {
  return {
    scopes: AGENT_CAPABILITIES.filter((c) => !c.defaultOn && checked[c.id]).map((c) => c.id),
    denied_scopes: AGENT_CAPABILITIES.filter((c) => c.defaultOn && !checked[c.id]).map((c) => c.id),
  }
}

