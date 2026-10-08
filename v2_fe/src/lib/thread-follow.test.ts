import { describe, expect, it } from "vitest"
import { isAtBottom, tailChange } from "./thread-follow"

const m = (id: string, from = "Claude") => ({ id, from })

describe("tailChange", () => {
  it("counts messages appended after the previous last one", () => {
    expect(tailChange("2", [m("1"), m("2"), m("3"), m("4")])).toEqual({ appended: 2, ownAppended: false })
  })

  it("ignores a prepend of older history", () => {
    expect(tailChange("3", [m("0"), m("1"), m("2"), m("3")])).toEqual({ appended: 0, ownAppended: false })
  })

  it("ignores a first load", () => {
    expect(tailChange(null, [m("1"), m("2")])).toEqual({ appended: 0, ownAppended: false })
  })

  it("flags the user's own send", () => {
    expect(tailChange("2", [m("1"), m("2"), m("pending:x", "user")])).toEqual({ appended: 1, ownAppended: true })
  })

  it("treats an optimistic bubble swapped for its server id as one own message", () => {
    expect(tailChange("pending:x", [m("1"), m("2"), m("3", "user")])).toEqual({ appended: 1, ownAppended: true })
  })
})

describe("isAtBottom", () => {
  it("is true within the slack and false beyond it", () => {
    expect(isAtBottom({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1450 })).toBe(true)
    expect(isAtBottom({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1000 })).toBe(false)
  })
})
