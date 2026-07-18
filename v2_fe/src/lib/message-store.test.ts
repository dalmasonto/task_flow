import { describe, expect, it } from "vitest"
import {
  addPending,
  dismissPending,
  findPending,
  isPending,
  markFailed,
  markRetrying,
  reconcile,
  removeMessage,
} from "./message-store"
import type { ChatMessage, PendingMessage } from "./message-store"
import type { TaskflowAgentMessage } from "@/api/client"

const pending = (nonce: string): PendingMessage => ({
  client_nonce: nonce,
  body_markdown: "hello",
  priority: "normal",
  channel: 1,
  status: "pending",
})

const row = (id: number, nonce: string | null): TaskflowAgentMessage => ({
  id,
  project: 1,
  channel: 1,
  task: null,
  client_nonce: nonce,
  sender_kind: "user",
  sender_user: 1,
  sender_agent: null,
  sender_label: "dev",
  body_markdown: "hello",
  priority: "normal",
  created_at: "2026-07-17T10:00:00Z",
})

describe("reconcile", () => {
  it("replaces the pending bubble when the SSE echo arrives first", () => {
    const messages: ChatMessage[] = addPending([], pending("n1"))
    const next = reconcile(messages, row(10, "n1"))

    expect(next).toHaveLength(1)
    expect(isPending(next[0])).toBe(false)
    expect((next[0] as TaskflowAgentMessage).id).toBe(10)
  })

  it("is a no-op when the POST response arrives after the echo already reconciled", () => {
    const messages: ChatMessage[] = addPending([], pending("n1"))
    const afterEcho = reconcile(messages, row(10, "n1"))
    const afterPost = reconcile(afterEcho, row(10, "n1"))

    expect(afterPost).toHaveLength(1)
    expect((afterPost[0] as TaskflowAgentMessage).id).toBe(10)
  })

  it("keeps the position of the pending bubble it replaces", () => {
    let messages: ChatMessage[] = [row(1, null)]
    messages = addPending(messages, pending("n1"))
    messages = [...messages, row(2, null)]

    const next = reconcile(messages, row(10, "n1"))

    expect(next.map((m) => (isPending(m) ? "pending" : m.id))).toEqual([1, 10, 2])
  })

  it("inserts a row from another sender that matches no pending bubble", () => {
    const next = reconcile([], row(10, null))

    expect(next).toHaveLength(1)
    expect((next[0] as TaskflowAgentMessage).id).toBe(10)
  })

  it("inserts a row whose nonce belongs to another client's pending bubble", () => {
    // A nonce we never issued: another tab sent it. Insert, do not reconcile.
    const next = reconcile(addPending([], pending("mine")), row(10, "theirs"))

    expect(next).toHaveLength(2)
  })

  it("updates in place when the same id arrives twice", () => {
    const first = reconcile([], row(10, null))
    const edited = { ...row(10, null), body_markdown: "edited" }
    const next = reconcile(first, edited)

    expect(next).toHaveLength(1)
    expect((next[0] as TaskflowAgentMessage).body_markdown).toBe("edited")
  })

  it("matches by client_nonce over id when a different saved row shares the incoming id", () => {
    // Pins the ordering: nonce match must win over id match. An unrelated saved
    // row happens to carry the id the incoming row will use, while a pending
    // bubble carries its nonce — only nonce-first resolves this correctly.
    const savedRow = row(10, null)
    const messages: ChatMessage[] = [savedRow, pending("n1")]

    const next = reconcile(messages, row(10, "n1"))

    expect(next).toHaveLength(2)
    expect(next.some((m) => isPending(m) && m.client_nonce === "n1")).toBe(false)
    expect(next[0]).toEqual(savedRow)
    expect((next[1] as TaskflowAgentMessage).client_nonce).toBe("n1")
  })
})

describe("markFailed", () => {
  it("flips the pending bubble to failed and leaves it in place", () => {
    const next = markFailed(addPending([], pending("n1")), "n1")

    expect(next).toHaveLength(1)
    expect((next[0] as PendingMessage).status).toBe("failed")
  })

  it("records the failure reason on the bubble", () => {
    const next = markFailed(addPending([], pending("n1")), "n1", "File too large")

    expect((next[0] as PendingMessage).error).toBe("File too large")
  })

  it("clears the reason when the bubble retries", () => {
    const failed = markFailed(addPending([], pending("n1")), "n1", "File too large")
    const next = markRetrying(failed, "n1")

    expect((next[0] as PendingMessage).error).toBeUndefined()
  })
})

describe("dismissPending", () => {
  it("drops a failed bubble from the view by nonce", () => {
    const failed = markFailed(addPending(addPending([], pending("n1")), pending("n2")), "n1", "nope")
    const next = dismissPending(failed, "n1")

    expect(next).toHaveLength(1)
    expect((next[0] as PendingMessage).client_nonce).toBe("n2")
  })

  it("leaves saved rows untouched", () => {
    const messages: ChatMessage[] = [row(1, null), pending("n1")]
    const next = dismissPending(messages, "n1")

    expect(next).toHaveLength(1)
    expect((next[0] as TaskflowAgentMessage).id).toBe(1)
  })
})

describe("retry", () => {
  it("finds the failed bubble by nonce so a retry can reuse its body", () => {
    const messages = markFailed(addPending([], pending("n1")), "n1")

    expect(findPending(messages, "n1")?.body_markdown).toBe("hello")
  })

  it("flips a failed bubble back to pending without duplicating it", () => {
    const failed = markFailed(addPending([], pending("n1")), "n1")
    const next = markRetrying(failed, "n1")

    expect(next).toHaveLength(1)
    expect((next[0] as PendingMessage).status).toBe("pending")
  })

  it("reconciles a retry to one row — the endpoint is idempotent on the nonce", () => {
    // Retry reuses the nonce, so the server returns the row the first attempt
    // actually saved. Two attempts, one bubble.
    let messages: ChatMessage[] = addPending([], pending("n1"))
    messages = markFailed(messages, "n1")
    messages = markRetrying(messages, "n1")
    messages = reconcile(messages, row(10, "n1"))

    expect(messages).toHaveLength(1)
    expect((messages[0] as TaskflowAgentMessage).id).toBe(10)
  })
})

describe("removeMessage", () => {
  it("drops a saved row by id and leaves pending bubbles alone", () => {
    const messages = addPending([row(10, null)], pending("n1"))
    const next = removeMessage(messages, 10)

    expect(next).toHaveLength(1)
    expect(isPending(next[0])).toBe(true)
  })
})
