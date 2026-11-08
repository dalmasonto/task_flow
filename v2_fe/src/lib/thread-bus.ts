/// #1132: thread rows from App's ONE realtime stream, for the thread panel.
///
/// App owns the only EventSource (a second one wedges realtime app-wide), so
/// a surface that needs rows App doesn't keep — thread-only replies are kept
/// OUT of the channel feed — subscribes here instead. App publishes every
/// message row that belongs to a thread (`thread_root` set), whether or not
/// it also shows in the channel, and every deletion of one.
import type { TaskflowAgentMessage } from "@/api/client"

export type ThreadEvent = { kind: "upsert"; message: TaskflowAgentMessage } | { kind: "delete"; id: number }

type Listener = (e: ThreadEvent) => void
const listeners = new Set<Listener>()

export function publishThreadEvent(e: ThreadEvent): void {
  for (const l of listeners) {
    try {
      l(e)
    } catch {
      // one bad listener must not stop the others
    }
  }
}

/// Returns the unsubscribe function.
export function subscribeThreadEvents(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
