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
  filterRouteOrder,
  moveRoute,
  resolveRouteOrder,
  setRouteOrder,
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
    // Which way this proves, and how far: `.length` turns the `createGroup`
    // line below red — 40 emoji is 40 code points (accepted) but 80 UTF-16
    // units (refused) — so the direction is pinned. NOT every expectation here
    // discriminates, and saying so is the point: the two raw-string assertions
    // measure the two spellings directly, and the one-code-point-past-the-cap
    // refusal below is refused under EITHER measure, so those three are
    // measure-insensitive by construction. The ASCII test above is green under
    // either measure too, which is why it never caught this.
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

// The FLOW: the order the pages are presented in, which the user builds by
// moving pages up and down in the Pages panel.
//
// Two properties run through everything below, and both are about the SERVER
// rather than about the screen. The document is written back whole
// (`updateLayout` PUTs the whole `LayoutDoc`), so an order naming a route the
// manifest does not have is refused with a 400 — the save fails, the edit is
// lost, and the error is about a field the user never touched. And the order is
// read back through `filter_to_known`, so what a save stores and what the next
// read returns must be the same list, or the flow would move under the user on
// every reload.
//
// The page list here is the manifest's, and this module has no manifest: the
// functions take it as an argument, which is also what keeps them testable.
const PAGES = ["/", "/login", "/signup", "/settings"]

/// A document whose flow is `order` — the shape a save writes and a read
/// returns. Built through the spread rather than by hand so a new field on
/// `LayoutDoc` cannot leave this fixture a shape the wire never has.
const flowed = (order: string[]): LayoutDoc => ({ ...DEFAULT_LAYOUT, routeOrder: order })

describe("resolveRouteOrder", () => {
  // The state every project is in until someone moves something. The fallback
  // has to be the pages' own order rather than nothing — `routeOrder` empty is
  // the normal case, not an error case.
  it("falls back to the pages' own order when no flow has been set", () => {
    expect(resolveRouteOrder(DEFAULT_LAYOUT, PAGES)).toEqual(PAGES)
  })

  it("puts the stored flow first, then the pages it does not name, in their own order", () => {
    expect(resolveRouteOrder(flowed(["/signup", "/login"]), PAGES)).toEqual([
      "/signup",
      "/login",
      "/",
      "/settings",
    ])
  })

  // The two rules the server applies on the way in (`layout_doc.rs:121-130`),
  // applied here so that a document this module builds is one the server takes:
  // an unknown route is refused, and a repeat is dropped FIRST-WINS
  // (`seen_order.insert`). The second half is what keeps an optimistic render
  // equal to what the next read returns.
  it("drops an entry that is not a page, and keeps the first mention of a page named twice", () => {
    const resolved = resolveRouteOrder(flowed(["/ghost", "/signup", "/login", "/signup"]), PAGES)

    expect(resolved).toEqual(["/signup", "/login", "/", "/settings"])
    expect(resolved).toHaveLength(PAGES.length)
  })

  // THE REPAIR CASE, and the reason this cannot be a filter alone. A stored
  // order is a snapshot of the pages at the time it was written: the project has
  // since gained `/settings` and lost `/about`. The order must still be TOTAL —
  // a page missing from it would have no position, and every consumer of this
  // (the panel's list, the canvas's boards) draws what it is given and would
  // simply lose the page.
  it("is a total order over the pages it is given — a page added later is appended, a deleted one is gone", () => {
    const stored = flowed(["/about", "/login", "/"])
    const resolved = resolveRouteOrder(stored, PAGES)

    expect([...resolved].sort()).toEqual([...PAGES].sort())
    expect(resolved.slice(0, 2)).toEqual(["/login", "/"]) // the flow, unknown entry dropped
    expect(resolved).not.toContain("/about") // not a page any more
    expect(resolved).toContain("/settings") // added after the flow was written
  })
})

describe("filterRouteOrder", () => {
  it("drops the entries the manifest no longer has, and dedupes first-wins", () => {
    const filtered = filterRouteOrder(flowed(["/ghost", "/signup", "/signup"]), PAGES)

    expect(filtered.routeOrder).toEqual(["/signup"])
  })

  // The reason this exists on the WRITE path: the flow is stored whole, so it
  // names every page — and the manifest is fetched once per project, so a page
  // deleted in another tab leaves this document naming a route the server has.
  // Every later save of ANY layout edit would then be a 400, and the flow would
  // have wedged an unrelated control. Filtering keeps the document writable.
  //
  // `null` is "the manifest is not known here" (still loading, or another
  // project's copy): nothing can be judged, so nothing is dropped. Filtering
  // against an empty list instead would wipe the user's flow on a save that
  // happened before the manifest arrived.
  it("filters nothing when the manifest is not known, rather than wiping the flow", () => {
    const doc = flowed(["/signup", "/ghost"])

    expect(filterRouteOrder(doc, null)).toBe(doc)
  })
})

describe("setRouteOrder", () => {
  it("stores an order that resolves to the order asked for", () => {
    const wanted = ["/settings", "/", "/login", "/signup"]
    const doc = setRouteOrder(DEFAULT_LAYOUT, wanted, PAGES)

    expect(resolveRouteOrder(doc, PAGES)).toEqual(wanted)
  })

  // The 400 guard, as a property rather than a case: whatever the caller passes,
  // what lands in the document is a subset of the pages the caller named as
  // belonging to the project. A stale entry can therefore never reach a save
  // from here.
  it("never stores a route the caller did not name as a page", () => {
    const doc = setRouteOrder(DEFAULT_LAYOUT, ["/ghost", "/nope", "/login"], PAGES)

    expect(doc.routeOrder.every((route) => PAGES.includes(route))).toBe(true)
    expect(doc.routeOrder).toContain("/login")
  })

  // `setRouteOrder` is the writer `moveRoute` goes through, so a stale entry
  // already in the document is cleaned by any move — the flow is normalised on
  // the way out, not merely on the way in.
  it("cleans a stale entry out of the document it is given", () => {
    const doc = setRouteOrder(flowed(["/ghost", "/login"]), ["/login"], PAGES)

    expect(doc.routeOrder).not.toContain("/ghost")
  })

  it("does not mutate the document it is given", () => {
    const doc = flowed(["/login"])
    const before = JSON.stringify(doc)
    setRouteOrder(doc, ["/settings"], PAGES)
    expect(JSON.stringify(doc)).toBe(before)
  })
})

describe("moveRoute", () => {
  // The first move of a session: the document has no flow at all, and the move
  // has to be a move within the pages' own order — not a move within an empty
  // list, which would drop every page but the two that swapped.
  it("moves a page one place down, from the pages' own order", () => {
    const doc = moveRoute(DEFAULT_LAYOUT, "/", 1, PAGES)

    expect(resolveRouteOrder(doc, PAGES)).toEqual(["/login", "/", "/signup", "/settings"])
  })

  it("moves a page one place up", () => {
    const doc = moveRoute(DEFAULT_LAYOUT, "/settings", -1, PAGES)

    expect(resolveRouteOrder(doc, PAGES)).toEqual(["/", "/login", "/settings", "/signup"])
  })

  // The one that says the move is applied to the FLOW and not to the pages' own
  // order: in the user's order, `/signup` sits after `/login`, and after the
  // move it must sit after `/settings` — a `moveRoute` that rebuilt the list
  // from `routes` first would put it back beside `/login`.
  it("moves within the flow the user set, not within the pages' own order", () => {
    const doc = moveRoute(flowed(["/settings", "/login", "/signup", "/"]), "/login", 1, PAGES)

    expect(resolveRouteOrder(doc, PAGES)).toEqual(["/settings", "/signup", "/login", "/"])
  })

  // The ends of the list: the panel draws both of these as a disabled control,
  // and this is the same rule one layer down, so a click that got through
  // anyway (a keyboard, a stale render) cannot wrap `/` to the bottom. Refusal
  // is by IDENTITY, the way every other refusal in this module reads, so a
  // caller can tell "nothing happened" without comparing the lists.
  it("refuses to move the first page up or the last page down", () => {
    // No flow stored, so the list being moved in is the pages' own order and
    // the ends are the manifest's ends. `flowed` builds that state explicitly
    // rather than leaning on `DEFAULT_LAYOUT`'s spelling of it.
    const doc = flowed([])

    expect(moveRoute(doc, "/", -1, PAGES)).toBe(doc)
    expect(moveRoute(doc, "/settings", 1, PAGES)).toBe(doc)
  })

  it("is a no-op for a route that is not a page", () => {
    const doc = DEFAULT_LAYOUT

    expect(moveRoute(doc, "/ghost", 1, PAGES)).toBe(doc)
  })

  // A move, not a swap: the pages in between shift the other way, and a page
  // asked to go past the end stops at it rather than wrapping. The two cases
  // are here together because they are the same rule — where the page lands —
  // read at a distance of two and at a distance past the list.
  it("moves a page by more than one place, and stops at the end", () => {
    const twoDown = moveRoute(DEFAULT_LAYOUT, "/", 2, PAGES)
    const past = moveRoute(DEFAULT_LAYOUT, "/login", 99, PAGES)

    // A swap would have traded `/` with `/signup` and left `/login` where it
    // was: ["/", "/login", "/signup", "/settings"] with the first two traded.
    expect(resolveRouteOrder(twoDown, PAGES)).toEqual(["/login", "/signup", "/", "/settings"])
    expect(resolveRouteOrder(past, PAGES)).toEqual(["/", "/signup", "/settings", "/login"])
  })

  // The writability property, at the layer the UI uses: whatever the document
  // already said, a move leaves nothing in the order that the server would
  // refuse — so the very next save cannot 400 on a stale entry.
  it("never builds an order the server would refuse, whatever the document held", () => {
    const doc = moveRoute(flowed(["/ghost", "/login", "/about"]), "/login", 2, PAGES)

    // The stale and the unknown entry are both gone, and the move was applied
    // to the flow those entries were filtered OUT of: `/login` led it, and two
    // places down puts it after `/signup`.
    expect(doc.routeOrder).toEqual(["/", "/signup", "/login", "/settings"])
    expect(doc.routeOrder.every((route) => PAGES.includes(route))).toBe(true)
  })

  // The clamp has to be TOTAL, and `Math.max(0, NaN)` is `NaN`: with a delta
  // that is not a whole number the `to === from` refusal is false, `splice(NaN,
  // 0, …)` treats its start as 0, and the page is inserted at the TOP — a move
  // nobody asked for, spelled by a caller that passed nothing sensible. The
  // panel only ever passes ±1, so this is reachable through the next caller
  // rather than today's — and `moveRoute` is the seam a drag or a "move to top"
  // would go through. It refuses instead of guessing.
  it("refuses a delta that is not a whole number, rather than sending the page to the top", () => {
    const doc = flowed([])

    for (const delta of [NaN, Infinity, -Infinity, 1.5]) {
      expect(moveRoute(doc, "/login", delta, PAGES), String(delta)).toBe(doc)
    }
    // The refusal is the DELTA's and not a general one: the same call with a
    // whole number still moves the page.
    expect(moveRoute(doc, "/login", 1, PAGES)).not.toBe(doc)
  })

  it("does not mutate the document it is given", () => {
    const doc = flowed(["/login", "/"])
    const before = JSON.stringify(doc)
    moveRoute(doc, "/login", 1, PAGES)
    expect(JSON.stringify(doc)).toBe(before)
  })
})
