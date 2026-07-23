import { describe, it, expect } from "vitest"
import { taskRefState } from "./task-ref-state"
import type { TaskRefLookup } from "./task-ref-state"

/// The resolver only needs id + projectId off a task, and id + name off a
/// project — deliberately narrow so it does not drag App.tsx's wide `Task` type
/// (and its 20-odd display fields) into a unit test.
const TASKS: TaskRefLookup["tasks"] = [
  { id: "7", projectId: "p2" },
  { id: "53", projectId: "p2" },
  { id: "91", projectId: "p1" },
]

const PROJECTS: TaskRefLookup["projects"] = [
  { id: "p1", name: "Umbral" },
  { id: "p2", name: "TaskFlow v2" },
]

function lookup(overrides: Partial<TaskRefLookup> = {}): TaskRefLookup {
  return {
    tasks: TASKS,
    projects: PROJECTS,
    activeProjectId: "p2",
    workspaceLoaded: true,
    ...overrides,
  }
}

describe("taskRefState", () => {
  it("resolves a task in the active project", () => {
    const state = taskRefState("53", lookup())
    expect(state.kind).toBe("ready")
    expect(state.kind === "ready" && state.taskId).toBe("53")
  })

  // Not an error: the user can see this task, it just lives elsewhere. Opening
  // it against the active project would render another project's task under
  // this project's header, members, and relations.
  it("reports a task that belongs to another project the user can see", () => {
    const state = taskRefState("91", lookup())
    expect(state.kind).toBe("other_project")
    expect(state.kind === "other_project" && state.projectId).toBe("p1")
    expect(state.kind === "other_project" && state.projectName).toBe("Umbral")
  })

  // #49: the reported bug. `#1000` used to resolve to undefined and render
  // nothing at all, so a typo was indistinguishable from a broken app.
  it("reports an unknown id as unavailable rather than resolving to nothing", () => {
    const state = taskRefState("1000", lookup())
    expect(state.kind).toBe("unavailable")
  })

  // The API 404s an out-of-scope row rather than 403ing it, precisely so it does
  // not leak which ids exist. The UI must not invent a distinction the server
  // deliberately refuses to make.
  it("does not claim an unavailable task definitely does not exist", () => {
    const state = taskRefState("1000", lookup())
    const reason = state.kind === "unavailable" ? state.reason : ""
    expect(reason.length).toBeGreaterThan(0)
    expect(reason).toMatch(/exist/i)
    expect(reason).toMatch(/access/i)
  })

  it("carries the requested id so the message can name it", () => {
    const state = taskRefState("1000", lookup())
    expect(state.kind === "unavailable" && state.taskId).toBe("1000")
  })

  // Before the workspace arrives every id looks missing. Claiming "no such task"
  // there would be a lie that resolves itself a moment later.
  it("is loading, not unavailable, before the workspace has loaded", () => {
    expect(taskRefState("53", lookup({ workspaceLoaded: false, tasks: [] })).kind).toBe("loading")
  })

  it("still resolves a known task once loaded, even with no active project", () => {
    const state = taskRefState("91", lookup({ activeProjectId: null }))
    expect(state.kind).toBe("other_project")
  })

  it("names an unknown project defensively rather than rendering undefined", () => {
    const state = taskRefState("91", lookup({ projects: [] }))
    expect(state.kind).toBe("other_project")
    expect(state.kind === "other_project" && state.projectName.length).toBeGreaterThan(0)
  })
})
