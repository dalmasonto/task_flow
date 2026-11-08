import { describe, expect, it } from "vitest"

import { money, tokens } from "../usage/usage-api"
import { checklist, lastDays, summaryLine } from "./overview-logic"

describe("checklist", () => {
  it("derives every step from the project", () => {
    const none = checklist({ agents: [], messages: [], taskCount: 0, members: [{ status: "active" }] })
    expect(none.filter((s) => s.done)).toEqual([])
    const some = checklist({
      agents: [
        { id: 1, runtime: "claude", last_seen_at: "x" },
        { id: 2, runtime: "codex", last_seen_at: "x" },
        { id: 3, runtime: "gemini", last_seen_at: null },
      ],
      messages: [
        { sender_kind: "agent", sender_agent: 1 },
        { sender_kind: "agent", sender_agent: 2 },
        { sender_kind: "user", sender_agent: null },
      ],
      taskCount: 4,
      members: [{ status: "active" }, { status: "invited" }],
    })
    expect(some.map((s) => s.done)).toEqual([true, true, true, true, false])
  })
  it("needs two different models, not two agents", () => {
    const s = checklist({ agents: [{ id: 1, runtime: "claude", last_seen_at: "x" }, { id: 2, runtime: "Claude", last_seen_at: "x" }], messages: [], taskCount: 0, members: [] })
    expect(s[1].done).toBe(false)
  })
})

describe("lastDays", () => {
  it("fills missing days with zero, oldest first", () => {
    const out = lastDays([{ day: "2026-11-08", count: 3 }, { day: "2026-11-06T00:00:00Z", count: 1 }], 3, new Date(2026, 10, 8, 12))
    expect(out.map((d) => [d.day, d.count])).toEqual([
      ["2026-11-06", 1],
      ["2026-11-07", 0],
      ["2026-11-08", 3],
    ])
  })
})

describe("summaryLine", () => {
  it("pluralises", () => {
    expect(summaryLine(1, 0, 13)).toBe("1 agent working, 0 things waiting on you, 13 open tasks.")
  })
})

describe("usage formatting", () => {
  it("formats money and tokens", () => {
    expect(money(6_120_000)).toBe("$6.12")
    expect(money(5_000)).toBe("<$0.01")
    expect(money(0)).toBe("$0.00")
    expect(tokens(1_840_000)).toBe("1.84M")
    expect(tokens(920_000)).toBe("920K")
    expect(tokens(512)).toBe("512")
  })
})
