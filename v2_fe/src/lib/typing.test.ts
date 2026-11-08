import { beforeEach, describe, expect, it } from "vitest"

import { clearTyper, publishTyping, pruneTyping, resetTyping, SHOW_FOR_MS, typersNow, typingText } from "./typing"

// `until` is the server's clock; the client ignores it (skew), so any value works.
const ev = (channel: number, kind: "user" | "agent", id: number, label: string) => ({ channel, who: { kind, id }, label, context: null, until: "1970-01-01T00:00:00Z" })

describe("typing (#5988)", () => {
  beforeEach(() => resetTyping())

  it("shows each typer for 6 s from arrival on this clock, per room, minus me", () => {
    publishTyping(ev(4, "agent", 5, "reviewer (codex)"), 1_000)
    publishTyping(ev(4, "user", 1, "Me"), 1_000)
    publishTyping(ev(9, "user", 2, "Ann"), 3_000)
    const a = typersNow(5_000, "user:1")
    expect(a.byRoom.get(4)?.map((t) => t.label)).toEqual(["reviewer (codex)"])
    expect(a.nextExpiry).toBe(1_000 + SHOW_FOR_MS)
    expect(typersNow(7_500, "user:1").byRoom.has(4)).toBe(false)
    expect(typersNow(7_500, "user:1").byRoom.get(9)).toHaveLength(1)
  })

  it("a later event extends; a sent message clears; junk is ignored", () => {
    publishTyping(ev(4, "agent", 5, "R"), 0)
    publishTyping(ev(4, "agent", 5, "R"), 5_000)
    expect(typersNow(9_000, null).byRoom.get(4)).toHaveLength(1)
    clearTyper(4, "agent:5")
    expect(typersNow(9_000, null).byRoom.size).toBe(0)
    publishTyping({ ...ev(4, "agent", 5, "R"), channel: "4" }, 0)
    publishTyping({ ...ev(4, "agent", 5, "R"), who: { kind: "root", id: 5 } }, 0)
    publishTyping(null, 0)
    expect(typersNow(1, null).byRoom.size).toBe(0)
  })

  it("forgets expired typers instead of keeping them for the session", () => {
    publishTyping(ev(4, "agent", 5, "R"), 0)
    publishTyping(ev(9, "agent", 6, "S"), 0)
    pruneTyping(SHOW_FOR_MS + 1)
    // Nothing left to expire: the map is empty, not just filtered.
    expect(typersNow(0, null).byRoom.size).toBe(0)
    publishTyping(ev(4, "agent", 7, "T"), 100_000)
    expect(typersNow(100_000, null).byRoom.get(4)?.map((t) => t.label)).toEqual(["T"])
  })

  it("says it like a person", () => {
    expect(typingText([])).toBeNull()
    expect(typingText([{ label: "reviewer (codex)" }])).toBe("reviewer is writing")
    expect(typingText([{ label: "Ann" }, { label: "Bo" }])).toBe("Ann and Bo are writing")
    expect(typingText([{ label: "Ann" }, { label: "Bo" }, { label: "Cy" }])).toBe("Ann, Bo and 1 other are writing")
    expect(typingText([{ label: "Ann" }, { label: "Bo" }, { label: "Cy" }, { label: "Di" }])).toBe("Ann, Bo and 2 others are writing")
  })
})
