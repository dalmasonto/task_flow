# GitHub Mirror Affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the task activity section's "post to GitHub" controls always visible, disabled with a stated reason when unavailable, instead of silently rendering nothing.

**Architecture:** One pure resolver (`githubMirrorState`) maps `(GithubProjectStatus | null, issueNumber)` to a discriminated union of seven states. The three GitHub controls in `TaskDetailSheet` — section banner, per-row post button, composer checkbox — all read from it, replacing three independently-derived inline gates that each collapsed to `null`.

**Tech Stack:** React 19 + TypeScript, Vite, Vitest (node environment), Tailwind v4, shadcn-style `Button`, react-router-dom.

**Spec:** `docs/superpowers/specs/2026-07-23-github-activity-affordance-design.md`

## Global Constraints

- Frontend only. No backend, model, migration, or MCP tool changes.
- No new npm dependencies. Vitest runs `environment: 'node'` with `include: ['src/**/*.test.ts']` (`v2_fe/vite.config.ts:38-41`) — **`.tsx` files are not collected**, so component tests are out of scope by design. UI tasks verify via typecheck + lint + manual check.
- All commands run from `v2_fe/`.
- A disabled control must never create a GitHub issue as a side effect. Publishing stays a separate, deliberate action.
- Reason strings use curly quotes (`“post as me”`) to match existing copy at `App.tsx:5152` and `App.tsx:5194`.
- **All `App.tsx` line numbers in this plan refer to the file as it stands at commit `5b3e735`, before any task is applied.** Tasks 2–4 insert and delete lines in the same file, so later line numbers drift. Locate each edit site by the quoted surrounding code, not by line number alone.
- **State precedence is fixed and is a correctness requirement, not a style choice:** `unknown → not_linked → unpublished → not_connected → not_permitted → auto → ready`. `auto` ranks *after* the connect gates because `mirror_comment` (`backend/plugins/taskflow-github/src/mirror.rs:76-79`) posts under the acting user's own key and returns `NeedsConnect` with no fallback. Ranking `auto` earlier would display "Mirrored automatically" while the backend posts nothing.

---

### Task 1: The `githubMirrorState` resolver

**Files:**
- Create: `v2_fe/src/lib/github-mirror-state.ts`
- Test: `v2_fe/src/lib/github-mirror-state.test.ts`

**Interfaces:**
- Consumes: `GithubProjectStatus` from `v2_fe/src/lib/taskflow-api.ts:1165-1172` — fields `user_connected`, `project_linked`, `github_repo`, `can_publish`, `post_as_me`, `auto_mirror`, all non-optional.
- Produces: `GithubMirrorState` (union type) and `githubMirrorState(status, issueNumber)`. Tasks 2–4 import both from `@/lib/github-mirror-state`.

- [ ] **Step 1: Write the failing test**

Create `v2_fe/src/lib/github-mirror-state.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd v2_fe && npx vitest run src/lib/github-mirror-state.test.ts`
Expected: FAIL — `Failed to resolve import "./github-mirror-state"`.

- [ ] **Step 3: Write the implementation**

Create `v2_fe/src/lib/github-mirror-state.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd v2_fe && npx vitest run src/lib/github-mirror-state.test.ts`
Expected: PASS — 10 tests passed.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd v2_fe && npm run test && npx tsc -b`
Expected: all test files pass; `tsc -b` exits 0 with no output.

Note: `src/lib/message-store.test.ts` and `src/lib/github-api.test.ts` must still pass. If `message-store.test.ts` was already failing before this task, leave it — do not fix unrelated failures here.

- [ ] **Step 6: Commit**

```bash
git add v2_fe/src/lib/github-mirror-state.ts v2_fe/src/lib/github-mirror-state.test.ts
git commit -m "feat(#25): githubMirrorState — one resolver for the GitHub mirror gates"
```

---

### Task 2: Per-activity-row post button

**Files:**
- Modify: `v2_fe/src/App.tsx` — import block (~line 166), `TaskDetailSheet` body (~line 4699), activity row render (`5183-5219`)

**Interfaces:**
- Consumes: `githubMirrorState`, `githubMirrorReason`, `GithubMirrorState` from Task 1.
- Produces: `mirrorState` and `mirrorReason` consts inside `TaskDetailSheet`, used by Tasks 3 and 4.

- [ ] **Step 1: Add the import**

In `v2_fe/src/App.tsx`, beside the existing `@/lib/activity-filter` import (~line 166), add:

```tsx
import { githubMirrorState, githubMirrorReason } from "@/lib/github-mirror-state"
```

- [ ] **Step 2: Derive the state once in `TaskDetailSheet`**

Immediately after the `canCommentAsMe` line (`App.tsx:4718`), add:

```tsx
  // #25: one resolver drives the banner, the per-row button, and the composer
  // checkbox — so a blocked gate is stated once instead of silently hiding three
  // different controls.
  const mirrorState = githubMirrorState(ghStatus, issueNumber)
  const mirrorReason = githubMirrorReason(mirrorState)
```

Leave `canCommentAsMe` in place — `submitComment` (`App.tsx:4740`) still uses it and Task 4 revisits it.

- [ ] **Step 3: Replace the per-row control**

Replace the whole `{issueNumber ? ( … ) : null}` block at `App.tsx:5183-5219` with:

```tsx
                            {mirrorState.kind === "unknown" ? null : mirrorState.kind === "auto" ? (
                              <span className="ml-auto text-muted-foreground/80">Mirrored automatically</span>
                            ) : postedActivityIds.has(String(event.id)) ? (
                              <span className="ml-auto text-emerald-600 dark:text-emerald-400">Posted to issue</span>
                            ) : (
                              <Button
                                size="xs"
                                variant="outline"
                                className="ml-auto"
                                disabled={mirrorState.kind !== "ready" || postingActivityId === String(event.id)}
                                title={
                                  mirrorReason ?? `Post this to GitHub issue #${issueNumber} as you`
                                }
                                onClick={async () => {
                                  const projectId = liveId(project.id)
                                  const taskId = liveId(task.id)
                                  if (projectId === null || taskId === null) return
                                  setPostingActivityId(String(event.id))
                                  setGhActionError(null)
                                  try {
                                    await commentOnIssueAsMe(projectId, taskId, event.detail)
                                    setPostedActivityIds((prev) => new Set(prev).add(String(event.id)))
                                  } catch (error) {
                                    setGhActionError(
                                      error instanceof GithubNeedsConnectError
                                        ? "Connect GitHub and enable “post as me”."
                                        : (error as Error).message,
                                    )
                                  } finally {
                                    setPostingActivityId(null)
                                  }
                                }}
                              >
                                <GitBranchIcon className="size-3.5" />
                                {postingActivityId === String(event.id)
                                  ? "Posting…"
                                  : issueNumber
                                    ? `Post to #${issueNumber}`
                                    : "Post to issue"}
                              </Button>
                            )}
```

`ml-auto` pushes the button to the row's right edge, out of the `actor · action · time` run. `GitBranchIcon` and `Button` are already imported in this file (used at `App.tsx:4808` and `App.tsx:4812`).

- [ ] **Step 4: Typecheck and lint**

Run: `cd v2_fe && npx tsc -b && npm run lint`
Expected: both exit 0. `tsc` proves the union is narrowed correctly — if `mirrorState.reason` were accessed without narrowing it would error here.

- [ ] **Step 5: Verify in the running app**

Run: `cd v2_fe && npm run dev`
Open task 25 (project "TaskFlow v2", which is linked but unpublished). In the Activity section, expect an outlined **"Post to issue"** button on every row, disabled, tooltip *"Publish this task as an issue to mirror its activity to GitHub."*
Before this change the same rows showed nothing at all.

- [ ] **Step 6: Commit**

```bash
git add v2_fe/src/App.tsx
git commit -m "fix(#25): activity rows always show the post-to-issue button, disabled with a reason"
```

---

### Task 3: Activity section banner + extracted publish handler

**Files:**
- Modify: `v2_fe/src/App.tsx` — import block (~line 108-130), `TaskDetailSheet` handlers (~line 4758), header publish button (`4811-4840`), activity section body (~line 5172)

**Interfaces:**
- Consumes: `mirrorState`, `mirrorReason` from Task 2; `publishTaskAsIssue`, `GithubNeedsConnectError` already imported.
- Produces: `handlePublish: () => Promise<void>` inside `TaskDetailSheet`, shared by the header chip and the banner.

- [ ] **Step 1: Import `githubConnectUrl`**

`githubConnectUrl` is exported from `taskflow-api` but not yet imported into `App.tsx`. Add it to the existing `@/lib/taskflow-api` import list (the block containing `publishTaskAsIssue` at `App.tsx:123`):

```tsx
  githubConnectUrl,
```

- [ ] **Step 2: Extract the publish handler**

Insert directly after `submitComment` closes (`App.tsx:4758`):

```tsx
  // Shared by the header chip and the activity banner, so "publish" behaves
  // identically wherever it is offered.
  const handlePublish = async () => {
    const projectId = liveId(project.id)
    const taskId = liveId(task.id)
    if (projectId === null || taskId === null) return
    setPublishing(true)
    setGhActionError(null)
    try {
      const result = await publishTaskAsIssue(projectId, taskId)
      setLocalIssue({ number: result.issue_number, url: result.issue_url })
    } catch (error) {
      setGhActionError(
        error instanceof GithubNeedsConnectError
          ? "Connect GitHub to publish."
          : (error as Error).message,
      )
    } finally {
      setPublishing(false)
    }
  }
```

- [ ] **Step 3: Point the header chip at the handler**

In the header publish `<Button>` (`App.tsx:4812-4839`), replace the entire inline `onClick={async () => { … }}` with:

```tsx
                    onClick={() => void handlePublish()}
```

Leave `size`, `variant`, `disabled`, `title`, and the button's children unchanged.

- [ ] **Step 4: Add the banner**

The banner goes at the **top of the Activity section** — above the comment composer, so it also explains the composer's disabled checkbox rather than appearing below it.

Insert as the first child of the activity `TaskDetailSection`: after the `>` that closes the opening `<TaskDetailSection … title="Activity">` tag (`App.tsx:5116` pre-edit) and before the composer's `<div className="mb-3 rounded-lg border bg-background p-2 shadow-sm">` (`App.tsx:5117` pre-edit):

```tsx
                {mirrorReason ? (
                  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <GitBranchIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0">{mirrorReason}</span>
                    {mirrorState.kind === "unpublished" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={publishing || !ghStatus?.can_publish}
                        title={
                          ghStatus?.can_publish
                            ? "Open a GitHub issue for this task"
                            : "Link GitHub and connect the owner account first"
                        }
                        onClick={() => void handlePublish()}
                      >
                        {publishing ? "Publishing…" : "Publish as issue"}
                      </Button>
                    ) : mirrorState.kind === "not_connected" ? (
                      <a
                        className="underline underline-offset-2 hover:text-primary"
                        href={githubConnectUrl("/dashboard/board")}
                      >
                        Connect GitHub
                      </a>
                    ) : (
                      <Link to="/dashboard/api" className="underline underline-offset-2 hover:text-primary">
                        Project GitHub settings
                      </Link>
                    )}
                  </div>
                ) : null}
```

`Link` is already imported (`App.tsx:2`). The final branch covers `not_linked` and `not_permitted`, both of which are fixed on the project settings page (`/dashboard/api`, where `ApiBasePage` renders at `App.tsx:8691`).

- [ ] **Step 5: Typecheck and lint**

Run: `cd v2_fe && npx tsc -b && npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Verify in the running app**

Run: `cd v2_fe && npm run dev`
On task 25, the Activity section should now open with a dashed banner reading *"Publish this task as an issue to mirror its activity to GitHub."* plus a working **Publish as issue** button. Clicking it publishes once, the banner disappears, and the per-row buttons from Task 2 become enabled (assuming the account is connected with `post_as_me` on).

- [ ] **Step 7: Commit**

```bash
git add v2_fe/src/App.tsx
git commit -m "feat(#25): activity section states why GitHub mirroring is blocked, with the fix action"
```

---

### Task 4: Composer checkbox reads the resolver

**Files:**
- Modify: `v2_fe/src/App.tsx` — composer checkbox (`5141-5165`)

**Interfaces:**
- Consumes: `mirrorState`, `mirrorReason` from Task 2.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the checkbox block**

Replace the whole `{issueNumber ? ( <label …> … </label> ) : null}` block at `App.tsx:5141-5165` with:

```tsx
                      {mirrorState.kind === "unknown" ? null : (
                        <label
                          className={cn(
                            "flex items-center gap-1.5 text-[11px]",
                            mirrorState.kind === "ready" || mirrorState.kind === "auto"
                              ? "text-muted-foreground"
                              : "text-muted-foreground/60",
                          )}
                          title={
                            mirrorReason ??
                            (mirrorState.kind === "auto"
                              ? "Auto-mirror is on for this project — comments post to the issue automatically"
                              : `Also post this comment to GitHub issue #${issueNumber} as you`)
                          }
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-primary"
                            checked={mirrorState.kind === "auto" || (alsoPostToGithub && mirrorState.kind === "ready")}
                            disabled={mirrorState.kind !== "ready"}
                            onChange={(event) => setAlsoPostToGithub(event.target.checked)}
                          />
                          {issueNumber ? `Post to issue #${issueNumber}` : "Post to issue"}
                          {mirrorState.kind === "auto" ? " (auto)" : ""}
                        </label>
                      )}
```

Behaviour preserved from the original: `auto` renders checked-and-disabled, `ready` respects the user's toggle, everything else is unchecked and disabled — but now visible with a stated reason instead of absent.

- [ ] **Step 2: Confirm `submitComment` still gates correctly**

Read `App.tsx:4740`. It must remain:

```tsx
      if ((alsoPostToGithub || Boolean(ghStatus?.auto_mirror)) && canCommentAsMe) {
```

This is already correct — `canCommentAsMe` is required in both branches, so an unconnected user never triggers a mirror attempt regardless of `auto_mirror`. Make no change. Do not delete `canCommentAsMe`; it is still this line's guard.

- [ ] **Step 3: Typecheck and lint**

Run: `cd v2_fe && npx tsc -b && npm run lint`
Expected: both exit 0.

- [ ] **Step 4: Run the full test suite**

Run: `cd v2_fe && npm run test`
Expected: `github-mirror-state.test.ts` and `github-api.test.ts` pass. No new failures versus the Task 1 baseline.

- [ ] **Step 5: Verify in the running app**

Run: `cd v2_fe && npm run dev`
On an unpublished task, the comment composer shows a greyed **"Post to issue"** checkbox, disabled, tooltip *"Publish this task as an issue to mirror its activity to GitHub."* Submitting a comment still works and still records the activity item.

- [ ] **Step 6: Commit**

```bash
git add v2_fe/src/App.tsx
git commit -m "fix(#25): comment composer shows the post-to-issue toggle with its blocking reason"
```

---

## Manual verification matrix

After Task 4, walk the states by editing `backend/backend.db` between checks (project 2 is linked; project 1 "Umbral" is not):

| State | How to reach it | Expected |
|---|---|---|
| `not_linked` | open any task in project 1 "Umbral" | banner → "Link a GitHub repo…", link to project settings; buttons disabled |
| `unpublished` | task 25 in project 2 | banner → "Publish this task as an issue…" + working Publish button |
| `not_connected` | disconnect GitHub in `/account/settings` | banner → "Connect your GitHub account…" + connect link |
| `not_permitted` | turn off "post as me" in `/dashboard/api` | banner → "Enable “post as me”…" + settings link |
| `auto` | turn on auto-mirror in `/dashboard/api` | no banner; rows read "Mirrored automatically"; checkbox checked + disabled |
| `ready` | task 53 (issue #1) with account connected | no banner; enabled "Post to #1" buttons |
| `unknown` | stop the backend, reload | no GitHub controls at all — same as today |
