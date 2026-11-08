import { describe, expect, it } from "vitest"

import type { TaskflowProjectInvite, TaskflowProjectMember } from "@/api/client"

import { endedLine, invitableRoles, isExpired, parseEmails, sortMembers, splitInvites } from "./invites-logic"

const NOW = Date.parse("2026-11-08T12:00:00Z")

function inv(id: number, email: string, status: TaskflowProjectInvite["status"], created: string, expires: string | null = "2026-11-20T00:00:00Z"): TaskflowProjectInvite {
  return { id, project: 1, email, display_name: null, role: "developer", status, invite_token: "x", invited_by: 1, expires_at: expires, accepted_at: null, created_at: created }
}

function mem(id: number, name: string, role: TaskflowProjectMember["role"], status: TaskflowProjectMember["status"] = "active", email: string | null = null, user: number | null = id): TaskflowProjectMember {
  return { id, project: 1, member_key: `m${id}`, user, display_name: name, email, role, status, invited_by: null, created_at: null, joined_at: null }
}

describe("parseEmails", () => {
  it("splits on any separator, dedupes, flags junk", () => {
    expect(parseEmails("a@x.io, B@x.io;\nb@X.io  nope c@y.co")).toEqual({ valid: ["a@x.io", "B@x.io", "c@y.co"], invalid: ["nope"] })
    expect(parseEmails("   ")).toEqual({ valid: [], invalid: [] })
  })
})

describe("invitableRoles", () => {
  it("caps at the caller's rank", () => {
    expect(invitableRoles(mem(1, "A", "owner"), false)).toEqual(["owner", "admin", "developer", "reviewer", "viewer"])
    expect(invitableRoles(mem(1, "A", "admin"), false)).toEqual(["admin", "developer", "reviewer", "viewer"])
    expect(invitableRoles(mem(1, "A", "developer"), false)).toEqual([])
    expect(invitableRoles(undefined, false)).toEqual([])
    expect(invitableRoles(undefined, true)).toHaveLength(5)
  })
})

describe("splitInvites", () => {
  it("separates waiting from ended, hides accepted and superseded", () => {
    const invites = [
      inv(1, "old@x.io", "pending", "2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z"), // expired in effect
      inv(2, "w@x.io", "pending", "2026-11-07T00:00:00Z"),
      inv(3, "w@x.io", "declined", "2026-11-02T00:00:00Z"), // superseded by #2
      inv(4, "joined@x.io", "accepted", "2026-11-03T00:00:00Z"),
      inv(5, "m@x.io", "revoked", "2026-11-03T00:00:00Z"), // already a member
    ]
    const { waiting, past } = splitInvites(invites, [mem(9, "M", "viewer", "active", "M@x.io")], NOW)
    expect(waiting.map((i) => i.id)).toEqual([2])
    expect(past.map((i) => i.id)).toEqual([1])
  })
})

describe("isExpired / endedLine", () => {
  it("reads expiry from the date", () => {
    expect(isExpired(inv(1, "a@x.io", "pending", "2026-11-01T00:00:00Z", "2026-11-08T11:00:00Z"), NOW)).toBe(true)
    expect(isExpired(inv(1, "a@x.io", "pending", "2026-11-01T00:00:00Z", null), NOW)).toBe(false)
    expect(endedLine(inv(1, "a@x.io", "revoked", "2026-11-01T00:00:00Z"), NOW)).toBe("Cancelled")
    expect(endedLine(inv(1, "a@x.io", "pending", "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"), NOW)).toBe("Expired")
  })
})

describe("sortMembers", () => {
  it("orders by role then name, drops people who left", () => {
    const out = sortMembers([mem(1, "Zed", "viewer"), mem(2, "Amy", "owner"), mem(3, "Bob", "viewer"), mem(4, "Gone", "admin", "left")])
    expect(out.map((m) => m.display_name)).toEqual(["Amy", "Bob", "Zed"])
  })
})
