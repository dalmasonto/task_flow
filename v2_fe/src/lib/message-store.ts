import type { TaskflowAgentMessage } from "@/api/client"

/// A message the sender has typed but the server has not yet acknowledged.
/// Keyed by client_nonce, never by id — the server assigns ids, and the SSE
/// echo frequently beats the POST response on localhost, so an id-keyed
/// optimistic bubble cannot be matched against its own echo.
/// A local preview of a file the user staged, shown on the optimistic bubble
/// until the server echoes back the stored attachment. `url` is an in-browser
/// object URL for images (empty for non-images, which render as name+size).
export type PendingAttachment = {
  id: string
  name: string
  content_type: string
  size_bytes: number
  url: string
}

export type PendingMessage = {
  client_nonce: string
  body_markdown: string
  priority: TaskflowAgentMessage["priority"]
  channel: number
  status: "pending" | "failed"
  /// Why the last send attempt failed (server `detail` or a network message),
  /// shown on the failed bubble. Cleared on retry.
  error?: string
  attachments?: PendingAttachment[]
  /// Mirrors the server row's `is_design` so the optimistic bubble renders in
  /// the design rail immediately, before the send is acknowledged.
  is_design?: boolean
  /// #317: the message this pending one replies to, kept so a retry re-sends it.
  reply_to?: number | null
}

export type ChatMessage = TaskflowAgentMessage | PendingMessage

export function isPending(message: ChatMessage): message is PendingMessage {
  return !("id" in message)
}

export function addPending(messages: ChatMessage[], pending: PendingMessage): ChatMessage[] {
  return [...messages, pending]
}

/// #701: how many SAVED messages one channel keeps in the workspace slice.
///
/// The workspace holds every message the tab has seen — each realtime event and
/// every page a thread loads merges into it — and nothing ever removed them, so
/// a tab left open outgrew the board it was showing: every new event then
/// re-renders against an ever-larger array, and the effects that scan it (unread
/// counts, thread grouping, attachment joins) get slower with it. Activity and
/// terminal frames already had caps; messages were the one that did not.
///
/// Per CHANNEL, not global: the open thread's own history is exactly what a cap
/// must not eat first, and 500 recent messages is more than a thread renders.
/// Older pages stay reachable by scrolling up (each fetch merges its page in
/// again), so eviction costs a refetch, never a message.
export const MAX_CHANNEL_MESSAGES = 500

/// Keep a channel's newest `MAX_CHANNEL_MESSAGES` saved rows, plus every
/// pending one (an unsent bubble is the user's, not history's).
///
/// Applied by [`reconcile`] itself rather than by its callers: there are three
/// merge paths today (realtime echo, page load, send response) and a cap that
/// lives beside them is a cap the fourth one will forget.
export function capChannelMessages(
  messages: ChatMessage[],
  max = MAX_CHANNEL_MESSAGES
): ChatMessage[] {
  // Newest by id: ids are assigned in insert order, and a row without one is
  // pending (kept regardless).
  const byChannel = new Map<number, ChatMessage[]>()
  let overflowing = false
  for (const message of messages) {
    if (isPending(message)) continue
    const bucket = byChannel.get(message.channel)
    if (bucket) {
      bucket.push(message)
      if (bucket.length > max) overflowing = true
    } else {
      byChannel.set(message.channel, [message])
    }
  }
  // Nothing over budget: hand back the SAME array. This runs on every merge,
  // and a gratuitous copy is a gratuitous re-render for every consumer.
  if (!overflowing) return messages

  const keep = new Set<number>()
  for (const bucket of byChannel.values()) {
    const newest = [...bucket].sort((a, b) => (b as TaskflowAgentMessage).id - (a as TaskflowAgentMessage).id)
    for (const message of newest.slice(0, max)) keep.add((message as TaskflowAgentMessage).id)
  }
  return messages.filter((message) => isPending(message) || keep.has((message as TaskflowAgentMessage).id))
}

/// Fold a saved row in, from either the SSE echo or the POST response.
/// Order-independent by construction: match the pending bubble by nonce first,
/// then fall back to id, then insert. Whichever arrives second finds the row
/// already there and updates it in place.
///
/// The result is capped per channel (#701) so no merge path can grow the
/// workspace without bound.
export function reconcile(messages: ChatMessage[], row: TaskflowAgentMessage): ChatMessage[] {
  const byNonce = row.client_nonce
    ? messages.findIndex((m) => isPending(m) && m.client_nonce === row.client_nonce)
    : -1
  const index = byNonce >= 0 ? byNonce : messages.findIndex((m) => !isPending(m) && m.id === row.id)

  if (index < 0) return capChannelMessages([...messages, row])
  return capChannelMessages([...messages.slice(0, index), row, ...messages.slice(index + 1)])
}

export function markFailed(messages: ChatMessage[], nonce: string, error?: string): ChatMessage[] {
  return messages.map((m) =>
    isPending(m) && m.client_nonce === nonce ? { ...m, status: "failed", error } : m
  )
}

/// Flip a failed bubble back to pending for a retry. The retry reuses the same
/// nonce, so the send endpoint's idempotency means a first attempt that
/// actually landed returns its stored row rather than posting twice. Clears the
/// prior failure reason so the retrying bubble doesn't still show a stale error.
export function markRetrying(messages: ChatMessage[], nonce: string): ChatMessage[] {
  return messages.map((m) =>
    isPending(m) && m.client_nonce === nonce ? { ...m, status: "pending", error: undefined } : m
  )
}

/// Drop a failed optimistic bubble from the view — the user chose to cancel it
/// rather than retry. Only matches a pending/failed bubble by nonce; saved rows
/// are untouched.
export function dismissPending(messages: ChatMessage[], nonce: string): ChatMessage[] {
  return messages.filter((m) => !(isPending(m) && m.client_nonce === nonce))
}

export function findPending(messages: ChatMessage[], nonce: string): PendingMessage | undefined {
  return messages.find((m): m is PendingMessage => isPending(m) && m.client_nonce === nonce)
}

export function removeMessage(messages: ChatMessage[], id: number): ChatMessage[] {
  return messages.filter((m) => isPending(m) || m.id !== id)
}
