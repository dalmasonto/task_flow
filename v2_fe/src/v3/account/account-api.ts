/// The caller's own account (#TSK1134). Every route acts on the signed-in
/// person only; nothing here sends a user id. Shapes mirror
/// backend/src/account_sessions.rs and taskflow-projects/src/account.rs.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type AccountSession = {
  id: string
  kind: "token" | "session"
  name: string | null
  created_at: string | null
  last_used_at: string | null
  expires_at: string | null
  user_agent: string | null
  current: boolean
}

export type Profile = { id: number; username: string; email: string; full_name: string | null; email_verified: boolean }

export type ProfilePatch = { full_name?: string; username?: string; email?: string; current_password?: string }

/// A rejected profile edit, with the field it's about (for the form).
export class ProfileError extends Error {
  readonly field: string | null
  readonly code: string | null
  constructor(message: string, field: string | null, code: string | null) {
    super(message)
    this.field = field
    this.code = code
  }
}

const base = `${API_BASE_URL}/api/taskflow/me`

async function failure(res: Response, fallback: string): Promise<never> {
  const b = (await res.json().catch(() => null)) as { error?: string; field?: string; detail?: string } | null
  throw new ProfileError(b?.detail ?? `${fallback} (${res.status}).`, b?.field ?? null, b?.error ?? null)
}

export async function listSessions(signal?: AbortSignal): Promise<AccountSession[]> {
  const res = await fetch(`${base}/sessions`, withBearer({ signal }))
  if (!res.ok) return failure(res, "Couldn't load where you're logged in")
  return ((await res.json()) as { results?: AccountSession[] }).results ?? []
}

export async function endSession(id: string): Promise<void> {
  const res = await fetch(`${base}/sessions/${encodeURIComponent(id)}`, withBearer({ method: "DELETE" }))
  if (res.status === 404) return // already gone: what was wanted
  if (!res.ok) return failure(res, "Couldn't log that out")
}

export async function endOtherSessions(): Promise<{ revoked_tokens: number; revoked_sessions: number }> {
  const res = await fetch(`${base}/sessions/revoke-others`, withBearer({ method: "POST" }))
  if (!res.ok) return failure(res, "Couldn't log out the others")
  return (await res.json()) as { revoked_tokens: number; revoked_sessions: number }
}

export async function getProfile(signal?: AbortSignal): Promise<Profile> {
  const res = await fetch(`${base}/profile`, withBearer({ signal }))
  if (!res.ok) return failure(res, "Couldn't load your profile")
  return (await res.json()) as Profile
}

export async function patchProfile(patch: ProfilePatch): Promise<Profile> {
  const res = await fetch(`${base}/profile`, withBearer({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }))
  if (!res.ok) return failure(res, "Couldn't save your profile")
  return (await res.json()) as Profile
}
