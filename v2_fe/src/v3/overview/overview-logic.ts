/// Pure rules for the v3 overview (tested in overview-logic.test.ts).
import type { TaskflowAgent, TaskflowAgentMessage, TaskflowProjectMember } from "@/api/client"

export type ChecklistStep = { id: string; label: string; hint: string; done: boolean; href: string }

/// "Get your agents talking", from what the project actually has. Each step
/// is derived, never stored, so it can't drift from reality.
export function checklist(input: {
  agents: Pick<TaskflowAgent, "id" | "runtime" | "last_seen_at">[]
  messages: Pick<TaskflowAgentMessage, "sender_kind" | "sender_agent">[]
  taskCount: number
  members: Pick<TaskflowProjectMember, "status">[]
}): ChecklistStep[] {
  const connected = input.agents.filter((a) => a.last_seen_at)
  const models = new Set(connected.map((a) => (a.runtime ?? "").toLowerCase()).filter(Boolean))
  const talkers = new Set(input.messages.filter((m) => m.sender_kind === "agent" && m.sender_agent != null).map((m) => m.sender_agent))
  return [
    { id: "first", label: "Connect your first agent", hint: "Claude Code, Codex, Gemini CLI, Cursor or any MCP client", done: connected.length >= 1, href: "/v3/agents/new" },
    { id: "second", label: "Connect a second model", hint: "Two models catch what one misses", done: models.size >= 2, href: "/v3/agents/new" },
    { id: "talk", label: "Watch them talk", hint: "Agent two replies to agent one, live", done: talkers.size >= 2, href: "/v3/chat" },
    { id: "task", label: "Give them a task", hint: "One builds, the other reviews", done: input.taskCount > 0, href: "/v3/tasks/new" },
    { id: "invite", label: "Invite a teammate", hint: "Optional, people and agents share one roster", done: input.members.filter((m) => m.status === "active").length > 1, href: "/v3/invites" },
  ]
}

/// The last `days` calendar days ending today (local), each with its count
/// from the stats series (missing days are zero).
export function lastDays(series: { day: string; count: number }[], days: number, now = new Date()): { day: string; label: string; count: number }[] {
  const byDay = new Map(series.map((s) => [s.day.slice(0, 10), s.count]))
  const out: { day: string; label: string; count: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    out.push({ day: key, label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), count: byDay.get(key) ?? 0 })
  }
  return out
}

/// "3 agents working, 2 things waiting on you, 13 open tasks."
export function summaryLine(working: number, waiting: number, open: number): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  return `${n(working, "agent", "agents")} working, ${n(waiting, "thing", "things")} waiting on you, ${n(open, "open task", "open tasks")}.`
}
