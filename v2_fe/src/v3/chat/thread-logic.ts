/// Pure rules for chat threads (tested in thread-logic.test.ts).
import type { ThreadEvent } from "@/lib/thread-bus"
import type { Thread } from "@/lib/threads-api"

/// Fold a live event into a loaded thread: an upsert of a reply to THIS root
/// adds or replaces it (by id, kept in id order); an edit of the root updates
/// it; a deletion removes a reply. Anything else leaves the thread as is.
export function mergeThread(t: Thread, e: ThreadEvent, root: number): Thread {
  if (e.kind === "delete") {
    if (!t.replies.some((r) => r.id === e.id)) return t
    const replies = t.replies.filter((r) => r.id !== e.id)
    return { ...t, replies, reply_count: replies.length }
  }
  const m = e.message
  if (m.id === root) return { ...t, root: { ...t.root, ...m } }
  if (m.thread_root !== root) return t
  const at = t.replies.findIndex((r) => r.id === m.id)
  const replies = at >= 0 ? t.replies.map((r, i) => (i === at ? { ...r, ...m } : r)) : [...t.replies, m].sort((a, b) => a.id - b.id)
  return { ...t, replies, reply_count: replies.length }
}

/// `live:channel:12` / `live:direct:12` → 12.
export function channelIdOf(chatId: string | null | undefined): number | null {
  const m = /^live:(?:channel|direct):(\d+)$/.exec(chatId ?? "")
  return m ? Number(m[1]) : null
}
