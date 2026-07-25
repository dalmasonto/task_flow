import { describe, it, expect } from "vitest"

import { taskRefState } from "./task-ref-state"

describe("taskRefState", () => {
  it("shows loading while the server is still being asked", () => {
    expect(taskRefState({ status: "loading" }, "3")).toEqual({ kind: "loading" })
  })

  it("opens a task the server placed in the active project", () => {
    expect(
      taskRefState(
        { status: "found", taskId: "64", projectId: "3", projectName: "ETHSafari" },
        "3",
      ),
    ).toEqual({ kind: "ready", taskId: "64" })
  })

  it("offers to switch when the server places it in another project", () => {
    expect(
      taskRefState(
        { status: "found", taskId: "12", projectId: "2", projectName: "TaskFlow v2" },
        "3",
      ),
    ).toEqual({
      kind: "other_project",
      taskId: "12",
      projectId: "2",
      projectName: "TaskFlow v2",
    })
  })

  it("names the project by id when the server would not give a name", () => {
    // The name is a second request and may fail on its own. Losing it must not
    // downgrade a perfectly good answer into "doesn't exist".
    const state = taskRefState(
      { status: "found", taskId: "12", projectId: "2", projectName: null },
      "3",
    )
    expect(state).toMatchObject({ kind: "other_project", projectId: "2" })
    expect((state as { projectName: string }).projectName).toContain("2")
  })

  it("reports a server refusal as missing-or-forbidden, without inventing which", () => {
    // The API answers 404 for a row outside the caller's scope rather than 403,
    // deliberately, so ids cannot be probed for existence. The UI must not
    // invent a distinction the server refuses to make.
    expect(taskRefState({ status: "denied", taskId: "64" }, "3")).toEqual({
      kind: "unavailable",
      taskId: "64",
      reason: "Task #64 doesn't exist, or you don't have access to it.",
    })
  })

  it("does NOT claim a task is missing when the check itself failed", () => {
    // The whole bug this replaced: a local cache miss was reported as "doesn't
    // exist". An unreachable server is not evidence of absence, and saying so
    // sends the user looking for a task that is sitting right there.
    const state = taskRefState(
      { status: "error", taskId: "64", message: "Failed to fetch" },
      "3",
    )
    expect(state.kind).toBe("unavailable")
    const reason = (state as { reason: string }).reason
    expect(reason).not.toContain("doesn't exist")
    expect(reason).toContain("64")
    expect(reason).toContain("Failed to fetch")
  })

  it("treats a task as in-project only when the ids actually match", () => {
    // No active project (still booting, or the user has none) cannot silently
    // read as "same project".
    expect(
      taskRefState(
        { status: "found", taskId: "64", projectId: "3", projectName: "ETHSafari" },
        null,
      ).kind,
    ).toBe("other_project")
  })
})
