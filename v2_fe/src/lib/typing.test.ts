import { beforeEach, describe, expect, it } from "vitest"

import { clearTyper, publishTyping, resetTyping, typersNow, typingText } from "./typing"

const at = (ms: number) => new Date(ms).toISOString()

describe("typing (#5988)", () => {
  beforeEach(() => resetTyping())

  it("keeps who is writing per room until their time runs out, minus me", () => {
    publishTyping({ channel: 4, who: { kind: "agent", id: 5 }, label: "reviewer (codex)", context: null, until: at(10_000) })
    publishTyping({ channel: 4, who: { kind: "user", id: 1 }, label: "Me", context: null, until: at(12_000) })
    publishTyping({ channel: 9, who: { kind: "user", id: 2 }, label: "Ann", context: null, until: at(8_000) })
    const a = typersNow(5_000, "user:1")
    expect(a.byRoom.get(4)?.map((t) => t.label)).toEqual(["reviewer (codex)"])
    expect(a.nextExpiry).toBe(8_000)
    expect(typersNow(9_000, "user:1").byRoom.has(9)).toBe(false)
    expect(typersNow(11_000, "user:1").byRoom.size).toBe(0)
  })

  it("a later event extends; a sent message clears; junk is ignored", () => {
    publishTyping({ channel: 4, who: { kind: "agent", id: 5 }, label: "R", context: null, until: at(1_000) })
    publishTyping({ channel: 4, who: { kind: "agent", id: 5 }, label: "R", context: null, until: at(9_000) })
    expect(typersNow(5_000, null).byRoom.get(4)).toHaveLength(1)
    clearTyper(4, "agent:5")
    expect(typersNow(5_000, null).byRoom.size).toBe(0)
    publishTyping({ channel: "4", who: { kind: "agent", id: 5 }, label: "R", until: at(9_000) })
    publishTyping({ channel: 4, who: { kind: "root", id: 5 }, label: "R", until: at(9_000) })
    publishTyping(null)
    expect(typersNow(5_000, null).byRoom.size).toBe(0)
  })

  it("says it like a person", () => {
    expect(typingText([])).toBeNull()
    expect(typingText([{ label: "reviewer (codex)" }])).toBe("reviewer is writing")
    expect(typingText([{ label: "Ann" }, { label: "Bo" }])).toBe("Ann and Bo are writing")
    expect(typingText([{ label: "Ann" }, { label: "Bo" }, { label: "Cy" }])).toBe("Ann, Bo and 1 other are writing")
    expect(typingText([{ label: "Ann" }, { label: "Bo" }, { label: "Cy" }, { label: "Di" }])).toBe("Ann, Bo and 2 others are writing")
  })
})
