/// Which project is active — the ONE answer, for both callers.
///
/// Extracted because the question was being answered twice with different
/// fallbacks: the loader in App.tsx compared a preferred id against a freshly
/// fetched list and fell back to `nextProjects[0]`, while the render path
/// independently fell back to `workspaceProjects[0]`. Both answers were
/// POSITIONAL, on a list ordered server-side (`orderBy("name", "id")`), so a
/// missing preferred id silently moved the active project to whichever project
/// happened to sort first. The user's report: "different projects try to take
/// that spot".
///
/// Pure and dependency-free on purpose: it is the one piece of this that can be
/// held still in a test, so the choice is proved here and merely *used* in
/// App.tsx.

/// Precedence: the project the caller is asking for, then the project the USER
/// last chose (site config, see lib/site-config), then the first row as a last
/// resort.
///
/// `persisted` is honoured only while it is still in the list: a stored id can
/// outlive the project it names (removed, archived away, or simply not in the
/// newest page), and returning it would point the workspace fetch at a project
/// this user can no longer read.
///
/// Every comparison is strict `===` against ids that are all STRINGS — see
/// `Project.id` in lib/workspace-view and the `String(project.id)` cast in
/// mapLiveProjects. A number slipping in on either side would simply never match
/// and would look identical to "the user has no preference".
export function resolveActiveProject(
  preferred: string | null,
  persisted: string | null,
  projects: { id: string }[]
): string | null {
  // An empty list is a real, honest state (a first-time user, or one whose
  // invites have all gone). `null` is what App.tsx renders the empty state for —
  // inventing an id here, or throwing on `projects[0].id`, would be worse than
  // saying there is no project.
  if (!projects.length) return null
  if (preferred && projects.some((project) => project.id === preferred)) return preferred
  if (persisted && projects.some((project) => project.id === persisted)) return persisted
  return projects[0].id
}
