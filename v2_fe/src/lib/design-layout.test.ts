import { describe, it, expect } from "vitest"
import {
  DEFAULT_LAYOUT,
  MAX_GROUPS,
  MAX_GROUP_NAME,
  normalizeLayout,
  createGroup,
  assignRoute,
  removeGroup,
  groupOf,
} from "./design-layout"

describe("normalizeLayout", () => {
  it("passes a well-formed document through", () => {
    const doc = { view: "bands", routeOrder: ["/"], groups: [{ id: "g1", name: "Auth", routes: ["/login"] }] }
    expect(normalizeLayout(doc)).toEqual({ ...doc, view: "bands" })
  })

  it("falls back to rows for an unknown or missing view", () => {
    expect(normalizeLayout({ view: "diagonal", routeOrder: [], groups: [] }).view).toBe("rows")
    expect(normalizeLayout({}).view).toBe("rows")
  })

  it("drops malformed groups instead of crashing", () => {
    const doc = normalizeLayout({
      view: "groups",
      routeOrder: ["/"],
      groups: [
        { id: "g1", name: "Auth", routes: ["/login"] },
        { id: "g2", name: "No routes" },
        { name: "No id", routes: [] },
        "nonsense",
        null,
      ],
    })
    // g2 survives: a missing `routes` is not malformed. The server's field is
    // `#[serde(default)]`, so `{id, name}` IS the shape of an empty group — and
    // dropping it here would delete, on the next save, a group the server
    // stores and serves happily. Only a group missing an id or a name is
    // dropped, along with non-objects and non-arrays.
    expect(doc.groups.map((g) => g.id)).toEqual(["g1", "g2"])
    expect(doc.groups[1].routes).toEqual([])
  })

  it("returns the default document for non-objects", () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT)
    expect(normalizeLayout("nope")).toEqual(DEFAULT_LAYOUT)
  })

  it("coerces non-string route entries away", () => {
    const doc = normalizeLayout({
      view: "groups",
      routeOrder: ["/", 7, null],
      groups: [{ id: "g1", name: "Auth", routes: ["/login", 7] }],
    })
    expect(doc.routeOrder).toEqual(["/"])
    expect(doc.groups[0].routes).toEqual(["/login"])
  })

  it("normalises a groups view whose groups field is missing or not an array", () => {
    // Task 6's review found the engine throws on `groups.flatMap` if this ever
    // reaches it. This layer is the boundary that must make that impossible.
    expect(normalizeLayout({ view: "groups" }).groups).toEqual([])
    expect(normalizeLayout({ view: "groups", groups: null }).groups).toEqual([])
    expect(normalizeLayout({ view: "groups", groups: "auth" }).groups).toEqual([])
    expect(normalizeLayout({ view: "groups", groups: 7 }).groups).toEqual([])
  })
})

describe("layout edits", () => {
  it("createGroup appends a group with a fresh id", () => {
    const { doc, id } = createGroup(DEFAULT_LAYOUT, "Auth")
    expect(doc.groups).toHaveLength(1)
    expect(doc.groups[0].name).toBe("Auth")
    expect(doc.groups[0].id).toBe(id)
    const { doc: second } = createGroup(doc, "Ops")
    expect(second.groups[1].id).not.toBe(id)
  })

  it("createGroup refuses to exceed the cap or duplicate a name", () => {
    let doc = DEFAULT_LAYOUT
    for (let i = 0; i < MAX_GROUPS; i++) doc = createGroup(doc, `G${i}`).doc
    expect(createGroup(doc, "One more").doc).toBe(doc)
    // The brief's line here read `createGroup(DEFAULT_LAYOUT, "Auth").doc` —
    // that call *creates* the group (see the test above), so nothing is refused
    // and no unchanged document can come back. The duplicate it means to check
    // needs a document that already has the name, and refusal is by identity:
    // the input document itself comes back, which is how the caller reads
    // "nothing happened".
    const withAuth = createGroup(DEFAULT_LAYOUT, "Auth").doc
    expect(createGroup(withAuth, "Auth").doc).toBe(withAuth)
    expect(createGroup(createGroup(DEFAULT_LAYOUT, "Auth").doc, "  auth  ").doc.groups).toHaveLength(1)
  })

  it("createGroup insists on a 1-40 character name, trimmed", () => {
    // The same bounds the server enforces (`layout_doc.rs`): a name the client
    // accepted but the server 400s is a bug, so both edges are pinned here.
    expect(createGroup(DEFAULT_LAYOUT, "   ").doc).toBe(DEFAULT_LAYOUT)
    expect(createGroup(DEFAULT_LAYOUT, "A".repeat(MAX_GROUP_NAME)).id).not.toBe("")
    expect(createGroup(DEFAULT_LAYOUT, "A".repeat(MAX_GROUP_NAME + 1)).doc).toBe(DEFAULT_LAYOUT)
  })

  it("assignRoute moves a page into exactly one group", () => {
    const a = createGroup(DEFAULT_LAYOUT, "Auth").doc
    const b = createGroup(a, "Ops").doc
    const [g1, g2] = b.groups.map((g) => g.id)

    const inAuth = assignRoute(b, "/login", g1)
    expect(groupOf(inAuth, "/login")!.id).toBe(g1)

    const moved = assignRoute(inAuth, "/login", g2)
    expect(groupOf(moved, "/login")!.id).toBe(g2)
    expect(moved.groups.find((g) => g.id === g1)!.routes).toEqual([])
  })

  it("assignRoute with null ungroups", () => {
    const doc = createGroup(DEFAULT_LAYOUT, "Auth").doc
    const inGroup = assignRoute(doc, "/login", doc.groups[0].id)
    expect(groupOf(assignRoute(inGroup, "/login", null), "/login")).toBeUndefined()
  })

  it("removeGroup drops the group and leaves its pages ungrouped", () => {
    const doc = createGroup(DEFAULT_LAYOUT, "Auth").doc
    const id = doc.groups[0].id
    const withRoute = assignRoute(doc, "/login", id)
    const removed = removeGroup(withRoute, id)
    expect(removed.groups).toEqual([])
    expect(groupOf(removed, "/login")).toBeUndefined()
  })

  it("edits never mutate the input document", () => {
    const doc = createGroup(DEFAULT_LAYOUT, "Auth").doc
    const before = JSON.stringify(doc)
    createGroup(doc, "Ops")
    assignRoute(doc, "/login", doc.groups[0].id)
    removeGroup(doc, doc.groups[0].id)
    expect(JSON.stringify(doc)).toBe(before)
  })
})
