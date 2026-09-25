import { describe, expect, it } from "vitest"

import {
  DEFAULT_LAYOUT,
  MAX_GROUPS,
  MAX_GROUP_NAME,
  createGroup,
  removeGroup,
  type LayoutDoc,
} from "@/lib/design-layout"
import { groupNameProblem } from "./group-name"

// The rule a new group's name must satisfy, as the DIALOG needs it.
//
// `createGroup` refuses a blank name, an over-long one, a duplicate and a call
// at the cap — all four by returning the document unchanged and an empty id.
// Behind `window.prompt` that was invisible: the user typed a name, the dialog
// closed, and nothing appeared. The Pages panel now shows the reason under the
// field and disables Create, which means the rule has to exist somewhere a
// component can ASK — hence `groupNameProblem`, and hence this file: the
// sentences the user reads are pinned without rendering anything, which is the
// repo's convention (see `resources.test.ts`'s `setNameProblem` block, the
// sibling of this one).
//
// It lives beside `pages-panel.tsx` rather than in `lib/design-layout.ts` for
// the reason `pages-order.ts` gives: `createGroup`'s refusal is a layout-engine
// contract, the sentence shown for it is the panel's, and only the second is
// what a dialog needs.

/// A layout holding the named groups, built through `createGroup` so the ids
/// are the real thing rather than a fixture's guess at what an id looks like.
const withGroups = (...names: string[]): LayoutDoc =>
  names.reduce((doc, name) => createGroup(doc, name).doc, DEFAULT_LAYOUT)

/// A layout at `MAX_GROUPS`, for the rule's least reachable branch: `+ New
/// group` is hidden at the cap, so nothing in the UI can get here — the dialog
/// asks anyway, because a rule with an "except" in it is a rule two places have
/// to agree about.
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

  // The whole reason this file is worth its length: the rule is written TWICE —
  // once in `createGroup`, once in `groupNameProblem` — because the two cannot
  // share a module without a lib→pages cycle (see `group-name.ts`'s header).
  // This table is what makes the pair safe: every case is answered by both, and
  // the panel's Create button reads one while the document is built by the
  // other. A disagreement is a disabled button over a name the server would
  // take, or an enabled one over a name that does nothing — the silent no-op,
  // back again.
  //
  // The cases are the boundaries on purpose, not a sample: both sides of the
  // length cap, a duplicate in three spellings, a prefix that only looks like a
  // duplicate, the cap itself, and a name that collides with a group the cap
  // has also filled against. Edit the engine's rule — a new forbidden
  // character, a different cap, a check that moves — and the row that covers it
  // has to be added here in the same commit, or this fails.
  it("agrees with createGroup, so Create is never enabled over a refusal", () => {
    const base = withGroups("Auth")
    const cases: [LayoutDoc, string][] = [
      [DEFAULT_LAYOUT, "Auth"],
      [base, "Ops"],
      [base, ""],
      [base, "   "],
      [base, "auth"],
      [base, "  AUTH  "],
      [base, "Authentication"],
      [base, "A".repeat(MAX_GROUP_NAME)],
      [base, "A".repeat(MAX_GROUP_NAME + 1)],
      // The MEASURE, pinned. 40 emoji is 40 characters but 80 UTF-16 units, so
      // both copies refuse it and this row stays green — the day someone levels
      // this file with `setNameProblem`'s code-point counting (which the server
      // does use), this row turns red instead of the dialog quietly disagreeing
      // with the engine that builds the document.
      [base, "\u{1F3A8}".repeat(MAX_GROUP_NAME)],
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
