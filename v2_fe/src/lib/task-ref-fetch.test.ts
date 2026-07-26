import { describe, expect, it } from "vitest"

import { fetchTaskRef, type TaskRefDeps } from "./task-ref-fetch"
import type { TaskRefRow } from "./task-ref-state"

/// A server row. Cast rather than spelled out in full: these tests are about
/// what `fetchTaskRef` does with the answer, not about the row's 20 columns.
function row(id: number, project = 3): TaskRefRow {
  return { id, project, title: "t" } as TaskRefRow
}

function deps(overrides: Partial<TaskRefDeps> = {}): TaskRefDeps {
  return {
    getTask: async (id: number) => row(id),
    getProject: async () => ({ name: "ETHSafari" }),
    isDenial: () => false,
    ...overrides,
  }
}

describe("fetchTaskRef", () => {
  it("asks the server and reports what it returned", async () => {
    const asked: number[] = []
    const answer = await fetchTaskRef(
      "64",
      deps({
        getTask: async (id) => {
          asked.push(id)
          return row(id)
        },
      }),
    )

    expect(asked).toEqual([64])
    expect(answer).toEqual({
      status: "found",
      taskId: "64",
      projectId: "3",
      projectName: "ETHSafari",
      // The row travels with the answer so the sheet never needs the board.
      row: row(64),
    })
  })

  it("still reports the task when the project name lookup fails", async () => {
    // The name is cosmetic. Letting its failure sink the answer would put us
    // back to claiming a task is unavailable when the server just told us it is.
    const answer = await fetchTaskRef(
      "64",
      deps({
        getProject: async () => {
          throw new Error("nope")
        },
      }),
    )

    expect(answer).toMatchObject({ status: "found", taskId: "64", projectName: null })
  })

  it("reports a 404/403 as denied", async () => {
    const answer = await fetchTaskRef(
      "64",
      deps({
        getTask: async () => {
          throw new Error("Not Found")
        },
        isDenial: () => true,
      }),
    )

    expect(answer).toEqual({ status: "denied", taskId: "64" })
  })

  it("reports any other failure as an error, NOT as denied", async () => {
    // An offline browser, a 500, an expired session: none of them are evidence
    // that the task is missing, and the UI must be able to say so.
    const answer = await fetchTaskRef(
      "64",
      deps({
        getTask: async () => {
          throw new Error("Failed to fetch")
        },
        isDenial: () => false,
      }),
    )

    expect(answer).toEqual({ status: "error", taskId: "64", message: "Failed to fetch" })
  })

  it("rejects an id that is not a positive integer without calling the server", async () => {
    // `#0` and `#abc` can be written in prose. Asking the server about them
    // would answer 404 and read as "doesn't exist", which is true but wasteful.
    let called = false
    const answer = await fetchTaskRef(
      "0",
      deps({
        getTask: async (id) => {
          called = true
          return row(id)
        },
      }),
    )

    expect(called).toBe(false)
    expect(answer).toEqual({ status: "denied", taskId: "0" })
  })
})
