/// The realtime groups the "migrate batch" backend adds (#5949 pins and
/// reactions, 1b project statuses, #5988 typing). A group joins App's ONE
/// stream only once the backend serving it is deployed, so all of them sit
/// behind BATCH_LIVE: flip it in the release after that deploy (dev: run vite
/// with VITE_BATCH_LIVE=1 against a server that has them).
///
/// Pins, reactions and statuses are id-only row events; surfaces listen here
/// and refetch what they show.
export const BATCH_LIVE = import.meta.env.VITE_BATCH_LIVE === "1" || import.meta.env.VITE_TYPING_LIVE === "1"

/// Suffixes are a contract with backend/src/realtime.rs.
const SUFFIX = { pins: "message_pins", reactions: "message_reactions", statuses: "project_statuses" } as const
export type BatchKind = keyof typeof SUFFIX

export function batchGroups(projectId: number | string): string[] {
  return [...Object.values(SUFFIX), "typing"].map((s) => `project:${projectId}:${s}`)
}

/// Which batch group a stream channel (`project:2:message_pins`) belongs to.
export function batchKindOf(channel: string): BatchKind | null {
  const suffix = channel.slice(channel.lastIndexOf(":") + 1)
  return (Object.keys(SUFFIX) as BatchKind[]).find((k) => SUFFIX[k] === suffix) ?? null
}

const listeners = new Map<BatchKind, Set<() => void>>()

export function publishBatchEvent(kind: BatchKind): void {
  for (const l of listeners.get(kind) ?? []) {
    try {
      l()
    } catch {
      // one bad listener must not stop the others
    }
  }
}

export function subscribeBatchEvents(kind: BatchKind, l: () => void): () => void {
  const set = listeners.get(kind) ?? new Set()
  set.add(l)
  listeners.set(kind, set)
  return () => {
    set.delete(l)
  }
}
