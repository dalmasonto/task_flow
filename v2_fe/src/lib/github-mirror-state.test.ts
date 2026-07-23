import { describe, it, expect } from "vitest"
import { githubMirrorState } from "./github-mirror-state"
import type { GithubProjectStatus } from "./taskflow-api"

/// A fully-enabled status; each test knocks out the one field it cares about.
function status(overrides: Partial<GithubProjectStatus> = {}): GithubProjectStatus {
  return {
    user_connected: true,
    project_linked: true,
    github_repo: "acme/widgets",
    can_publish: true,
    post_as_me: true,
    auto_mirror: false,
    ...overrides,
  }
}

describe("githubMirrorState", () => {
  it("is unknown when the status has not loaded", () => {
    expect(githubMirrorState(null, 7)).toEqual({ kind: "unknown" })
  })

  it("is not_linked when the project has no repo", () => {
    const state = githubMirrorState(status({ project_linked: false }), null)
    expect(state.kind).toBe("not_linked")
  })

  it("is unpublished when the task has no issue yet", () => {
    const state = githubMirrorState(status(), null)
    expect(state.kind).toBe("unpublished")
  })

  it("is not_connected when the user has no github account", () => {
    const state = githubMirrorState(status({ user_connected: false }), 7)
    expect(state.kind).toBe("not_connected")
  })

  it("is not_permitted when the user has not opted into post as me", () => {
    const state = githubMirrorState(status({ post_as_me: false }), 7)
    expect(state.kind).toBe("not_permitted")
  })

  it("is auto when the project mirrors comments automatically", () => {
    expect(githubMirrorState(status({ auto_mirror: true }), 7)).toEqual({ kind: "auto" })
  })

  it("is ready when every gate is satisfied", () => {
    expect(githubMirrorState(status(), 7)).toEqual({ kind: "ready" })
  })

  it("every blocked state carries a non-empty reason", () => {
    const blocked = [
      githubMirrorState(status({ project_linked: false }), null),
      githubMirrorState(status(), null),
      githubMirrorState(status({ user_connected: false }), 7),
      githubMirrorState(status({ post_as_me: false }), 7),
    ]
    for (const state of blocked) {
      expect(state).toHaveProperty("reason")
      expect("reason" in state && state.reason.length).toBeGreaterThan(0)
    }
  })

  // The gates are not nested: auto_mirror can be on while the user is not
  // connected. mirror_comment posts under the acting user's own key and returns
  // NeedsConnect with no fallback, so the connect gates must win — otherwise the
  // UI claims "Mirrored automatically" while nothing is posted.
  it("reports the connect gate, not auto, when auto_mirror is on but the user is not connected", () => {
    const state = githubMirrorState(status({ auto_mirror: true, user_connected: false }), 7)
    expect(state.kind).toBe("not_connected")
  })

  it("reports the opt-in gate, not auto, when auto_mirror is on but post_as_me is off", () => {
    const state = githubMirrorState(status({ auto_mirror: true, post_as_me: false }), 7)
    expect(state.kind).toBe("not_permitted")
  })
})
