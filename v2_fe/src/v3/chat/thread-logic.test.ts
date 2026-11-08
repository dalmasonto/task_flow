import { describe, expect, it } from "vitest"

import type { ThreadMessage, Thread } from "@/lib/threads-api"
import { bumpSummary } from "@/lib/threads-api"

import { channelIdOf, mergeThread } from "./thread-logic"

const msg = (id: number, over: Partial<ThreadMessage> = {}) => ({ id, thread_root: 10, in_channel: false, body_markdown: `m${id}`, created_at: `2026-11-08T0${id % 10}:00:00Z`, ...over }) as ThreadMessage
const thread = (): Thread => ({ root: msg(10, { thread_root: null, in_channel: true }), replies: [msg(11), msg(13)], reply_count: 2 })

describe("mergeThread", () => {
  it("adds a new reply in id order and ignores other threads", () => {
    const t = mergeThread(thread(), { kind: "upsert", message: msg(12) }, 10)
    expect(t.replies.map((r) => r.id)).toEqual([11, 12, 13])
    expect(t.reply_count).toBe(3)
    expect(mergeThread(t, { kind: "upsert", message: msg(20, { thread_root: 99 }) }, 10)).toBe(t)
  })
  it("is idempotent for a reply seen twice, and applies edits", () => {
    const t = mergeThread(thread(), { kind: "upsert", message: msg(11, { body_markdown: "edited" }) }, 10)
    expect(t.replies).toHaveLength(2)
    expect(t.replies[0].body_markdown).toBe("edited")
  })
  it("updates the root and removes deleted replies", () => {
    let t = mergeThread(thread(), { kind: "upsert", message: msg(10, { thread_root: null, body_markdown: "root edited" }) }, 10)
    expect(t.root.body_markdown).toBe("root edited")
    t = mergeThread(t, { kind: "delete", id: 11 }, 10)
    expect(t.replies.map((r) => r.id)).toEqual([13])
    expect(mergeThread(t, { kind: "delete", id: 999 }, 10)).toBe(t)
  })
})

describe("channelIdOf", () => {
  it("reads the channel id from a chat id", () => {
    expect(channelIdOf("live:channel:12")).toBe(12)
    expect(channelIdOf("live:direct:7")).toBe(7)
    expect(channelIdOf("demo:1")).toBeNull()
    expect(channelIdOf(null)).toBeNull()
  })
})

describe("bumpSummary", () => {
  it("counts a new reply once and keeps the latest time", () => {
    const seen = new Set<number>()
    let s = bumpSummary({}, { id: 1, thread_root: 5, created_at: "2026-11-08T01:00:00Z" }, seen)
    s = bumpSummary(s, { id: 1, thread_root: 5, created_at: "2026-11-08T01:00:00Z" }, seen)
    s = bumpSummary(s, { id: 2, thread_root: 5, created_at: "2026-11-08T02:00:00Z" }, seen)
    expect(s["5"]).toEqual({ reply_count: 2, last_reply_at: "2026-11-08T02:00:00Z" })
    expect(bumpSummary(s, { id: 3, thread_root: null, created_at: null }, seen)).toBe(s)
  })
})
