# GitHub mirror affordance in the task activity section

Date: 2026-07-23
Task: #25 — link a GitHub project, publish a task as an issue, mirror activity back
Branch: `feat/github-linking-25`

## Problem

Review feedback on #25: *"I don't see a button in the activity section to post to
github!"*

The button exists. It renders nothing.

`TaskDetailSheet` has three GitHub controls, each re-deriving its own gate inline
and each collapsing to `null` when that gate fails:

| Control | Location | Gate | When it fails |
|---|---|---|---|
| "Publish as issue" chip | `v2_fe/src/App.tsx:4811` | `ghStatus?.project_linked` | renders nothing |
| "Post to issue #N" checkbox | `v2_fe/src/App.tsx:5141` | `issueNumber` | renders nothing |
| Per-row "Post to issue" | `v2_fe/src/App.tsx:5183` | `issueNumber`, then `canCommentAsMe` | renders nothing / disabled |

Confirmed against the dev database: project 2 ("TaskFlow v2") is linked to
`dalmasonto/task_flow`, but task 25 has `github_issue_number = NULL`. Only task 53
has ever been published. So on task 25 the reviewer saw the publish chip in the
header, scrolled to Activity, and found no GitHub control of any kind — with
nothing on screen explaining that publishing is the prerequisite.

Two defects, one root cause:

1. **Silent gating.** `{issueNumber ? … : null}` makes "unavailable to you right
   now" indistinguishable from "never built".
2. **Weak affordance.** Even when eligible, the per-row control is a bare
   `<button>` with `text-muted-foreground`, inline between `commented` and the
   timestamp. It reads as metadata, not an action.

Fixing this row-by-row would leave the duplicated gate logic that produced it.

## Design

### 1. One pure resolver

New file `v2_fe/src/lib/github-mirror-state.ts`. All three consumers read from it
instead of re-deriving booleans.

```ts
import type { GithubProjectStatus } from "@/lib/taskflow-api"

export type GithubMirrorState =
  | { kind: "unknown" }
  | { kind: "not_linked"; reason: string }
  | { kind: "unpublished"; reason: string }
  | { kind: "not_connected"; reason: string }
  | { kind: "not_permitted"; reason: string }
  | { kind: "auto" }
  | { kind: "ready" }

export function githubMirrorState(
  status: GithubProjectStatus | null,
  issueNumber: number | null,
): GithubMirrorState
```

State meanings and the UI each drives:

| `kind` | Condition | Per-row control | Section banner |
|---|---|---|---|
| `unknown` | status not loaded, or the fetch failed | render nothing | none |
| `not_linked` | `!status.project_linked` | disabled | "Link a GitHub repo in project settings" |
| `unpublished` | linked, `issueNumber === null` | disabled | "Not on GitHub yet — Publish as issue to mirror activity" |
| `not_connected` | issue exists, `!status.user_connected` | disabled | "Connect your GitHub account" |
| `not_permitted` | connected, `!status.post_as_me` | disabled | "Enable 'post as me' in the project's GitHub settings" |
| `auto` | `status.auto_mirror` on | "Mirrored automatically" label | none |
| `ready` | everything satisfied | enabled | none |

`unknown` is load-bearing. `fetchGithubProjectStatus` catches to `null`
(`App.tsx:4709`), so without a distinct state a failed request would render as
"not linked" — presenting a network failure as a fact about the project.

The discriminated union rather than booleans means every consumer must handle
every case, and the "why not?" string lives with the state instead of being
re-invented as a tooltip literal at each call site.

**Priority ordering is a product decision, deferred to the author of the function
body.** The gates are not strictly nested — for example `auto_mirror` can be on
while the user is not connected, and the design must decide which message wins.
The signature, union, and tests are scaffolded; the body is written separately.

### 2. Activity section banner

When `kind` is `not_linked`, `unpublished`, `not_connected`, or `not_permitted`,
render one line at the top of the Activity section carrying the reason and, where
one exists, the action that fixes it:

- `unpublished` → reuses the existing publish handler (currently inline at
  `App.tsx:4817`; extracted so both call sites share it)
- `not_linked` / `not_permitted` → link to the project's GitHub settings
- `not_connected` → the existing connect flow

Explained once per section rather than repeated on every row.

### 3. Per-row control

Always rendered (except `unknown` and `auto`) as:

```tsx
<Button size="xs" variant="outline" disabled={state.kind !== "ready"} title={reason}>
  <GitBranchIcon className="size-3.5" />
  Post to #{issueNumber}
</Button>
```

Right-aligned, out of the `actor · action · time` metadata run. On `auto`, a muted
"Mirrored automatically" label instead — there is nothing to click.

Posting behaviour is unchanged: `commentOnIssueAsMe`, optimistic
`postedActivityIds` tracking, `GithubNeedsConnectError` handling.

### 4. Composer checkbox

Same treatment, and the same `unknown` exception: rendered for every state except
`unknown`, disabled with the state's reason as its `title`, instead of vanishing
whenever `issueNumber` is null. On `auto` it stays visible but checked-and-disabled,
which is what it already does today (`App.tsx:5159`).

## Explicit non-goals

- No change to publish-as-issue behaviour. A disabled control never creates a
  GitHub issue as a side effect; publishing stays a deliberate, separate action.
- No change to any backend endpoint, model, or MCP tool.
- No change to auto-mirror semantics.
- No refactoring of `App.tsx` beyond extracting the resolver and the publish
  handler needed by the banner.

## Error handling

Unchanged. Action failures set `ghActionError` and surface under the header.
`GithubNeedsConnectError` keeps its dedicated copy. The resolver is pure and
cannot throw; a failed status fetch yields `unknown`, which renders nothing —
matching today's behaviour rather than asserting something false.

## Testing

`v2_fe/src/lib/github-mirror-state.test.ts` covers all seven states, including:

- `null` status → `unknown`
- linked + published + connected + `post_as_me` → `ready`
- `auto_mirror` on → `auto`
- each blocked state resolves to its own `kind` and a non-empty `reason`

The resolver is pure, so these run without mounting a 9,945-line component. That
testability is the reason it lives in `lib/` rather than inline in `App.tsx`.

## Files touched

| File | Change |
|---|---|
| `v2_fe/src/lib/github-mirror-state.ts` | new — resolver + state union |
| `v2_fe/src/lib/github-mirror-state.test.ts` | new — seven-state coverage |
| `v2_fe/src/App.tsx` | banner, per-row button, composer checkbox all read the resolver |
