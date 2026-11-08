/// #5983: per-room unread/mention counts and followed threads. Shapes mirror
/// backend/plugins/taskflow-agents/src/{summary,follows}.rs.
///
/// Both reads answer `null` on a server that predates them (a 404 without
/// the handlers' `error: "not_found"`), remembered for the session, so the
/// chat list simply hides Mentions and Threads there.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type RoomSummary = {
  channel: number
  is_design: boolean
  archived: boolean
  unread: number
  mentions: number
  last: { id: number; excerpt: string; sender_label: string; created_at: string | null } | null
}

export type FollowedThread = {
  channel: number
  root: number
  excerpt: string
  replies: number
  new_replies: number
  last_reply_at: string | null
  last_repliers: string[]
}

const unsupported = { summary: false, following: false }

async function readOrNull<T>(res: Response, which: keyof typeof unsupported, what: string): Promise<T | null> {
  if (res.status === 404 || res.status === 405) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    // An endpoint-shaped 404 means an older server; "not_found" means not a member.
    if (body?.error !== "not_found") unsupported[which] = true
    return null
  }
  if (!res.ok) throw new Error(`Couldn't load ${what} (${res.status}).`)
  return (await res.json()) as T
}

export async function fetchRoomSummaries(project: number, signal?: AbortSignal): Promise<RoomSummary[] | null> {
  if (unsupported.summary) return null
  const res = await fetch(`${API_BASE_URL}/api/taskflow/projects/${project}/channels/summary`, withBearer({ signal }))
  return readOrNull<RoomSummary[]>(res, "summary", "unread counts")
}

export async function fetchFollowedThreads(project: number, signal?: AbortSignal): Promise<FollowedThread[] | null> {
  if (unsupported.following) return null
  const res = await fetch(`${API_BASE_URL}/api/taskflow/projects/${project}/threads/following`, withBearer({ signal }))
  return readOrNull<FollowedThread[]>(res, "following", "followed threads")
}

export async function setThreadFollowed(channel: number, root: number, follow: boolean): Promise<boolean> {
  const res = await fetch(`${API_BASE_URL}/api/taskflow/channels/${channel}/threads/${root}/follow`, withBearer({ method: follow ? "POST" : "DELETE" }))
  if (!res.ok) throw new Error(follow ? "Couldn't follow the thread." : "Couldn't unfollow the thread.")
  return ((await res.json()) as { following: boolean }).following
}

/// Best effort: a failed read mark only means the count stays until next time.
export async function markThreadRead(channel: number, root: number, lastReadReply: number): Promise<void> {
  await fetch(
    `${API_BASE_URL}/api/taskflow/channels/${channel}/threads/${root}/read`,
    withBearer({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ last_read_reply: lastReadReply }) }),
  ).catch(() => undefined)
}
