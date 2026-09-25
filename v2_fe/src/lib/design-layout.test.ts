import { describe, it, expect } from "vitest"
import {
  DEFAULT_LAYOUT,
  MAX_GROUPS,
  MAX_GROUP_NAME,
  MAX_LABEL,
  normalizeLayout,
  createGroup,
  groupNameProblem,
  assignRoute,
  removeGroup,
  groupOf,
  pageLabel,
  setPageLabel,
  type LayoutDoc,
} from "./design-layout"

describe("normalizeLayout", () => {
  it("passes a well-formed document through", () => {
    // `pageLabels` is part of the wire document (always present — `{}` when
    // empty), so the "well-formed document" fixture has to carry one; the
    // server's `#[serde(default)]` does not make it optional on the way out.
    const doc = {
      view: "bands",
      routeOrder: ["/"],
      groups: [{ id: "g1", name: "Auth", routes: ["/login"] }],
      pageLabels: { "/": "Home" },
    }
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

  it("counts a name the way the SERVER counts it: code points, not UTF-16 units", () => {
    // `layout_doc.rs:95` measures `name.chars().count()` — code points. JS's
    // `.length` measures UTF-16 units, so one astral character (an emoji, most
    // of the CJK extension planes) is 2 there and 1 here. Counting units makes
    // the client STRICTER than the server: a 40-emoji name the server accepts
    // is refused here, with a sentence ("limited to 40 characters") that is
    // literally false about the name the user typed. `setNameProblem` already
    // counts code points (`[...trimmed].length`) for exactly this reason, and
    // the resources baseline proves it.
    //
    // Which way this proves: every expectation below PASSES under
    // `[...name].length` and FAILS under `.length` — 40 emoji is 40 code
    // points (accepted) but 80 UTF-16 units (refused), so `.length` turns the
    // first two lines red. The ASCII test above is green under either measure,
    // which is why it never caught this.
    const emoji = "\u{1F3A8}" // one code point, two UTF-16 units
    const atCap = emoji.repeat(MAX_GROUP_NAME)
    expect(atCap.length).toBe(MAX_GROUP_NAME * 2) // the measure being pinned against
    expect([...atCap].length).toBe(MAX_GROUP_NAME)

    const { doc, id } = createGroup(DEFAULT_LAYOUT, atCap)
    expect(id).not.toBe("")
    expect(doc.groups[0].name).toBe(atCap)

    // One code point past the cap is still refused: this is a change of
    // MEASURE, not a relaxation, and the boundary is the server's.
    expect(createGroup(DEFAULT_LAYOUT, emoji.repeat(MAX_GROUP_NAME + 1)).doc).toBe(DEFAULT_LAYOUT)
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

// The rule a new group's name must satisfy, as the Pages panel's dialog needs
// it. It lives beside `createGroup` — the function that enforces it — and these
// are that module's tests, which is the whole point of the arrangement: the
// sentences the user reads and the refusal that builds the document are ONE
// check, so there is no pair of copies for a test to hold together.
//
// The sentences are pinned without rendering anything, the repo's convention
// (see the `setNameProblem` block in `resources.test.ts`, this rule's sibling).

/// A layout holding the named groups, built through `createGroup` so the ids
/// are the real thing rather than a fixture's guess at what an id looks like.
const withGroups = (...names: string[]): LayoutDoc =>
  names.reduce((doc, name) => createGroup(doc, name).doc, DEFAULT_LAYOUT)

/// A layout at `MAX_GROUPS`, for the rule's least reachable branch: `+ New
/// group` is hidden at the cap, so the button cannot be clicked into it — the
/// dialog asks anyway, because it can be OPEN when the cap is reached (the
/// layout arrives from another viewer), and a rule with an "except" in it is a
/// rule two places have to agree about.
const fullLayout = (): LayoutDoc =>
  withGroups(...Array.from({ length: MAX_GROUPS }, (_, i) => `G${i}`))

describe("groupNameProblem", () => {
  it("refuses a blank or whitespace-only name", () => {
    // `createGroup` trims first, so "   " is the same refusal as "" — and the
    // one a user is likeliest to hit, by typing a space and pressing Enter.
    for (const name of ["", " ", "   ", "\t", "\n  "]) {
      expect(groupNameProblem(DEFAULT_LAYOUT, name), JSON.stringify(name)).not.toBeNull()
    }
  })

  it("takes a name exactly at the cap and refuses one character past it", () => {
    // The boundary itself, both sides of it: an off-by-one here is a name the
    // server would accept being refused in front of the user, with a message
    // claiming a cap it has not reached.
    expect(groupNameProblem(DEFAULT_LAYOUT, "A".repeat(MAX_GROUP_NAME))).toBeNull()
    expect(groupNameProblem(DEFAULT_LAYOUT, "A".repeat(MAX_GROUP_NAME + 1))).not.toBeNull()
    // The cap counts the TRIMMED name — `createGroup` stores `trimmed`, so
    // padding a 40-character name out to 44 must not refuse it.
    expect(
      groupNameProblem(DEFAULT_LAYOUT, `  ${"A".repeat(MAX_GROUP_NAME)}  `),
    ).toBeNull()
    // The MEASURE, from the panel's side: 40 emoji is 40 code points, the
    // server's count, so Create lights up. Under `.length` this row is 80 and
    // the dialog refuses a name the server takes, with a sentence that is false
    // about what was typed. The engine's half of this boundary is in
    // `layout edits` below; the two are the same function, so they cannot part.
    const emoji = "\u{1F3A8}"
    expect(groupNameProblem(DEFAULT_LAYOUT, emoji.repeat(MAX_GROUP_NAME))).toBeNull()
    expect(groupNameProblem(DEFAULT_LAYOUT, emoji.repeat(MAX_GROUP_NAME + 1))).toContain(
      String(MAX_GROUP_NAME),
    )
  })

  it("refuses a duplicate in a different case", () => {
    const doc = withGroups("Auth")

    // `createGroup` lower-cases both sides, so a group named "Auth" makes
    // "auth", "AUTH" and "  Auth  " all taken — and a user who types "auth"
    // after creating "Auth" is the likeliest way to meet this rule.
    for (const name of ["auth", "AUTH", "  Auth  ", "aUtH"]) {
      expect(groupNameProblem(doc, name), name).not.toBeNull()
    }
    // A prefix is not a duplicate: the rule is equality, not containment.
    expect(groupNameProblem(doc, "Authentication")).toBeNull()
  })

  // The one worth pinning: nothing is cached. The rule reads the document it is
  // HANDED, at the moment it is called, so the panel can call it on every
  // keystroke against the live layout — and a group removed in another tab
  // (or by the group editor) frees its name without the dialog knowing.
  it("reads the layout it is given, not a snapshot of it", () => {
    const doc = withGroups("Auth", "Ops")
    const [auth, ops] = doc.groups

    // Removing an UNRELATED group does not free "Auth": the name is still in
    // the document, so it is still refused. A rule that answered from a stale
    // copy — or from the wrong group — would accept it here.
    expect(groupNameProblem(removeGroup(doc, ops.id), "auth")).not.toBeNull()
    expect(groupNameProblem(removeGroup(doc, ops.id), "ops")).toBeNull()

    // And removing THAT group does free it — the same call, one document
    // later. Both directions are needed: the first says the rule is not
    // forgotten, the second says it is not latched.
    expect(groupNameProblem(removeGroup(doc, auth.id), "auth")).toBeNull()
  })

  it("refuses at the group cap and names the cap", () => {
    const full = fullLayout()
    expect(full.groups).toHaveLength(MAX_GROUPS)

    const problem = groupNameProblem(full, "One more")
    expect(problem).not.toBeNull()
    expect(problem).toContain(String(MAX_GROUPS))
  })

  it("names the rule that was broken", () => {
    // Four refusals, four sentences: the field under the dialog is the whole
    // feedback loop, so a blank name and a duplicate must not read the same.
    const doc = withGroups("Auth")
    expect(groupNameProblem(doc, "   ")).toMatch(/name/i)
    expect(groupNameProblem(doc, "AUTH")).toMatch(/already/i)
    expect(groupNameProblem(doc, "A".repeat(MAX_GROUP_NAME + 1))).toContain(
      String(MAX_GROUP_NAME),
    )
    expect(groupNameProblem(fullLayout(), "One more")).toContain(String(MAX_GROUPS))
    expect(groupNameProblem(doc, "Ops")).toBeNull()
  })

  // What the OLD agreement table guarded — two copies of the rule drifting — is
  // now impossible: `createGroup` refuses by calling this very function, so the
  // sentence the panel shows and the document the engine builds are one check.
  //
  // This test is kept, re-aimed, because a different failure mode took the old
  // one's place: a refusal the rule knows nothing about, ADDED to the engine
  // beside it — a reserved name, a stricter trim, an id the name has to satisfy.
  // The panel enables Create on the RULE's answer, so such a refusal is a button
  // that does nothing, the silent no-op this dialog exists to remove. The direct
  // assertions above cannot see it: each pins only the checks it names.
  //
  // Proven by mutation, not assumed. Refusing an untrimmed name inside
  // `createGroup` (`if (name.trim() !== name) return { doc, id: "" }`) fails
  // this test and NOTHING else in the file — 1 failed | 26 passed — which is
  // what the `[base, "  Ops  "]` row below is for: a usable padded name, the
  // one case here no direct test carries.
  it("refuses exactly when the rule has a reason, so Create is never enabled over a refusal", () => {
    const base = withGroups("Auth")
    const cases: [LayoutDoc, string][] = [
      [DEFAULT_LAYOUT, "Auth"],
      [base, "Ops"],
      [base, ""],
      [base, "   "],
      [base, "auth"],
      [base, "  AUTH  "],
      [base, "Authentication"],
      // A usable name with padding on it: the rule allows it, and the engine
      // must too — storing it trimmed. This row is the one the direct tests do
      // not have (they carry a padded name only through the RULE, and a padded
      // duplicate through the engine, which refuses either way), and it is what
      // catches an engine that refuses what the rule allows — mutation M-3.
      [base, "  Ops  "],
      [base, "A".repeat(MAX_GROUP_NAME)],
      [base, "A".repeat(MAX_GROUP_NAME + 1)],
      [base, "\u{1F3A8}".repeat(MAX_GROUP_NAME)],
      [base, "\u{1F3A8}".repeat(MAX_GROUP_NAME + 1)],
      [fullLayout(), "One more"],
      [fullLayout(), "G0"],
      [fullLayout(), ""],
    ]
    for (const [doc, name] of cases) {
      expect([name, groupNameProblem(doc, name) !== null]).toEqual([
        name,
        createGroup(doc, name).id === "",
      ])
    }
  })
})

describe("page labels", () => {
  it("falls back to the manifest title when no label is set", () => {
    expect(pageLabel(DEFAULT_LAYOUT, "/", "Dashboard")).toBe("Dashboard")
  })

  it("prefers a label, and treats a blank one as unset", () => {
    const doc = setPageLabel(DEFAULT_LAYOUT, "/", "  Home  ")
    expect(pageLabel(doc, "/", "Dashboard")).toBe("Home")
    // A blank label must behave like no label, not like an empty name. Neither
    // `setPageLabel` nor the server will store one, so this document is built
    // by hand: a blank arriving from anywhere else still has to render a name.
    const blank = { ...DEFAULT_LAYOUT, pageLabels: { "/": "   ", "/login": "" } }
    expect(pageLabel(blank, "/", "Dashboard")).toBe("Dashboard")
    expect(pageLabel(blank, "/login", "Login")).toBe("Login")
  })

  it("clearing a label removes the key", () => {
    const doc = setPageLabel(DEFAULT_LAYOUT, "/", "Home")
    const cleared = setPageLabel(doc, "/", "   ")
    expect(cleared.pageLabels["/"]).toBeUndefined()
    expect(pageLabel(cleared, "/", "Dashboard")).toBe("Dashboard")
  })

  it("refuses a label over the cap, returning the document unchanged", () => {
    const doc = setPageLabel(DEFAULT_LAYOUT, "/", "x".repeat(MAX_LABEL + 1))
    expect(doc).toBe(DEFAULT_LAYOUT)
  })

  it("normaliseLayout defaults a missing or malformed pageLabels", () => {
    expect(normalizeLayout({ view: "rows" }).pageLabels).toEqual({})
    expect(normalizeLayout({ view: "rows", pageLabels: "nope" }).pageLabels).toEqual({})
    expect(normalizeLayout({ view: "rows", pageLabels: { "/": 7 } }).pageLabels).toEqual({})
    // A blank is dropped rather than kept: the server refuses to store one, so
    // keeping it here would render an empty page name.
    expect(normalizeLayout({ view: "rows", pageLabels: { "/": "  " } }).pageLabels).toEqual({})
    expect(normalizeLayout({ view: "rows", pageLabels: { "/": "Home" } }).pageLabels).toEqual({ "/": "Home" })
  })

  it("edits do not mutate the input", () => {
    const doc = DEFAULT_LAYOUT
    const before = JSON.stringify(doc)
    setPageLabel(doc, "/", "Home")
    expect(JSON.stringify(doc)).toBe(before)
  })
})
