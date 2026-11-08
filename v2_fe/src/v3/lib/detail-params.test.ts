import { describe, expect, it } from "vitest"

import { detailHref, readDetail, withDetail } from "./detail-params"

describe("detail sheet params", () => {
  it("reads what the URL asks for", () => {
    expect(readDetail(new URLSearchParams("task=12"))).toEqual({ kind: "task", id: "12" })
    expect(readDetail(new URLSearchParams("task=new&status=blocked"))).toEqual({ kind: "new-task", status: "blocked" })
    expect(readDetail(new URLSearchParams("task=new&status=bogus"))).toEqual({ kind: "new-task", status: "not_started" })
    expect(readDetail(new URLSearchParams("activity=9"))).toEqual({ kind: "activity", id: 9 })
    expect(readDetail(new URLSearchParams("task=12abc"))).toBeNull()
    expect(readDetail(new URLSearchParams("q=x"))).toBeNull()
  })
  it("swaps the sheet's keys and keeps the rest", () => {
    expect(withDetail("?q=x&task=3", { kind: "activity", id: 4 })).toBe("?q=x&activity=4")
    expect(withDetail("?task=new&status=done", null)).toBe("")
    expect(withDetail("", { kind: "new-task", status: "not_started" })).toBe("?task=new")
  })
  it("uses full pages on the task page", () => {
    expect(detailHref("/v3/board", "?q=x", { kind: "task", id: "5" })).toBe("/v3/board?q=x&task=5")
    expect(detailHref("/v3/tasks/4", "", { kind: "task", id: "5" })).toBe("/v3/tasks/5")
    expect(detailHref("/v3/tasks/4", "", { kind: "activity", id: 2 })).toBe("/v3/tasks/4?activity=2")
  })
})
