/// #1132: chat thread reads. Shapes mirror
/// backend/plugins/taskflow-agents/src/threads.rs.
import type { TaskflowAgentMessage, TaskflowMessageAttachment } from "@/api/client"
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type ThreadMessage = TaskflowAgentMessage & { attachments?: TaskflowMessageAttachment[] }
export type Thread = { root: ThreadMessage; replies: ThreadMessage[]; reply_count: number }
export type ThreadSummary = { reply_count: number; last_reply_at: string | null }

/// One thread: the root and its replies, oldest first. 404 for a channel you
/// can't see, an unknown id, or a message that is itself a reply.
export async function fetchThread(channel: number, root: number, signal?: AbortSignal): Promise<Thread> {
  const res = await fetch(`${API_BASE_URL}/api/taskflow/channels/${channel}/messages/${root}/thread`, withBearer({ signal }))
  if (res.status === 404) throw new Error("That thread isn't available.")
  if (!res.ok) throw new Error(`Couldn't load the thread (${res.status}).`)
  return (await res.json()) as Thread
}

/// Reply counts for the roots on screen, in one request. Roots with no
/// replies are absent from the answer. At most 200 ids per call.
export async function fetchThreadSummaries(channel: number, roots: number[], signal?: AbortSignal): Promise<Record<string, ThreadSummary>> {
  const ids = [...new Set(roots.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200)
  if (!ids.length) return {}
  const res = await fetch(`${API_BASE_URL}/api/taskflow/channels/${channel}/threads?roots=${ids.join(",")}`, withBearer({ signal }))
  if (!res.ok) throw new Error(`Couldn't load reply counts (${res.status}).`)
  return (await res.json()) as Record<string, ThreadSummary>
}

/// Fold a live thread row into a summary map: a new reply bumps its root's
/// count and last time; a row seen before (an edit) changes nothing.
export function bumpSummary(map: Record<string, ThreadSummary>, m: Pick<TaskflowAgentMessage, "id" | "thread_root" | "created_at">, seen: Set<number>): Record<string, ThreadSummary> {
  if (m.thread_root == null || seen.has(m.id)) return map
  seen.add(m.id)
  const key = String(m.thread_root)
  const cur = map[key] ?? { reply_count: 0, last_reply_at: null }
  const last = !cur.last_reply_at || (m.created_at ?? "") > cur.last_reply_at ? m.created_at : cur.last_reply_at
  return { ...map, [key]: { reply_count: cur.reply_count + 1, last_reply_at: last } }
}
