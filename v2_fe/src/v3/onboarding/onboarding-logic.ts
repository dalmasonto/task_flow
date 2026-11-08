/// Pure rules for v3 onboarding (group 2), tested in onboarding-logic.test.ts.
import type { TaskflowAgentChannel, TaskflowAgentMessage, TaskflowAgentSession } from "@/api/client"
import { PROFILE_PATTERN } from "@/lib/agent-profile"
import { isSessionLive } from "@/lib/live-mappers"

import type { ModelId } from "../components/actor-models"

export type AgentDraft = { model: ModelId; displayName: string; profile: string }

export type Pairing = { id: string; title: string; detail: string; agents: [AgentDraft, AgentDraft] }

/// The design's three starting pairings. Picking one fills both agent forms.
export const PAIRINGS: Pairing[] = [
  {
    id: "claude-codex",
    title: "Claude builds, Codex reviews",
    detail: "Recommended. Two models check each other.",
    agents: [
      { model: "claude", displayName: "Claude (main)", profile: "main" },
      { model: "codex", displayName: "reviewer (codex)", profile: "reviewer" },
    ],
  },
  {
    id: "claude-deepseek",
    title: "Claude and DeepSeek on the backend",
    detail: "One writes the API, the other writes its tests.",
    agents: [
      { model: "claude", displayName: "Claude (main)", profile: "main" },
      { model: "deepseek", displayName: "DeepSeek (tests)", profile: "tests" },
    ],
  },
  {
    id: "claude-claude",
    title: "Two Claude agents",
    detail: "Same model, separate roles and keys.",
    agents: [
      { model: "claude", displayName: "Claude (main)", profile: "main" },
      { model: "claude", displayName: "Claude (reviewer)", profile: "reviewer" },
    ],
  },
]

/// The CLI that `taskflow init --harness` knows a model by, where one exists.
export const HARNESS: Partial<Record<ModelId, string>> = { claude: "claude", codex: "codex", gemini: "gemini", cursor: "cursor" }

export function initCommand(models: ModelId[]): string {
  const harnesses = [...new Set(models.map((m) => HARNESS[m]).filter(Boolean))]
  return `npm install -g @dalmasonto/taskflow-mcp\ntaskflow init${harnesses.length ? ` --harness ${harnesses.join(",")}` : ""}`
}

/// Profiles must be distinct (two terminals on one profile share an inbox) and
/// match the server's pattern (letters, digits, - and _).
export function validateAgents(agents: AgentDraft[]): (string | null)[] {
  return agents.map((a, i) => {
    if (!a.displayName.trim()) return "Give this agent a name."
    if (!PROFILE_PATTERN.test(a.profile)) return "Profile: lowercase letters, digits, - or _, up to 32."
    if (agents.findIndex((b) => b.profile === a.profile) !== i) return "Each agent needs its own profile, or they'd share an inbox."
    return null
  })
}

export type LinkedAgent = AgentDraft & { agentId: number; key: string | null }

/// The `.taskflow.json` the connect step shows. Keys are only known right after
/// linking (they're shown once); without them the entry says so.
export function taskflowJson(server: string, project: number, agents: LinkedAgent[]): string {
  const profiles: Record<string, unknown> = {}
  for (const a of agents) profiles[a.profile] = { agent_id: a.agentId, key: a.key ?? "MAKE_A_NEW_KEY_ON_THE_AGENTS_PAGE", display_name: a.displayName }
  return JSON.stringify({ server, project, default_profile: agents[0]?.profile ?? "main", profiles }, null, 2)
}

/// Link the drafts in order, reusing any already linked under the same profile
/// (a retry after a partial failure must not mint a second agent 1 whose first
/// key nobody saw). `onLinked` gets the list so far after EVERY link, so a later
/// failure can't lose an earlier agent's one-time key.
export async function linkDrafts(
  drafts: AgentDraft[],
  already: LinkedAgent[],
  link: (draft: AgentDraft) => Promise<{ agent_id: number; display_name: string; key: string }>,
  onLinked: (soFar: LinkedAgent[]) => void,
): Promise<LinkedAgent[]> {
  const out: LinkedAgent[] = []
  for (const d of drafts) {
    const prior = already.find((a) => a.profile === d.profile)
    if (prior) {
      out.push(prior)
      continue
    }
    const r = await link(d)
    out.push({ ...d, displayName: r.display_name, agentId: r.agent_id, key: r.key })
    onLinked([...out])
  }
  onLinked(out)
  return out
}

export type ConnectState = "waiting" | "connected"

export function agentConnectState(agentId: number, sessions: TaskflowAgentSession[], now: number): { state: ConnectState; lastSeen: string | null } {
  const mine = sessions.filter((s) => s.agent === agentId)
  const live = mine.find((s) => isSessionLive(s, now))
  return { state: live ? "connected" : "waiting", lastSeen: (live ?? mine[0])?.last_seen_at ?? null }
}

/// The kickoff TaskFlow posts for the handshake: addressed to the first agent,
/// asking it to greet the second by its chip so the second gets the notice.
export function kickoffBody(first: { displayName: string }, second: { displayName: string; agentId: number }): string {
  return `${first.displayName}, please say hello to [@${second.displayName}](agent:${second.agentId}) in this room and ask what they'd like to pick up first. Keep it to one or two sentences.`
}

/// The project's shared room, where the handshake happens. A new project also
/// gets a Design room of the same `project` kind (marked `is_design`), so
/// "first project-kind channel" could pick it; skip it, and archived rooms.
export function projectRoom<C extends Pick<TaskflowAgentChannel, "id" | "kind" | "archived" | "is_design">>(channels: C[]): C | null {
  const rooms = channels.filter((c) => c.kind === "project" && !c.archived && !c.is_design)
  return rooms.sort((a, b) => a.id - b.id)[0] ?? null
}

export type HandshakeStage = "not-started" | "first-speaking" | "waiting-reply" | "complete"

/// Where the handshake is, from the room's messages after the kickoff.
export function handshakeStage(messages: TaskflowAgentMessage[], kickoffId: number | null, firstId: number, secondId: number): HandshakeStage {
  if (kickoffId == null) return "not-started"
  const after = messages.filter((m) => m.id > kickoffId && m.sender_kind === "agent")
  const firstSpoke = after.find((m) => m.sender_agent === firstId)
  if (!firstSpoke) return "first-speaking"
  return after.some((m) => m.sender_agent === secondId && m.id > firstSpoke.id) ? "complete" : "waiting-reply"
}
