/// #605 — API-key scopes on the frontend: what the Connect-agents page shows
/// and what it may let the caller attach.
///
/// The authority is the backend's (`scopes::KNOWN_SCOPES`); this mirrors it for
/// display and for hiding controls that would only 403. The stored form is the
/// same canonical JSON the credential row carries, so reading it here needs no
/// endpoint of its own — the table read already includes it.

/// Run the project's agent setup: mint and revoke agents, and write their role
/// instructions. Mirrors `scopes::AGENTS_MANAGE` in the backend.
export const AGENT_SCOPE_MANAGE = "agents:manage"

/// Every scope a credential may carry, with the label the UI shows. Adding one
/// backend-side means adding it here so the human granting it can see what it is.
export const AGENT_SCOPE_LABELS: Record<string, string> = {
  [AGENT_SCOPE_MANAGE]: "Can manage agents",
}

/// The scopes a credential row actually carries. FAIL CLOSED, exactly like the
/// backend's `parse_scopes`: an unreadable or non-array value is no scopes.
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

export function scopeLabel(scope: string): string {
  return AGENT_SCOPE_LABELS[scope] ?? scope
}

/// May this caller attach scopes at mint time? The backend's rule: an ACTIVE
/// owner/admin of the project (or a superuser). Mirrors `invites.tsx`'s
/// `canManage` — same reason, the control is hidden rather than shown-and-403'd.
export function mayGrantAgentScopes(
  me: { role: string; status: string } | undefined,
  isSuperuser: boolean
): boolean {
  if (isSuperuser) return true
  return me?.status === "active" && (me.role === "owner" || me.role === "admin")
}
