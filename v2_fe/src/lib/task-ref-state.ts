/// #49: what a `TASK#<n>` chip should show when it is clicked.
///
/// This used to resolve against the in-memory task list, on the stated
/// assumption that the list held every task the user could see. It did not, and
/// a miss was reported as "Task #N doesn't exist, or you don't have access to
/// it" — about tasks that plainly existed. The cache could be short for at
/// least four independent reasons:
///
///   * the realtime handler is scoped to the subscribed project
///     (`if (task.project !== projectId) return`), so a task created anywhere
///     else never arrived;
///   * the summary fetch asks for ONE page (`page_size=100`) and keeps
///     `.results`, so the tail is dropped once a workspace passes 100 tasks;
///   * `workspaceLoaded` was `usesLiveApi || tasks.length > 0`, so a live-but-
///     empty cache answered "doesn't exist" instead of "still loading";
///   * `mergeProjectTasks` replaces a project's slice wholesale, so a failed
///     refetch leaves a hole.
///
/// So existence and access are no longer decided here at all. The caller asks
/// the SERVER about the id and passes the answer in; this module only maps that
/// answer onto what the UI should show. A local cache can be stale; the server
/// is the only thing that knows.

/// What the server said about the id.
export type TaskRefAnswer =
  /// The request is in flight.
  | { status: "loading" }
  /// The server returned the task. `projectName` is a second, best-effort
  /// lookup and may be null without invalidating the answer.
  | { status: "found"; taskId: string; projectId: string; projectName: string | null }
  /// The server refused: 404 or 403. It deliberately does not distinguish
  /// "no such row" from "not yours", so ids cannot be probed for existence —
  /// see `isScopeDenial` in taskflow-api.
  | { status: "denied"; taskId: string }
  /// The question could not be put to the server at all (offline, 5xx, an
  /// expired session). NOT evidence of absence.
  | { status: "error"; taskId: string; message: string }

export type TaskRefState =
  | { kind: "loading" }
  | { kind: "ready"; taskId: string }
  /// Visible to the user, but under a different project — opening it against the
  /// active project would show it with the wrong header, members and relations.
  | { kind: "other_project"; taskId: string; projectId: string; projectName: string }
  | { kind: "unavailable"; taskId: string; reason: string }

export function taskRefState(
  answer: TaskRefAnswer,
  activeProjectId: string | null,
): TaskRefState {
  switch (answer.status) {
    case "loading":
      return { kind: "loading" }

    case "found":
      // A null `activeProjectId` must not read as a match: "no active project"
      // is not "the same project", and treating it as one would open the task
      // under a header that describes nothing.
      if (activeProjectId !== null && answer.projectId === activeProjectId) {
        return { kind: "ready", taskId: answer.taskId }
      }
      return {
        kind: "other_project",
        taskId: answer.taskId,
        projectId: answer.projectId,
        // The name is a separate request and can fail on its own. Falling back
        // to the id keeps a good answer usable instead of discarding it.
        projectName: answer.projectName ?? `project #${answer.projectId}`,
      }

    case "denied":
      return {
        kind: "unavailable",
        taskId: answer.taskId,
        reason: `Task #${answer.taskId} doesn't exist, or you don't have access to it.`,
      }

    case "error":
      // Deliberately NOT the sentence above. "Doesn't exist" is a claim about
      // the world; this is a claim about the connection. Conflating them is what
      // sent people looking for tasks that were sitting right there.
      return {
        kind: "unavailable",
        taskId: answer.taskId,
        reason: `Couldn't check task #${answer.taskId}: ${answer.message}. It may still be there — try again.`,
      }
  }
}
