/// #25: whether this task's activity can be mirrored to its GitHub issue, and
/// if not, which gate is blocking it.
///
/// Every GitHub control in the task sheet reads from here. Before this existed
/// each control re-derived its own gate inline and rendered `null` when the gate
/// failed, which made "unavailable to you right now" indistinguishable from
/// "never built" — the review complaint that motivated the change.

import type { GithubProjectStatus } from "@/lib/taskflow-api"

export type GithubMirrorState =
  /// Status not loaded, or the request failed. Render nothing rather than
  /// asserting something false about the project.
  | { kind: "unknown" }
  | { kind: "not_linked"; reason: string }
  | { kind: "unpublished"; reason: string }
  | { kind: "not_connected"; reason: string }
  | { kind: "not_permitted"; reason: string }
  /// The project mirrors comments automatically — there is nothing to click.
  | { kind: "auto" }
  | { kind: "ready" }

export function githubMirrorState(
  status: GithubProjectStatus | null,
  issueNumber: number | null,
): GithubMirrorState {
  if (!status) return { kind: "unknown" }

  if (!status.project_linked) {
    return { kind: "not_linked", reason: "Link a GitHub repo in this project's settings to mirror activity." }
  }
  if (issueNumber === null) {
    return { kind: "unpublished", reason: "Publish this task as an issue to mirror its activity to GitHub." }
  }
  // The connect gates outrank auto_mirror: mirror_comment posts under the acting
  // user's own key and returns NeedsConnect rather than falling back to the
  // linking owner's, so auto-mirror does nothing for a user who isn't connected.
  if (!status.user_connected) {
    return { kind: "not_connected", reason: "Connect your GitHub account to post as you." }
  }
  if (!status.post_as_me) {
    return { kind: "not_permitted", reason: "Enable “post as me” in this project's GitHub settings." }
  }

  if (status.auto_mirror) return { kind: "auto" }
  return { kind: "ready" }
}

/// The blocking reason, or null when nothing is blocked. Consumers use this to
/// avoid narrowing the union at every call site.
export function githubMirrorReason(state: GithubMirrorState): string | null {
  return "reason" in state ? state.reason : null
}
