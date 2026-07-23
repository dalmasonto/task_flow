/// #49: what a `TASK#<n>` chip should show when it is clicked.
///
/// Before this existed, `App.tsx` did `tasks.find(t => t.id === openTaskId)` and
/// rendered `{openTask && activeProject ? <TaskDetailSheet/> : null}`. A miss
/// rendered nothing at all, so a typo'd id, a task in another project, and a
/// still-loading workspace were all indistinguishable from a broken button.

export type TaskRefLookup = {
  /// Every task the signed-in user can see. This is the whole set, not a page:
  /// the backend never calls `.paginate(...)`, so umbral-rest's `NoPagination`
  /// default returns all rows. That is what makes a local miss trustworthy
  /// enough to report as "unavailable" without a server round-trip.
  tasks: { id: string; projectId: string }[]
  projects: { id: string; name: string }[]
  activeProjectId: string | null
  /// False until the first workspace fetch resolves.
  workspaceLoaded: boolean
}

export type TaskRefState =
  | { kind: "loading" }
  | { kind: "ready"; taskId: string }
  /// Visible to the user, but under a different project — opening it against the
  /// active project would show it with the wrong header, members and relations.
  | { kind: "other_project"; taskId: string; projectId: string; projectName: string }
  | { kind: "unavailable"; taskId: string; reason: string }

export function taskRefState(taskId: string, lookup: TaskRefLookup): TaskRefState {
  const task = lookup.tasks.find((candidate) => candidate.id === taskId)

  if (!task) {
    // Every id looks missing before the workspace arrives; saying "no such task"
    // then would be a lie that corrects itself a second later.
    if (!lookup.workspaceLoaded) return { kind: "loading" }
    // The API 404s an out-of-scope row rather than 403ing it, deliberately, so
    // that ids cannot be probed for existence. The UI must not invent a
    // distinction the server refuses to make — so this names both possibilities
    // instead of asserting either.
    return {
      kind: "unavailable",
      taskId,
      reason: `Task #${taskId} doesn't exist, or you don't have access to it.`,
    }
  }

  if (task.projectId === lookup.activeProjectId) return { kind: "ready", taskId }

  return {
    kind: "other_project",
    taskId,
    projectId: task.projectId,
    projectName:
      lookup.projects.find((project) => project.id === task.projectId)?.name ?? "another project",
  }
}
