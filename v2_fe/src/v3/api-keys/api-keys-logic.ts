/// Pure rules for the v3 API keys page (tested in api-keys-logic.test.ts).
import type { TaskflowAgent, TaskflowAgentCredential } from "@/api/client"
import { AGENT_CAPABILITIES, effectiveCapabilities } from "@/lib/agent-scopes"
import type { AgentScopesResult } from "@/lib/taskflow-api"

/// The design's wording for each capability, keyed by its wire name.
export const CAPABILITY_TEXT: Record<string, { label: string; note: string }> = {
  "tasks:write": { label: "Work on tasks", note: "Create, edit, claim and move tasks, and attach files" },
  "chat:send": { label: "Post in chat", note: "Send messages in the rooms it's in" },
  "activity:write": { label: "Log activity", note: "Write progress to the activity feed" },
  "reviews:write": { label: "Record reviews", note: "Approve or ask for changes on tasks" },
  "design:write": { label: "Edit the design board", note: "Write pages, components, assets and tokens; reading stays allowed" },
  "toolbox:write": { label: "Save to the toolbox", note: "Save, vet and retire shared scripts and memories" },
  "agents:manage": { label: "Start and manage other agents", note: "Mint and remove agent keys here and set their instructions" },
}

/// The key an agent is using now: its newest active credential.
export function activeKey(agentId: number, credentials: TaskflowAgentCredential[]): TaskflowAgentCredential | undefined {
  return credentials
    .filter((c) => c.agent === agentId && c.status === "active")
    .sort((a, b) => (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0) || b.id - a.id)[0]
}

/// The capability switches as the key has them now.
export function checkedFrom(key: Pick<TaskflowAgentCredential, "scopes" | "denied_scopes"> | undefined): Record<string, boolean> {
  const on = key ? new Set(effectiveCapabilities(key)) : new Set<string>()
  return Object.fromEntries(AGENT_CAPABILITIES.map((c) => [c.id, on.has(c.id)]))
}

export function sameChecks(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  return AGENT_CAPABILITIES.every((c) => !!a[c.id] === !!b[c.id])
}

/// "All 6 on" / "6 of 7, agent launching off" / "3 switched off": the row's
/// one-line summary.
export function capabilitySummary(checked: Record<string, boolean>): string {
  const defaults = AGENT_CAPABILITIES.filter((c) => c.defaultOn)
  const off = defaults.filter((c) => !checked[c.id]).length
  const extra = AGENT_CAPABILITIES.filter((c) => !c.defaultOn)
  const extraOn = extra.filter((c) => checked[c.id]).length
  if (off) return `${off} switched off`
  const total = AGENT_CAPABILITIES.length
  if (extraOn === extra.length) return `All ${total} on`
  return `${defaults.length + extraOn} of ${total}, agent launching off`
}

/// Apply a scopes PATCH answer to the loaded credentials: every active key
/// of that agent now stores the returned state (as the JSON text the row
/// carries; empty lists store as null, the way the server normalises them).
export function applyScopes(credentials: TaskflowAgentCredential[], res: AgentScopesResult): TaskflowAgentCredential[] {
  const scopes = res.scopes.length ? JSON.stringify(res.scopes) : null
  const denied = res.denied_scopes.length ? JSON.stringify(res.denied_scopes) : null
  return credentials.map((c) => (c.agent === res.agent_id && c.status === "active" ? { ...c, scopes, denied_scopes: denied } : c))
}

/// Agents in name order, the ones without a working key last.
export function sortAgents(agents: TaskflowAgent[], credentials: TaskflowAgentCredential[]): TaskflowAgent[] {
  return [...agents].sort((a, b) => Number(!activeKey(a.id, credentials)) - Number(!activeKey(b.id, credentials)) || a.display_name.localeCompare(b.display_name))
}

/// May this person rotate or revoke the agent's keys? The server's rule
/// (#1136, `may_drive_agent`): an active owner/admin, the human who linked
/// the agent (still an active member), or a superuser.
export function mayManageKeys(agent: Pick<TaskflowAgent, "linked_by">, me: { role: string; status: string; user: number | null } | undefined, isSuperuser: boolean): boolean {
  if (isSuperuser) return true
  if (!me || me.status !== "active") return false
  return me.role === "owner" || me.role === "admin" || (agent.linked_by != null && agent.linked_by === me.user)
}

/// Apply a rotation to the loaded keys: every active key of the agent is
/// revoked, and the new one joins carrying the policy of the newest key it
/// replaced (the server copies it; realtime sends the full row shortly).
export function applyRotation(credentials: TaskflowAgentCredential[], agentId: number, created: Pick<TaskflowAgentCredential, "id" | "name" | "key_prefix" | "created_at">, now: string): TaskflowAgentCredential[] {
  const mine = credentials.filter((c) => c.agent === agentId).sort((a, b) => b.id - a.id)
  const policy = mine[0]
  const revoked = credentials.map((c) => (c.agent === agentId && c.status === "active" ? { ...c, status: "revoked" as const, revoked_at: now } : c))
  const fresh: TaskflowAgentCredential = {
    id: created.id,
    project: policy?.project ?? 0,
    agent: agentId,
    issued_by: null,
    name: created.name,
    key_prefix: created.key_prefix,
    key_hash: "",
    status: "active",
    scopes: policy?.scopes ?? null,
    denied_scopes: policy?.denied_scopes ?? null,
    expires_at: null,
    revoked_at: null,
    created_at: created.created_at ?? now,
  }
  return [...revoked.filter((c) => c.id !== created.id), fresh]
}

/// Apply a single revoke to the loaded keys.
export function applyRevoke(credentials: TaskflowAgentCredential[], credentialId: number, revokedAt: string | null): TaskflowAgentCredential[] {
  return credentials.map((c) => (c.id === credentialId ? { ...c, status: "revoked" as const, revoked_at: revokedAt } : c))
}
