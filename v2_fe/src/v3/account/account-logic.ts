/// Pure rules for the v3 account pages (tested in account-logic.test.ts).

/// "a member" / "an admin" / "an owner".
export function roleArticle(role: string): string {
  const r = role.toLowerCase()
  return `${/^[aeiou]/.test(r) ? "an" : "a"} ${r}`
}

/// "Expires in 6 days." / "Expires tomorrow." / "Expires today." / "Expired.",
/// or null with no expiry.
export function expiresLine(expiresAt: string | null | undefined, now: number): string | null {
  if (!expiresAt) return null
  const t = Date.parse(expiresAt)
  if (Number.isNaN(t)) return null
  if (t <= now) return "Expired"
  const startOf = (ms: number) => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((startOf(t) - startOf(now)) / 86_400_000)
  if (days <= 0) return "Expires today"
  if (days === 1) return "Expires tomorrow"
  return `Expires in ${days} days`
}

export const MIN_PASSWORD_LENGTH = 8

/// Why a password change can't be sent yet, or null when it can.
export function passwordError(current: string, next: string, confirm: string): string | null {
  if (!current) return "Enter your current password."
  if (next.length < MIN_PASSWORD_LENGTH) return `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`
  if (next === current) return "The new password must be different from the current one."
  if (next !== confirm) return "The two new passwords don't match."
  return null
}

/// "Chrome on Linux" from a user-agent string, or null when it can't tell.
/// Good enough to recognise your own devices; never used for security.
export function describeAgent(ua: string | null | undefined): string | null {
  if (!ua) return null
  if (/taskflow|node|undici|curl|python|go-http/i.test(ua) && !/Mozilla/.test(ua)) return "TaskFlow CLI or script"
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null
  if (browser && os) return `${browser} on ${os}`
  return browser ?? os ?? null
}

/// What a profile form changed, as a PATCH body (only the changed fields,
/// trimmed; usernames and emails lowercased like the server stores them).
export function profilePatch(was: { full_name: string | null; username: string; email: string }, now: { full_name: string; username: string; email: string }) {
  const patch: { full_name?: string; username?: string; email?: string } = {}
  if (now.full_name.trim() !== (was.full_name ?? "")) patch.full_name = now.full_name.trim()
  if (now.username.trim().toLowerCase() !== was.username) patch.username = now.username.trim().toLowerCase()
  if (now.email.trim().toLowerCase() !== was.email) patch.email = now.email.trim().toLowerCase()
  return patch
}

/// account-connections.html: "Connected as @dalmasonto on 23 July". The login
/// can be unknown (GitHub didn't answer), and an older server sends neither.
export function githubStatusLine(me: { connected: boolean; login?: string | null; connected_at?: string | null }, now: number): string {
  if (!me.connected) return "Not connected. Connect to publish tasks as issues and comment as yourself."
  const who = me.login ? ` as @${me.login}` : ""
  const t = me.connected_at ? Date.parse(me.connected_at) : NaN
  if (Number.isNaN(t)) return `Connected${who}`
  const d = new Date(t)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const day = d.toLocaleDateString("en-GB", sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" })
  return `Connected${who} on ${day}`
}

/// "Issue sync for Matchday and taskflow_v2 will stop until someone in each
/// reconnects GitHub." Null when nothing rides on this connection.
export function trackingWarning(projects: { name: string }[] | undefined): string | null {
  if (!projects?.length) return null
  const names = projects.map((p) => p.name)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  return `Issue sync for ${list} uses your connection. It stops until someone ${names.length === 1 ? "in that project" : "in each"} reconnects GitHub.`
}
