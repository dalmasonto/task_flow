/// Pure rules for the v3 Invites page (tested in invites-logic.test.ts).
import type { TaskflowProjectInvite, TaskflowProjectInviteRole, TaskflowProjectMember } from "@/api/client"

export const ROLE_ORDER: TaskflowProjectInviteRole[] = ["owner", "admin", "developer", "reviewer", "viewer"]

const RANK: Record<TaskflowProjectInviteRole, number> = { owner: 4, admin: 3, developer: 2, reviewer: 1, viewer: 0 }

export function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

/// The caller's own active membership, if any.
export function myMembership(members: TaskflowProjectMember[], userId: number | null | undefined): TaskflowProjectMember | undefined {
  if (userId == null) return undefined
  return members.find((m) => m.user === userId && m.status === "active")
}

/// Which roles the caller may invite: the server caps an invite at the
/// caller's own rank (an admin can't mint an owner), and only owners and
/// admins may invite at all. A superuser may invite any role. Empty means the
/// caller can't invite.
export function invitableRoles(me: TaskflowProjectMember | undefined, isSuperuser: boolean): TaskflowProjectInviteRole[] {
  if (isSuperuser) return ROLE_ORDER
  if (!me || (me.role !== "owner" && me.role !== "admin")) return []
  return ROLE_ORDER.filter((r) => RANK[r] <= RANK[me.role])
}

/// Split what someone typed into addresses: commas, semicolons, spaces and
/// new lines all separate; duplicates (case-insensitive) collapse. Anything
/// without a plausible `x@y.z` shape is returned as invalid, as typed.
export function parseEmails(text: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>()
  const valid: string[] = []
  const invalid: string[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.trim()
    if (!e) continue
    const key = e.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) valid.push(e)
    else invalid.push(e)
  }
  return { valid, invalid }
}

/// A pending invite whose expiry has passed is expired in effect, even
/// before anything flips its status.
export function isExpired(invite: TaskflowProjectInvite, now: number): boolean {
  if (invite.status === "expired") return true
  if (invite.status !== "pending" || !invite.expires_at) return false
  const t = Date.parse(invite.expires_at)
  return Number.isFinite(t) && t <= now
}

/// Invites still waiting for an answer, and the ones that ended without
/// joining (expired, declined, revoked). Accepted invites are members now, so
/// they appear in neither. Newest first. A past invite for an address that
/// has a newer invite or a membership is dropped: sending again replaces it.
export function splitInvites(invites: TaskflowProjectInvite[], members: TaskflowProjectMember[], now: number): { waiting: TaskflowProjectInvite[]; past: TaskflowProjectInvite[] } {
  const sorted = [...invites].sort((a, b) => (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0) || b.id - a.id)
  const memberEmails = new Set(members.filter((m) => m.status === "active" && m.email).map((m) => m.email!.toLowerCase()))
  const waiting: TaskflowProjectInvite[] = []
  const past: TaskflowProjectInvite[] = []
  const covered = new Set<string>()
  for (const inv of sorted) {
    const key = inv.email.toLowerCase()
    if (inv.status === "accepted") {
      covered.add(key)
      continue
    }
    if (inv.status === "pending" && !isExpired(inv, now)) {
      waiting.push(inv)
      covered.add(key)
      continue
    }
    if (covered.has(key) || memberEmails.has(key)) continue
    covered.add(key)
    past.push(inv)
  }
  return { waiting, past }
}

/// Owners first, then by role, then by name.
export function sortMembers(members: TaskflowProjectMember[]): TaskflowProjectMember[] {
  return members
    .filter((m) => m.status === "active" || m.status === "suspended")
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.display_name.localeCompare(b.display_name))
}

/// Why a past invite ended, in a few words.
export function endedLine(invite: TaskflowProjectInvite, now: number): string {
  if (invite.status === "declined") return "Declined"
  if (invite.status === "revoked") return "Cancelled"
  if (isExpired(invite, now)) return "Expired"
  return roleLabel(invite.status)
}
