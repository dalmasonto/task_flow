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
  attachments?: PendingAttachment[]
}

export type ChatMessage = TaskflowAgentMessage | PendingMessage

export function isPending(message: ChatMessage): message is PendingMessage {
  return !("id" in message)
}

export function addPending(messages: ChatMessage[], pending: PendingMessage): ChatMessage[] {
  return [...messages, pending]
}

/// Fold a saved row in, from either the SSE echo or the POST response.
/// Order-independent by construction: match the pending bubble by nonce first,
/// then fall back to id, then insert. Whichever arrives second finds the row
/// already there and updates it in place.
export function reconcile(messages: ChatMessage[], row: TaskflowAgentMessage): ChatMessage[] {
  const byNonce = row.client_nonce
    ? messages.findIndex((m) => isPending(m) && m.client_nonce === row.client_nonce)
    : -1
  const index = byNonce >= 0 ? byNonce : messages.findIndex((m) => !isPending(m) && m.id === row.id)

  if (index < 0) return [...messages, row]
  return [...messages.slice(0, index), row, ...messages.slice(index + 1)]
}

export function markFailed(messages: ChatMessage[], nonce: string): ChatMessage[] {
  return setPendingStatus(messages, nonce, "failed")
}

/// Flip a failed bubble back to pending for a retry. The retry reuses the same
/// nonce, so the send endpoint's idempotency means a first attempt that
/// actually landed returns its stored row rather than posting twice.
export function markRetrying(messages: ChatMessage[], nonce: string): ChatMessage[] {
  return setPendingStatus(messages, nonce, "pending")
}

export function findPending(messages: ChatMessage[], nonce: string): PendingMessage | undefined {
  return messages.find((m): m is PendingMessage => isPending(m) && m.client_nonce === nonce)
}

function setPendingStatus(
  messages: ChatMessage[],
  nonce: string,
  status: PendingMessage["status"]
): ChatMessage[] {
  return messages.map((m) => (isPending(m) && m.client_nonce === nonce ? { ...m, status } : m))
}

export function removeMessage(messages: ChatMessage[], id: number): ChatMessage[] {
  return messages.filter((m) => isPending(m) || m.id !== id)
}
