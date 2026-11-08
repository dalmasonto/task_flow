/// Switching servers without losing your place (Dalmas, v3 group 2): "if I
/// logged in on server 1, then switch to server 2 and log in, switching back to
/// server 1 shouldn't ask me to log in again".
///
/// The active server's session lives in localStorage (auth-api), because every
/// request reads it synchronously. On a switch, that session is kept in
/// IndexedDB under the server it belongs to, and the target server's kept
/// session (if any) becomes the active one. A token never travels to a server
/// it wasn't issued by: each is stored and restored under its own address.
///
/// Its own module because auth-api imports server-choice, so neither of those
/// can import the other.
import { adoptStoredSession, API_BASE_URL, clearStoredSession, getStoredToken, getStoredUser } from "@/lib/auth-api"
import { markServerUsed, writeServerChoice } from "@/lib/server-choice"
import { db as siteDb, type ServerSessionRow } from "@/lib/site-config"

/// Keep the active session under the active server, so it can come back later.
async function keepActiveSession() {
  const token = getStoredToken()
  const user = getStoredUser()
  if (token && user) await siteDb.sessions.put({ server: API_BASE_URL, token, user, savedAt: Date.now() })
}

/// The kept sessions, by server address ("" = the build default), for the
/// picker's "Signed in as …" lines. The active server is read live instead.
export async function keptSessions(): Promise<Record<string, ServerSessionRow["user"]>> {
  try {
    const rows = await siteDb.sessions.toArray()
    return Object.fromEntries(rows.map((r) => [r.server, r.user]))
  } catch {
    return {}
  }
}

/// Switch to `target` ("" = the build default) and say where to go next:
/// the app when a kept session was restored, sign-in otherwise.
export async function switchServer(target: string, buildDefault: string): Promise<"/v3/board" | "/v3/login"> {
  await keepActiveSession().catch(() => undefined)
  writeServerChoice(target === buildDefault ? null : target)
  if (target !== buildDefault) void markServerUsed(target)
  const kept = await siteDb.sessions.get(target).catch(() => undefined)
  if (kept) {
    adoptStoredSession(kept.token, kept.user as Parameters<typeof adoptStoredSession>[1])
    return "/v3/board"
  }
  clearStoredSession()
  return "/v3/login"
}
