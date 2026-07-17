import type { AuthUser } from "@/lib/auth-api"

/// Two-letter initials for an avatar fallback, derived from the username (or
/// email if there's no username). Splits on whitespace and common separators.
export function initialsFor(user: Pick<AuthUser, "username" | "email">): string {
  const source = user.username || user.email || "?"
  const parts = source
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}
