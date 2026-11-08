import { describe, expect, it } from "vitest"

import type { Decision } from "./decisions-api"
import { KEY_PATTERN, cleanOptions, countByStatus, keyFromQuestion, recommended, sortFor, waitingOnMe } from "./decisions-logic"

const d = (id: number, over: Partial<Decision> = {}): Decision =>
  ({
    id,
    key: `k-${id}`,
    question: "Q?",
    status: "open",
    ruler_user: null,
    options: [],
    created_at: `2026-11-0${id}T00:00:00Z`,
    ruled_at: null,
    updated_at: null,
    ...over,
  }) as Decision

describe("keyFromQuestion", () => {
  it("slugs a question into a valid key", () => {
    const k = keyFromQuestion("Max delay per agent trigger?")
    expect(k).toBe("max-delay-per-agent-trigger")
    expect(KEY_PATTERN.test(k)).toBe(true)
  })
  it("drops a leading digit and pads short keys", () => {
    expect(keyFromQuestion("2 sessions?")).toBe("sessions")
    expect(keyFromQuestion("Go")).toBe("go-decision")
    expect(keyFromQuestion("??")).toBe("")
  })
})

describe("KEY_PATTERN", () => {
  it("matches the server rule", () => {
    expect(KEY_PATTERN.test("abc")).toBe(true)
    expect(KEY_PATTERN.test("ab")).toBe(false)
    expect(KEY_PATTERN.test("1abc")).toBe(false)
    expect(KEY_PATTERN.test("abc-")).toBe(false)
    expect(KEY_PATTERN.test("a".repeat(61))).toBe(false)
  })
})

describe("queues", () => {
  const all = [d(2), d(1), d(3, { status: "ruled", ruled_at: "2026-11-05T00:00:00Z" }), d(4, { status: "ruled", ruled_at: "2026-11-06T00:00:00Z" }), d(5, { status: "superseded" })]
  it("counts by status", () => {
    expect(countByStatus(all)).toEqual({ open: 2, ruled: 2, superseded: 1 })
  })
  it("orders open oldest first, ruled newest first", () => {
    expect(sortFor("open", all).map((x) => x.id)).toEqual([1, 2])
    expect(sortFor("ruled", all).map((x) => x.id)).toEqual([4, 3])
  })
  it("knows who may rule", () => {
    expect(waitingOnMe(d(1), 7)).toBe(true)
    expect(waitingOnMe(d(1, { ruler_user: 7 }), 7)).toBe(true)
    expect(waitingOnMe(d(1, { ruler_user: 8 }), 7)).toBe(false)
    expect(waitingOnMe(d(1, { status: "ruled" }), 7)).toBe(false)
  })
})

describe("options", () => {
  it("finds the recommendation", () => {
    expect(recommended(d(1, { options: [{ id: 1, recommended: false }, { id: 2, recommended: true }] as Decision["options"] }))?.id).toBe(2)
  })
  it("cleans an ask form's rows", () => {
    expect(
      cleanOptions([
        { label: " 1 hour ", detail: "", recommended: true },
        { label: "", detail: "x", recommended: false },
        { label: "6 hours", detail: " covers CI ", recommended: true },
      ]),
    ).toEqual([{ label: "1 hour", recommended: true }, { label: "6 hours", detail: "covers CI" }])
  })
})
