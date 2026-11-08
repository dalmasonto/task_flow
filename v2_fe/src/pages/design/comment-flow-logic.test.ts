import { describe, expect, it } from "vitest"

import type { DesignComment } from "@/lib/design-api"

import { bucketCounts, bucketOf, cardState, commentsOn, elementLabel, parseDesignReview, pinTone } from "./comment-flow-logic"

const c = (id: number, status: string, over: Partial<DesignComment> = {}) => ({ id, status, page_path: "/board", element_path: "main > h3.title", orphaned: false, resolution_note: null, created_at: null, ...over }) as unknown as DesignComment

describe("comment flow", () => {
  it("buckets like the design: Open, Sent (incl. addressed), Done", () => {
    expect(["open", "sent", "addressed", "resolved", "dismissed"].map((s) => bucketOf(c(1, s)))).toEqual(["open", "sent", "sent", "done", "done"])
    expect(bucketCounts([c(1, "open"), c(2, "sent"), c(3, "addressed"), c(4, "dismissed")])).toEqual({ open: 1, sent: 2, done: 1 })
  })
  it("colours pins open / sent / done", () => {
    expect(pinTone(c(1, "open"))).toBe("open")
    expect(pinTone(c(1, "sent"))).toBe("sent")
    expect(pinTone(c(1, "addressed"))).toBe("done")
    expect(pinTone(c(1, "open", { orphaned: true }))).toBe("orphaned")
  })
  it("says what each card is waiting on", () => {
    expect(cardState(c(1, "open"), null)).toEqual({ kind: "unsent" })
    expect(cardState(c(1, "sent"), { name: "Claude", online: true })).toEqual({ kind: "working", agent: "Claude" })
    expect(cardState(c(1, "sent"), { name: "Claude", online: false })).toEqual({ kind: "sent", agent: "Claude" })
    expect(cardState(c(1, "addressed", { resolution_note: " Faded it " }), null)).toEqual({ kind: "addressed", note: "Faded it" })
  })
  it("finds comments on an element and labels it", () => {
    expect(commentsOn([c(1, "open"), c(2, "open", { element_path: "x" })], "/board", "main > h3.title").map((x) => x.id)).toEqual([1])
    expect(elementLabel("main > section.board > h3.column-title")).toBe("h3.column-title")
  })
})

describe("parseDesignReview", () => {
  it("reads dispatch messages back into comments", () => {
    const body = `[design-review] 2 comment(s) from dalmas on the Design Surface.
For each: read the target.

--- design comment cm_000c ---
{"target":{"route":"/board","elementPath":"main > h3","src":"pages/board.html:42","component":null},"instruction":"Bigger title","commentId":"cm_000c"}

--- design comment cm_0010 ---
{"target":{"route":"/board","elementPath":"div.col","src":null,"component":"tf-col"},"instruction":"Fade the edge","commentId":"cm_0010"}
`
    expect(parseDesignReview(body)).toEqual([
      { id: 12, route: "/board", elementPath: "main > h3", src: "pages/board.html:42", component: null, instruction: "Bigger title" },
      { id: 16, route: "/board", elementPath: "div.col", src: null, component: "tf-col", instruction: "Fade the edge" },
    ])
    expect(parseDesignReview("hello")).toBeNull()
  })
})
