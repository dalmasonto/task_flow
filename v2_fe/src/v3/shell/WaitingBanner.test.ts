import { describe, expect, it } from "vitest"

import { waitedFor, waitingSummary } from "./WaitingBanner"
import type { WaitingPrompt } from "./use-sidebar-data"

const w = (agent: number, label: string | null, at = "2026-11-10T01:00:00Z"): WaitingPrompt => ({
  kind: "prompt", prompt: agent * 10, agent, agent_label: label, question: "Ship it?", options_json: null, prompt_kind: "single", at, unread: true, project: 2,
})

describe("waitingSummary (#1034)", () => {
  it("says nothing with nobody waiting", () => {
    expect(waitingSummary([])).toBeNull()
  })
  it("names one agent, counts its questions, or counts agents", () => {
    expect(waitingSummary([w(1, "Claude")])).toBe("Claude is waiting on you")
    expect(waitingSummary([w(1, "Claude"), w(1, "Claude")])).toBe("Claude has 2 questions waiting on you")
    expect(waitingSummary([w(1, "Claude"), w(2, "codex")])).toBe("2 agents are waiting on you")
    expect(waitingSummary([w(7, null)])).toBe("Agent 7 is waiting on you")
  })
})

describe("waitedFor", () => {
  const at = "2026-11-10T01:00:00Z"
  const t = Date.parse(at)
  it("reads like a timer", () => {
    expect(waitedFor(at, t + 20_000)).toBe("just now")
    expect(waitedFor(at, t + 4 * 60_000)).toBe("4m")
    expect(waitedFor(at, t + 72 * 60_000)).toBe("1h 12m")
  })
})
