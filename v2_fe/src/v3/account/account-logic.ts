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
