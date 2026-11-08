/// Pure rules for the room header and details panel (design: chat.html,
/// #5918). Tested in room-logic.test.ts. Who may do what mirrors the server
/// (reviewer, #5924); the server still decides.
import type { TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowProjectMember, TaskflowTask } from "@/api/client"

export type RoomAgent = { id: number; name: string; runtime: string | null; online: boolean; working: { id: number; title: string } | null; lastSeen: string | null }
export type RoomPerson = { user: number; name: string; role: string | null; memberId: number | null }
export type RoomMembers = { agents: RoomAgent[]; people: RoomPerson[] }

/// Who is in the room. The project room's roster holds agents only (people are
/// in it by being in the project), so its people are every active member.
export function roomMembers(
  channel: Pick<TaskflowAgentChannel, "id" | "is_public" | "kind">,
  rows: TaskflowAgentChannelMember[],
  projectMembers: TaskflowProjectMember[],
  agents: TaskflowAgent[],
  tasks: Pick<TaskflowTask, "id" | "title" | "status" | "assigned_agent_id">[],
  isOnline: (agentId: number) => boolean,
): RoomMembers {
  const mine = rows.filter((r) => r.channel === channel.id)
  const roleOf = new Map(projectMembers.filter((m) => m.status === "active" && m.user != null).map((m) => [m.user as number, m.role]))
  const everyone = channel.is_public || channel.kind === "project"
  const agentIds = new Set(everyone ? agents.filter((a) => a.status !== "revoked").map((a) => a.id) : mine.filter((r) => r.agent != null).map((r) => r.agent as number))
  const roomAgents = agents
    .filter((a) => agentIds.has(a.id))
    .map((a) => {
      const task = tasks.find((t) => t.status === "in_progress" && t.assigned_agent_id === a.id)
      return { id: a.id, name: a.display_name, runtime: a.runtime ?? null, online: isOnline(a.id), working: task ? { id: task.id, title: task.title } : null, lastSeen: a.last_seen_at ?? null }
    })
    .sort((x, y) => Number(y.online) - Number(x.online) || Number(!!y.working) - Number(!!x.working) || x.name.localeCompare(y.name))
  const people: RoomPerson[] = everyone
    ? projectMembers.filter((m) => m.status === "active" && m.user != null).map((m) => ({ user: m.user as number, name: m.display_name, role: m.role, memberId: null }))
    : mine.filter((r) => r.user != null).map((r) => ({ user: r.user as number, name: r.display_name, role: roleOf.get(r.user as number) ?? null, memberId: r.id }))
  people.sort((x, y) => x.name.localeCompare(y.name))
  return { agents: roomAgents, people }
}

export type RoomPowers = { edit: boolean; editTitle: boolean; addMembers: boolean; removeMembers: boolean; archive: boolean }

/// What the viewer may change here. DMs have no settings. The project room's
/// title is fixed and everyone is already in it. In a private group, only
/// people already in it, or owners and admins, add members (#5925).
export function roomPowers(
  channel: Pick<TaskflowAgentChannel, "kind" | "is_public" | "created_by_user" | "archived"> & { is_design?: boolean },
  me: { user: number | null; role: string | null; inRoom: boolean; superuser?: boolean },
): RoomPowers {
  const none = { edit: false, editTitle: false, addMembers: false, removeMembers: false, archive: false }
  if (channel.kind === "direct" || me.user == null) return none
  const admin = me.superuser || me.role === "owner" || me.role === "admin"
  const creator = channel.created_by_user != null && channel.created_by_user === me.user
  const manage = admin || creator
  const projectRoom = channel.is_public || channel.kind === "project"
  return {
    edit: manage && !channel.archived,
    editTitle: manage && !projectRoom && !channel.archived,
    addMembers: !projectRoom && !channel.archived && (admin || me.inRoom),
    removeMembers: manage && !projectRoom,
    // The project room and the design room can't be archived (409 fixed_room).
    archive: manage && !projectRoom && !channel.is_design,
  }
}

/// Client-side checks matching the server (#5924): title 1-80, topic ≤280.
export function roomFormError(title: string, topic: string): string | null {
  const t = title.trim()
  if (!t) return "Give the room a name."
  if (t.length > 80) return "Keep the name to 80 characters."
  if (topic.trim().length > 280) return "Keep the topic to 280 characters."
  return null
}

/// Tasks this room is about: the one it was opened for, then any `#123`
/// mentioned in the loaded messages that is a task in this project, newest
/// mention first, at most `limit`.
export function linkedTaskIds(channelTask: number | null, bodies: string[], known: Set<number>, limit = 6): number[] {
  const out: number[] = []
  const add = (n: number) => {
    if (known.has(n) && !out.includes(n) && out.length < limit) out.push(n)
  }
  if (channelTask != null) add(channelTask)
  for (let i = bodies.length - 1; i >= 0; i--) {
    for (const m of bodies[i].matchAll(/(?:^|[^\w&/])#(\d{1,7})\b/g)) add(Number(m[1]))
  }
  return out
}
