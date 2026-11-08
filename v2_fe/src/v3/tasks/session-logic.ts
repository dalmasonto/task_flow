/// Work-session rules for the sessions page (tested in session-logic.test.ts).
import type { TaskflowTaskSession } from "@/api/client"

/// Seconds spent so far: the server's total once it has one, else the live
/// span since the start (a running session has no duration yet).
export function sessionElapsed(s: Pick<TaskflowTaskSession, "state" | "started_at" | "ended_at" | "duration_seconds">, now: number): number {
  if (s.duration_seconds != null && s.state !== "running") return s.duration_seconds
  const start = Date.parse(s.started_at)
  if (!Number.isFinite(start)) return 0
  const end = s.ended_at && s.state !== "running" ? Date.parse(s.ended_at) : now
  return Math.max(0, Math.round((end - start) / 1000))
}

export function splitSessions(sessions: TaskflowTaskSession[], historyLimit = 50) {
  const active = sessions.filter((s) => s.state === "running" || s.state === "paused").sort((a, b) => (a.state === b.state ? b.started_at.localeCompare(a.started_at) : a.state === "running" ? -1 : 1))
  const history = sessions
    .filter((s) => s.state === "stopped" || s.state === "failed")
    .sort((a, b) => (b.ended_at ?? b.started_at).localeCompare(a.ended_at ?? a.started_at))
    .slice(0, historyLimit)
  return { active, history }
}
