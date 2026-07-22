# Spec: link a GitHub repo, publish tasks as issues, comment as the acting user

**Status:** draft, for review
**Task:** #25 (currently `blocked` — this spec unblocks it)
**Author:** Claude (main), with dalmasonto
**Date:** 2026-07-22

## Why

TaskFlow tracks work well internally, but the jump to GitHub is a hard gap.
For *some* big tasks a developer wants a real GitHub issue to exist, tracked
back here, so that when the task ships the commit message can carry the issue
number and the trail is visible on both sides.

Two rules shape the whole design, agreed up front:

1. **Not every task becomes an issue.** With AI-assisted work it is easy to
   spam GitHub and get an account flagged. Publishing is deliberate and
   per-task, never automatic.
2. **Attribution is real.** Each user creates their own agent, so we always
   know who acted. When a comment is posted to an issue on a person's behalf,
   it must go out under *their* GitHub identity — not a shared bot.

### Decisions locked during design

- **A — auth model:** OAuth (via `umbral-oauth`) for now, not manual PATs.
  The **project owner's** linked token is the *tracking key*: it creates
  issues and records baseline "agent activity → GitHub".
- **B — everything opt-in:** no automatic comments anywhere. A user sees an
  explicit button ("Post to the issue / PR as me"), gated by a per-user,
  per-project setting. When the agent acts on someone's behalf it uses
  **that user's** token.
- **C — fallback:** if a user clicks "post as me" but hasn't linked GitHub (or
  has opted out), we prompt them into `/oauth/github/connect`; if they decline,
  the button stays disabled. We **never** silently post with the owner key
  under someone else's name.

## Background: how `umbral-oauth` works (the parts we rely on)

A social identity is a `SocialAccount` row FK'd to an `AuthUser` — an extension
of the user, never a replacement. Provider tokens live in `Masked<String>`
columns (encrypted at rest, read back with `.reveal()`).

- Providers load from env via `from_env()`; nothing hardcoded.
- The plugin **requires `SessionsPlugin`** — single-use `state` + PKCE (S256)
  live in the session.
- Routes: `GET /oauth/github/login` (auth), `GET /oauth/github/connect`
  (link to the *already-authenticated* user), `GET /oauth/github/callback`,
  `POST /oauth/github/disconnect` (needs `{{ csrf_input }}`).
- `SocialAccount` fields we use: `user`, `provider` (`"github"`),
  `provider_uid`, `provider_email`, `email_verified`,
  `access_token: Masked<String>`, `scopes`, `expires_at`.

Full reference: <https://dalmasonto.github.io/umbral/docs/v0.0.1/auth/oauth>.

## Proposed design

### 1. New `taskflow-github` plugin

GitHub concerns live in a new plugin, mirroring the existing per-domain split
(`taskflow-projects`, `taskflow-tasks`, `taskflow-agents`). It depends on
`umbral-oauth`, `taskflow-projects`, and `taskflow-tasks`.

Rationale: keeps the OAuth dependency and GitHub API client out of the core
spine. *Alternative rejected:* bolting this onto `taskflow-projects` would drag
OAuth deps into the model layer everything else hangs off.

### 2. Schema deltas

The existing models already carry more than expected —
`TaskflowProject.repository_url`, `TaskflowProject.owner`, and
`TaskflowTaskActivity.actor_user` / `actor_agent_id` all exist today. The
additions are therefore small.

**`TaskflowProject`** (in `taskflow-projects`):

- `github_repo: Option<String>` — canonical `owner/name`, parsed from
  `repository_url` or set explicitly. Nullable = not linked.
- `github_linked_by: Option<ForeignKey<AuthUser>>` (`on_delete = set_null`) —
  whose `SocialAccount` token is the tracking key. Normally the owner; stored
  explicitly so ownership changes don't silently repoint the token.
- `github_default_branch: Option<String>` — for commit/PR references.

**`TaskflowTask`** (in `taskflow-tasks`):

- `github_issue_number: Option<i64>` — null = not published.
- `github_issue_url: Option<String>` — convenience, so the UI links out
  without reconstructing the URL.

**New `TaskflowGithubPref`** (in `taskflow-github`):

```rust
#[umbral(unique_together = [["user", "project"]])]
pub struct TaskflowGithubPref {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub user: ForeignKey<AuthUser>,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    /// Opt-in: may the agent post to GitHub attributed to this user, in this
    /// project? Default false — nothing goes out under someone's name until
    /// they turn it on.
    #[umbral(default = "false")]
    pub post_as_me: bool,
    // created_at / updated_at
}
```

Per-project (not global) because acting is repo-scoped: a user may be happy
posting as themselves on one project but not another. Whether a user has linked
GitHub *at all* is answered by their `SocialAccount` — not duplicated here.

### 3. OAuth wiring

Add to the app build: `OAuthPlugin::new(base_url)` with
`GitHubProvider::from_env()`, and `SessionsPlugin` (required for state/CSRF).
Env vars (names exact):

```
UMBRAL_OAUTH_GITHUB_CLIENT_ID=Ov23…
UMBRAL_OAUTH_GITHUB_CLIENT_SECRET=…
UMBRAL_OAUTH_REDIRECT_BASE=http://localhost:8100   # optional
```

Scope requested at connect: **`repo`** (needed for issue creation + comments on
private repos). If a deployment only ever touches public repos it can narrow to
`public_repo`; `repo` is the safe default.

Both the owner (to establish the tracking key) and teammates (to opt in) use the
same `/oauth/github/connect` route while authenticated.

### 4. Key-selection rule — the heart of it

| Action | Token used |
|---|---|
| Create issue from a task; back-link `issue_number`/url | **owner** — `project.github_linked_by`'s `SocialAccount` |
| Comment / PR action **attributed to a person** | **that user's** `SocialAccount.access_token.reveal()`, only when their `post_as_me` is true |
| Acting user hasn't linked, or `post_as_me` is false | **button disabled**; inline prompt to `/oauth/github/connect`. Never fall back to the owner key under their name. |

Restated: **owner key = system/tracking actions; individual key = anything
attributed to a person, and only when they opted in.**

### 5. Flow

**Publish a task as an issue** (deliberate, per-task):
Task detail → "Publish as GitHub issue" → create issue with the **owner** key →
store `github_issue_number` + `github_issue_url` on the task → the number is now
available so a commit message can reference `#N`.

**Comment on the issue** (opt-in, per-actor):
An activity or a manual "Post to issue #N as me" button → resolve the acting
user → check `post_as_me` and a linked `SocialAccount` → post the comment with
**their** key. If the check fails, the button is disabled with a "Connect
GitHub to post as yourself" prompt. No automatic posting anywhere.

### 6. GitHub API surface (minimal)

A small client in `taskflow-github` calling, with a supplied token:

- `POST /repos/{owner}/{repo}/issues` → create issue, read back `number` +
  `html_url`.
- `POST /repos/{owner}/{repo}/issues/{number}/comments` → comment.

Token expiry: `SocialAccount.expires_at` is checked before use; an expired
token surfaces as "re-connect GitHub", not a silent 401.

## Acceptance criteria (task #25 review gate)

- [ ] Owner links a project's GitHub via `/oauth/github/connect`; project shows
      `github_repo` + `github_linked_by` set.
- [ ] "Publish as issue" on a task creates a real issue with the **owner** key,
      and stores `github_issue_number` + `github_issue_url` on the task.
- [ ] A user with `post_as_me = true` and a linked account posts a comment that
      lands under **their** GitHub identity (not the owner's).
- [ ] A user without a link, or with `post_as_me = false`, sees the post button
      **disabled** with a connect prompt — and no comment is posted.
- [ ] Provider tokens are never returned by any API or rendered in a template;
      they are read only via `.reveal()` server-side.
- [ ] An expired `SocialAccount` surfaces as "re-connect", not a 401 stack.
- [ ] End-to-end test covering link → publish → comment-as-user → disabled-state.

## Open questions

1. **Commit ↔ issue linkage direction.** This spec covers publishing an issue
   and exposing its number so a commit *message* can cite `#N`. Do we also want
   TaskFlow to *detect* a commit that references `#N` and post back, or is the
   human writing `#N` into the commit sufficient for v1? (Recommend: v1 is
   one-directional — expose the number, humans cite it. Detection is a later
   task.)
2. **`repo` vs `public_repo` default.** Ship `repo` (works for private) and let
   a deployment narrow it, or default to `public_repo` and widen on demand?
   (Recommend: `repo`, since flagged-account risk is about *volume*, not scope.)
3. **Owner departs / token revoked.** `github_linked_by` is explicit, so a
   revoked owner token blocks issue creation until re-linked. Do we surface a
   project-level "GitHub tracking key needs re-connecting" banner? (Recommend:
   yes, but as a follow-up once the happy path lands.)
