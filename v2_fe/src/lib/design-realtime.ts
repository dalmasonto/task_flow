/// A tiny in-process fan-out for design realtime events.
///
/// The app opens exactly ONE EventSource (App.tsx). A second long-lived SSE
/// connection holds an HTTP/1.1 slot for its whole life and wedges realtime for
/// the whole app — see the note in ProfilePage.tsx. So the design page must NOT
/// open its own stream; instead the app-level stream forwards design_file /
/// design_comment events here, and the design surface subscribes.
///
/// Events are id-only on the wire and consumers here only read `event.table`
/// (to bump the artboard content epoch or refresh comment pins), so no REST
/// refetch is needed — unlike chat rows, which the app fetches by id.
import type { TaskflowRealtimeEvent } from "./taskflow-api"

type DesignRealtimeListener = (event: TaskflowRealtimeEvent) => void

const listeners = new Set<DesignRealtimeListener>()

/// Subscribe to design realtime events. Returns an unsubscribe function
/// (cleanup for a useEffect).
export function onDesignRealtimeEvent(listener: DesignRealtimeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/// Forward a design event to every subscriber. A throwing listener must not
/// break the shared stream or the other subscribers.
export function emitDesignRealtimeEvent(event: TaskflowRealtimeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A subscriber's failure is its own problem, not the stream's.
    }
  }
}
