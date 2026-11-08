import { describe, expect, it } from "vitest"

import type { TaskflowAgent, TaskflowAgentChannelMember, TaskflowProjectMember } from "@/api/client"

import { linkedTaskIds, roomFormError, roomMembers, roomPowers } from "./room-logic"

const agent = (id: number, name: string) => ({ id, display_name: name, status: "active", runtime: null, last_seen_at: null }) as unknown as TaskflowAgent
const pm = (user: number, name: string, role: TaskflowProjectMember["role"]) => ({ id: user, user, display_name: name, role, status: "active" }) as unknown as TaskflowProjectMember
const row = (id: number, channel: number, who: { user?: number; agent?: number }, name: string) =>
  ({ id, channel, member_kind: who.agent ? "agent" : "user", user: who.user ?? null, agent: who.agent ?? null, display_name: name }) as unknown as TaskflowAgentChannelMember

describe("roomMembers", () => {
  const agents = [agent(1, "Claude"), agent(2, "codex")]
  const members = [pm(10, "Dalmas", "owner"), pm(11, "Achieng", "developer")]
  const tasks = [{ id: 5, title: "Build", status: "in_progress" as const, assigned_agent_id: 2 }]
  it("lists everyone in the project room", () => {
    const r = roomMembers({ id: 1, is_public: true, kind: "project" }, [], members, agents, tasks, (id) => id === 2)
    expect(r.agents.map((a) => a.name)).toEqual(["codex", "Claude"])
    expect(r.agents[0].working).toEqual({ id: 5, title: "Build" })
    expect(r.people.map((p) => p.name)).toEqual(["Achieng", "Dalmas"])
  })
  it("lists only the roster in a group", () => {
    const rows = [row(100, 7, { user: 11 }, "Achieng"), row(101, 7, { agent: 1 }, "Claude"), row(102, 8, { user: 10 }, "Dalmas")]
    const r = roomMembers({ id: 7, is_public: false, kind: "group" }, rows, members, agents, tasks, () => false)
    expect(r.agents.map((a) => a.id)).toEqual([1])
    expect(r.people).toEqual([{ user: 11, name: "Achieng", role: "developer", memberId: 100 }])
  })
})

describe("roomPowers", () => {
  const group = { kind: "group" as const, is_public: false, created_by_user: 11, archived: false }
  it("follows the server's rules", () => {
    expect(roomPowers({ ...group, kind: "direct" }, { user: 10, role: "owner", inRoom: true }).edit).toBe(false)
    expect(roomPowers(group, { user: 11, role: "developer", inRoom: true })).toEqual({ edit: true, editTitle: true, addMembers: true, removeMembers: true, archive: true })
    expect(roomPowers(group, { user: 12, role: "developer", inRoom: true })).toEqual({ edit: false, editTitle: false, addMembers: true, removeMembers: false, archive: false })
    expect(roomPowers(group, { user: 12, role: "developer", inRoom: false }).addMembers).toBe(false)
    expect(roomPowers(group, { user: 10, role: "admin", inRoom: false }).addMembers).toBe(true)
    const room = roomPowers({ kind: "project", is_public: true, created_by_user: null, archived: false }, { user: 10, role: "owner", inRoom: true })
    expect(room).toEqual({ edit: true, editTitle: false, addMembers: false, removeMembers: false, archive: false })
    expect(roomPowers({ ...group, archived: true }, { user: 11, role: "developer", inRoom: true }).edit).toBe(false)
  })
})

describe("roomFormError / linkedTaskIds", () => {
  it("checks the form", () => {
    expect(roomFormError(" ", "")).toMatch(/name/)
    expect(roomFormError("x".repeat(81), "")).toMatch(/80/)
    expect(roomFormError("ok", "y".repeat(281))).toMatch(/280/)
    expect(roomFormError("ok", "")).toBeNull()
  })
  it("finds tasks the room talks about", () => {
    const known = new Set([3, 12, 40])
    expect(linkedTaskIds(40, ["see #3 and #12", "fixed #12, also #999", "colour &#12; no"], known)).toEqual([40, 12, 3])
  })
})
