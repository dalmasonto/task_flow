/// #605/#700 — API-key capabilities on the frontend: what the Connect-agents
/// page shows and what it may let the caller change.
///
/// The authority is the backend's (`scopes::DEFAULT_CAPABILITIES` /
/// `GRANTABLE_SCOPES`); this mirrors it for display and for hiding controls
/// that would only 403. The stored form is the same canonical JSON the
/// credential row carries, so reading it here needs no endpoint of its own —
/// the table read already includes it.
///
/// Two lists, mirroring the backend exactly:
///   * default-ON capabilities, switchable OFF per key (`denied_scopes`);
///   * default-OFF scopes, switchable ON per key (`scopes`).

/// Run the project's agent setup: mint and revoke agents, and write their role
/// instructions. Mirrors `scopes::AGENTS_MANAGE` in the backend.
export const AGENT_SCOPE_MANAGE = "agents:manage"

export type AgentCapability = {
  id: string
  label: string
  description: string
  /// ON unless this key denies it — the default half of the model.
  defaultOn: boolean
}

/// Every capability the system knows, in the order the UI lists them. Adding
/// one backend-side means adding it here so the human toggling it can see what
/// it is.
export const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    id: "tasks:write",
    label: "Tasks",
    description: "Create, edit, re-status, claim and attach to tasks.",
    defaultOn: true,
  },
  {
    id: "reviews:write",
    label: "Reviews",
    description: "Record review verdicts on tasks.",
    defaultOn: true,
  },
  {
    id: "chat:send",
    label: "Chat",
    description: "Send messages into the channels it is on.",
    defaultOn: true,
  },
  {
    id: "activity:write",
    label: "Activity",
    description: "Log its own progress to the project activity feed.",
    defaultOn: true,
  },
  {
    id: "design:write",
    label: "Design",
    description: "Write pages, components, assets, tokens and layout. Reading and rendering stay allowed.",
    defaultOn: true,
  },
  {
    id: "toolbox:write",
    label: "Toolbox",
    description: "Save, vet, deprecate and report runs of shared scripts and memories.",
    defaultOn: true,
  },
  {
    id: AGENT_SCOPE_MANAGE,
    label: "Can manage agents",
    description: "Mint and revoke agent keys in this project and set their role instructions.",
    defaultOn: false,
  },
]

const DEFAULT_ON = AGENT_CAPABILITIES.filter((cap) => cap.defaultOn).map((cap) => cap.id)

export function capabilityLabel(id: string): string {
  return AGENT_CAPABILITIES.find((cap) => cap.id === id)?.label ?? id
}

/// The scopes a credential row GRANTS (the default-off half). FAIL CLOSED,
/// exactly like the backend's `parse_scopes`: an unreadable or non-array value
/// is no grants.
export function agentScopesOf(row: { scopes?: string | null }): string[] {
  const stored = row.scopes
  if (!stored) return []
  try {
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : []
  } catch {
    return []
  }
}

/// The default-on capabilities a credential row DENIES. Mirrors
/// `parse_denied`, including its fail-closed reading: a value the backend could
/// not have written reads as "everything default-on is denied" — the badge must
/// not say a key can do something the server will refuse.
export function deniedCapabilitiesOf(row: { denied_scopes?: string | null }): string[] {
  const stored = row.denied_scopes
  if (!stored) return []
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return [...DEFAULT_ON]
    const known = parsed.filter((s): s is string => typeof s === "string")
    return known.filter((id) => DEFAULT_ON.includes(id))
  } catch {
    return [...DEFAULT_ON]
  }
}

/// What this key can actually do: defaults minus denials plus grants. The same
/// arithmetic as `scopes::effective_capabilities`, in the same sorted form.
export function effectiveCapabilities(row: {
  scopes?: string | null
  denied_scopes?: string | null
}): string[] {
  if (typeof row.denied_scopes === "string" && !isReadable(row.denied_scopes)) {
    // The unreadable-deny case: nothing default-on survives, but grants do.
    return [...agentScopesOf(row)].sort()
  }
  const denied = deniedCapabilitiesOf(row)
  const out = DEFAULT_ON.filter((id) => !denied.includes(id))
  for (const granted of agentScopesOf(row)) {
    if (!out.includes(granted)) out.push(granted)
  }
  return out.sort()
}

function isReadable(stored: string): boolean {
  try {
    return Array.isArray(JSON.parse(stored))
  } catch {
    return false
  }
}

export function scopeLabel(scope: string): string {
  return capabilityLabel(scope)
}

/// May this caller change a key's policy — grant a scope or deny a capability?
/// The backend's rule: an ACTIVE owner/admin of the project (or a superuser).
/// Mirrors `invites.tsx`'s `canManage` — same reason, the controls are hidden
/// rather than shown-and-403'd.
export function mayGrantAgentScopes(
  me: { role: string; status: string } | undefined,
  isSuperuser: boolean
): boolean {
  if (isSuperuser) return true
  return me?.status === "active" && (me.role === "owner" || me.role === "admin")
}
