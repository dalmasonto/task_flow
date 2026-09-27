import { describe, expect, it } from "vitest"

import { type FlowDoc, COLUMN_GAP, ROW_GAP, flowPositions, linkPages, linkProblem, nextEdgeId, placePage, relabel, unlink } from "./flow-layout"

const NODE = { w: 400, h: 900 }
const col = (n: number) => n * (NODE.w + COLUMN_GAP)
const row = (n: number) => n * (NODE.h + ROW_GAP)

describe("flowPositions (#508)", () => {
  it("lays a flow out left to right, one column per step", () => {
    const pos = flowPositions(["/", "/login", "/home"], {
      edges: [
        { id: "e1", from: "/", to: "/login" },
        { id: "e2", from: "/login", to: "/home" },
      ],
    }, NODE)
    expect(pos["/"]).toEqual({ x: col(0), y: row(0) })
    expect(pos["/login"]).toEqual({ x: col(1), y: row(0) })
    expect(pos["/home"]).toEqual({ x: col(2), y: row(0) })
  })

  it("stacks branches in the same column (new user / existing user)", () => {
    const pos = flowPositions(["/", "/signup", "/login"], {
      edges: [
        { id: "e1", from: "/", to: "/signup", label: "new user" },
        { id: "e2", from: "/", to: "/login", label: "existing user" },
      ],
    }, NODE)
    expect(pos["/signup"]).toEqual({ x: col(1), y: row(0) })
    expect(pos["/login"]).toEqual({ x: col(1), y: row(1) })
  })

  it("survives a cycle", () => {
    const pos = flowPositions(["/a", "/b"], {
      edges: [
        { id: "e1", from: "/a", to: "/b" },
        { id: "e2", from: "/b", to: "/a" },
      ],
    }, NODE)
    expect(Object.keys(pos).sort()).toEqual(["/a", "/b"])
    expect(pos["/a"].x).not.toBe(pos["/b"].x)
  })

  it("keeps hand-placed pages and puts new ones below them, never on top", () => {
    const pos = flowPositions(["/a", "/b"], { positions: { "/a": { x: 0, y: 500 } } }, NODE)
    expect(pos["/a"]).toEqual({ x: 0, y: 500 })
    expect(pos["/b"]).toEqual({ x: 0, y: 500 + NODE.h + ROW_GAP })
  })

  it("ignores edges to pages that are not on the canvas", () => {
    const pos = flowPositions(["/a"], { edges: [{ id: "e1", from: "/a", to: "/gone" }] }, NODE)
    expect(pos).toEqual({ "/a": { x: 0, y: 0 } })
  })
})

describe("editing the flow (#508)", () => {
  it("mints e<n> one past the highest id", () => {
    expect(nextEdgeId([])).toBe("e1")
    expect(nextEdgeId([{ id: "e2", from: "/", to: "/a" }, { id: "x9", from: "/", to: "/b" }])).toBe("e3")
  })

  it("links, relabels and unlinks, refusing self-links and duplicates", () => {
    let doc = linkPages({} as FlowDoc, "/", "/login", "  existing user  ")
    expect(doc.edges).toEqual([{ id: "e1", from: "/", to: "/login", label: "existing user" }])
    expect(linkProblem(doc, "/", "/login")).toMatch(/already/)
    expect(linkProblem(doc, "/", "/")).toMatch(/itself/)
    expect(linkPages(doc, "/", "/login")).toBe(doc)
    doc = relabel(doc, "e1", "")
    expect(doc.edges?.[0]).toEqual({ id: "e1", from: "/", to: "/login" })
    doc = unlink(doc, "e1")
    expect(doc.edges).toEqual([])
  })

  it("pins a dropped page at whole pixels", () => {
    expect(placePage({} as FlowDoc, "/a", { x: 10.6, y: -3.2 }).positions).toEqual({ "/a": { x: 11, y: -3 } })
  })
})

describe("flowPositions around a hand-placed page (#508)", () => {
  it("keeps a page in its natural slot when a dropped page is elsewhere in the column", () => {
    // Seen in a browser run: /pricing dropped low in column 1 pushed /help to
    // 2221px. /help's natural slot (column 1, first row) is free, so it stays.
    const pos = flowPositions(["/a", "/b", "/c"], {
      edges: [{ id: "e1", from: "/a", to: "/b" }],
      positions: { "/c": { x: 448, y: 1185 } },
    }, NODE)
    expect(pos["/b"]).toEqual({ x: col(1), y: row(0) })
  })
})
