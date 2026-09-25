import { describe, it, expect } from "vitest"
import { findActiveProject, resolveActiveProject } from "./active-project"

/// Which project is active, answered in exactly ONE place.
///
/// Two independently-written answers existed before this: the loader
/// (App.tsx loadLiveWorkspace) and the render path (`workspaceProjects[0]`).
/// Both fell back to LIST ORDER, which the client does not control — the summary
/// comes back ordered by name — so when the active id was missing from a freshly
/// fetched list the active project silently became whichever project happened to
/// be first. The user's report: "different projects try to take that spot".
///
/// Every test below names what would have to change for it to fail.
describe("resolveActiveProject", () => {
  const projects = [{ id: "7" }, { id: "3" }, { id: "11" }]

  // Fails if the function stops checking membership: a preferred id that IS in
  // the list must win outright, however far down the list it sits.
  it("keeps the preferred project when the fresh list still holds it", () => {
    expect(resolveActiveProject("11", null, projects)).toBe("11")
  })

  // Fails if the second preference is dropped (returns `projects[0]`, i.e. "7")
  // or if `preferred`/`persisted` are consulted in the other order.
  it("falls back to the persisted choice when the preferred id is gone", () => {
    expect(resolveActiveProject("404", "3", projects)).toBe("3")
  })

  // Fails if a stale persisted id is trusted without a membership check — the
  // answer would name a project this client cannot load.
  it("does not return a persisted id that is no longer in the list", () => {
    expect(resolveActiveProject(null, "404", projects)).toBe("7")
  })

  // Fails if the positional fallback is removed: with no preference at all
  // (first ever load, nothing persisted) the first project is the honest answer.
  it("falls back to the first project when neither preference survives", () => {
    expect(resolveActiveProject(null, null, projects)).toBe("7")
    expect(resolveActiveProject("404", "404", projects)).toBe("7")
  })

  // Fails if the function invents an id (`projects[0].id` on an empty list
  // throws) or returns `undefined`/`""` — App.tsx's `activeProjectId` is
  // `string | null`, and null is what renders the empty state.
  it("returns null for an empty list rather than throwing or inventing an id", () => {
    expect(resolveActiveProject(null, null, [])).toBeNull()
    expect(resolveActiveProject("7", "3", [])).toBeNull()
  })

  // THE USER'S COMPLAINT, encoded: the summary is ordered server-side, so a
  // rename or an insert above the active project reorders the list it is
  // compared against. While the preferred project is still in that list the
  // answer must not move.
  //
  // Fails if any branch returns a positional answer before the membership checks.
  it("does not move when the list merely reorders around the preferred project", () => {
    const before = [{ id: "7" }, { id: "3" }, { id: "11" }]
    const after = [{ id: "11" }, { id: "7" }, { id: "3" }]
    const first = resolveActiveProject("7", null, before)
    expect(resolveActiveProject("7", null, after)).toBe(first)
    // And the same for the persisted path, where the preferred id has gone.
    expect(resolveActiveProject("404", "11", after)).toBe("11")
  })

  // The ids on both sides of every comparison are STRINGS: `Project.id` is
  // `string` (mapLiveProjects casts with String(project.id)) while the API's own
  // ids are numbers. A `===` between the two fails silently and looks exactly
  // like "no preference", so the answer must always come FROM THE LIST and never
  // be an unvalidated input echoed back.
  //
  // Fails if the membership check is loosened to a coercing comparison, or if a
  // caller-supplied id is returned without being found in the list.
  it("only ever returns an id drawn from the list", () => {
    expect(resolveActiveProject(7 as unknown as string, null, [{ id: "7" }])).toBe("7")
    expect(resolveActiveProject("7", 7 as unknown as string, [{ id: "3", }])).toBe("3")
  })
})

/// The same answer, as the PROJECT rather than its id, for the display
/// components that hold only an id: `app-sidebar.tsx` and `team-switcher.tsx`
/// each carried their own `projects.find(...) ?? projects[0]` — a third and
/// fourth, differently-shaped answer to this one question. Two of them were
/// inert only because App hands them an already-resolved id, which is exactly
/// how the next person reintroduces the bug somewhere nobody is looking.
describe("findActiveProject", () => {
  const projects = [{ id: "7", name: "seven" }, { id: "3", name: "three" }, { id: "11", name: "eleven" }]

  // Fails if the answer comes from the list's ORDER rather than from the id: the
  // objected returned for "11" must be the "11" row, not the first row.
  it("returns the project the id names, not the first row", () => {
    expect(findActiveProject("11", null, projects)?.id).toBe("11")
  })

  // The components pass App's `activeProject?.id ?? ""`, so "" must behave as
  // "no preference" and land on the same row their own fallback chose — this
  // change is a shape change, not a behaviour change.
  it("treats an empty id as no preference, as the call sites do", () => {
    expect(findActiveProject("", null, projects)?.id).toBe("7")
  })

  // Fails if this ever grows a precedence of its own instead of delegating: a
  // persisted choice that survives must beat the first row here too.
  it("answers with the same precedence as resolveActiveProject", () => {
    expect(findActiveProject("404", "3", projects)?.id).toBe("3")
    expect(findActiveProject(null, "404", projects)?.id).toBe("7")
  })

  // Fails if the empty case returns `projects[0]` (undefined at runtime while
  // typed as a project) or invents a row. The callers render their own empty
  // state for null — team-switcher's "New project" button.
  it("returns null for an empty list", () => {
    expect(findActiveProject("", null, [])).toBeNull()
    expect(findActiveProject("7", "3", [])).toBeNull()
  })
})
