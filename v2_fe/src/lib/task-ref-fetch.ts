/// Asking the SERVER about a `TASK#<n>` reference.
///
/// Existence and access are the server's to answer, never a local cache's. See
/// task-ref-state.ts for the four ways the in-memory task list could be short —
/// each of which produced "Task #N doesn't exist, or you don't have access to
/// it" about a task that was sitting right there.
///
/// The two requests are injected so this can be tested without a network. The
/// defaults are the real client.

import { isScopeDenial, taskflowApi, taskflowTables } from "./taskflow-api"
import type { TaskRefAnswer, TaskRefRow } from "./task-ref-state"

export type TaskRefDeps = {
  /// Retrieve the task row. Must reject on 404/403 like the real client. The
  /// WHOLE row is kept: the sheet is rendered from it, so a task the local
  /// board has never seen still opens.
  getTask: (id: number) => Promise<TaskRefRow>
  /// Retrieve the task's project, for the display name only.
  getProject: (id: number) => Promise<{ name: string }>
  /// Whether a rejection means "the server refused" rather than "we could not
  /// ask". Deliberately excludes 401 so an expired session surfaces as an error
  /// rather than as a missing task.
  isDenial: (error: unknown) => boolean
}

const liveDeps: TaskRefDeps = {
  getTask: (id) => taskflowApi.get(taskflowTables.tasks, id) as Promise<TaskRefRow>,
  getProject: (id) => taskflowApi.get(taskflowTables.projects, id) as Promise<{ name: string }>,
  isDenial: isScopeDenial,
}

export async function fetchTaskRef(
  taskId: string,
  /// The project the user is already looking at. When the task turns out to be
  /// in it, the project name is never displayed, so the second request is
  /// skipped entirely — clicking a chip on your own board costs ONE request.
  activeProjectId: string | null = null,
  deps: TaskRefDeps = liveDeps,
): Promise<TaskRefAnswer> {
  const numeric = Number(taskId)
  // `#0` and `#abc` are writable in prose. The server would answer 404, which is
  // correct but a wasted round trip on something no id can ever match.
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { status: "denied", taskId }
  }

  let task: TaskRefRow
  try {
    task = await deps.getTask(numeric)
  } catch (error) {
    if (deps.isDenial(error)) return { status: "denied", taskId }
    return {
      status: "error",
      taskId,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const projectId = String(task.project)

  // Only when it is somewhere else — the name appears only in the "this is in
  // another project, switch?" notice. Fetching it for a task on the board the
  // user is already looking at is a request whose result is thrown away.
  let projectName: string | null = null
  if (projectId !== activeProjectId) {
    try {
      projectName = (await deps.getProject(task.project)).name
    } catch {
      // Cosmetic: its failure must not discard an answer the server gave us.
      projectName = null
    }
  }

  return { status: "found", taskId, projectId, projectName, row: task }
}
