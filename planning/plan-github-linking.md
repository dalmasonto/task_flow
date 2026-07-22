# GitHub Linking (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project link a GitHub repo, publish a task as a GitHub issue with the owner's OAuth token (storing the issue number back), and post issue/PR comments under the *acting user's* own GitHub identity — opt-in only.

**Architecture:** A new `taskflow-github` workspace plugin owns the GitHub concerns. All outbound GitHub HTTP goes through a `GithubApi` trait; all OAuth-token retrieval goes through a `GithubTokenSource` trait. Tasks 1–7 are built and tested entirely against those traits with in-memory fakes (no network, no `umbral-oauth`). Task 8 supplies the real `reqwest` and `umbral-oauth` adapters and wires the plugins into `main.rs`. Schema deltas land on the existing `TaskflowProject`/`TaskflowTask` models plus one new `TaskflowGithubPref` model.

**Tech Stack:** Rust 2024, `umbral` 0.0.10 framework (ORM + plugins + REST), `umbral-oauth` 0.0.10 (OAuth/`SocialAccount`), `umbral-sessions` (already wired), `reqwest` (GitHub REST), `sqlx`/SQLite+Postgres, `umbral-testing` for in-process integration tests.

## Global Constraints

- **Framework version:** every umbral crate is pinned to `0.0.10`. `umbral-oauth = "0.0.10"`, `reqwest = { version = "0.12", features = ["json"] }` are the only new deps.
- **Migrations are explicit and additive.** After any model field change, run BOTH `cargo run -- makemigrations` AND `cargo run -- migrate` from the `backend/` folder (per dalmasonto). `makemigrations` generates a NEW numbered migration; NEVER edit or regenerate an existing `NNNN_*.json` under the same id (a same-id rewrite is silently skipped by `migrate` — this repo has been bitten by exactly that). Tests do not need the JSON migration: `boot()` derives the schema from the model structs.
- **Identity from the token, never the body.** Every authed handler derives the caller via `RequireAuth(user_id)` (see `taskflow-projects/src/views.rs`); no handler trusts a `user` field in the request JSON.
- **Tokens are never serialized.** A `SocialAccount` access token is read only server-side via `.reveal()` and is never placed in a response body, log line, or template.
- **Scope is `repo`.** The GitHub OAuth connect scope is exactly `repo`. No public/private branching.
- **Key-selection rule (verbatim from spec):** owner key (`project.github_linked_by`) = system/tracking actions (create issue); the acting user's own key = anything attributed to a person, and only when their `post_as_me` is true. If the required token is absent, the operation returns a "needs connect" result — it NEVER falls back to another user's key.
- **Route conventions:** `/api/taskflow/github/...` for JSON (matches the existing `/api/taskflow/...` convention in `taskflow-projects/src/urls.rs`).

---

## File Structure

**New plugin `plugins/taskflow-github/`:**
- `Cargo.toml` — crate manifest (deps: umbral, umbral-auth, umbral-oauth, taskflow-projects, taskflow-tasks, reqwest, serde, sqlx, chrono).
- `src/lib.rs` — `TaskflowGithubPlugin` (`Plugin` impl: models + routes + `dependencies`).
- `src/models.rs` — `TaskflowGithubPref`.
- `src/api.rs` — `GithubApi` trait + `IssueRef` type + `FakeGithubApi` (test double behind `#[cfg(any(test, feature = "test-fakes"))]`... see Task 3 for exact gating).
- `src/tokens.rs` — `GithubTokenSource` trait, `TokenOutcome` enum, and the `resolve_*` functions (pure key-selection logic).
- `src/views.rs` — HTTP handlers: `publish_issue`, `comment_on_issue`, `get_pref`, `set_pref`.
- `src/urls.rs` — route table.
- `src/adapters.rs` — real `reqwest`/`umbral-oauth` impls (Task 8 only).
- `tests/support/mod.rs` — boot harness + fakes wiring + seed helpers.
- `tests/prefs.rs`, `tests/token_resolution.rs`, `tests/publish_issue.rs`, `tests/comment.rs` — integration tests.

**Modified:**
- `plugins/taskflow-projects/src/models.rs` — add 3 fields to `TaskflowProject`.
- `plugins/taskflow-tasks/src/models.rs` — add 2 fields to `TaskflowTask`.
- `backend/Cargo.toml` — add `taskflow-github` path dep + `umbral-oauth`.
- `backend/src/main.rs` — register `OAuthPlugin`, `TaskflowGithubPlugin`.
- `backend/migrations/taskflow_projects/`, `backend/migrations/taskflow_tasks/`, new `backend/migrations/taskflow_github/` — generated JSON (Task 1, 2, 8).

---

## Task 1: Schema deltas on Project and Task

**Files:**
- Modify: `plugins/taskflow-projects/src/models.rs` (`TaskflowProject`, ~line 84-105)
- Modify: `plugins/taskflow-tasks/src/models.rs` (`TaskflowTask`, ~line 64-109)
- Test: `plugins/taskflow-projects/tests/github_fields.rs` (new)

**Interfaces:**
- Produces: `TaskflowProject.github_repo: Option<String>`, `TaskflowProject.github_linked_by: Option<ForeignKey<AuthUser>>`, `TaskflowProject.github_default_branch: Option<String>`; `TaskflowTask.github_issue_number: Option<i64>`, `TaskflowTask.github_issue_url: Option<String>`. Field-accessor consts `taskflow_project::GITHUB_REPO`, `taskflow_project::GITHUB_LINKED_BY`, `taskflow_task::GITHUB_ISSUE_NUMBER`, etc. are generated by `#[derive(Model)]`.

- [ ] **Step 1: Write the failing test** — round-trip the new Project fields through the ORM.

Create `plugins/taskflow-projects/tests/github_fields.rs`:

```rust
mod support;
use support::TestApp;

use taskflow_projects::models::{TaskflowProject, TaskflowProjectStatus, taskflow_project};
use umbral::orm::ForeignKey;

#[tokio::test]
async fn project_persists_github_link_fields() {
    let app = TestApp::new().await;
    let user = app.create_user().await;

    let created = TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: "GH".into(),
            slug: "gh-proj".into(),
            description_markdown: String::new(),
            repository_url: Some("https://github.com/acme/widgets".into()),
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: Some(ForeignKey::new(user.id)),
            github_repo: Some("acme/widgets".into()),
            github_linked_by: Some(ForeignKey::new(user.id)),
            github_default_branch: Some("main".into()),
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project");

    let loaded = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(created.id))
        .first()
        .await
        .expect("query")
        .expect("row exists");

    assert_eq!(loaded.github_repo.as_deref(), Some("acme/widgets"));
    assert_eq!(loaded.github_linked_by.map(|fk| fk.id()), Some(user.id));
    assert_eq!(loaded.github_default_branch.as_deref(), Some("main"));
}
```

- [ ] **Step 2: Run the test to verify it fails to compile**

Run: `cargo test -p taskflow-projects --test github_fields`
Expected: FAIL — compile error, `TaskflowProject` has no field `github_repo`.

- [ ] **Step 3: Add the fields to `TaskflowProject`**

In `plugins/taskflow-projects/src/models.rs`, inside `struct TaskflowProject`, after the `owner` field (line ~100) add:

```rust
    /// Canonical `owner/name` of the linked GitHub repo. `None` = not linked.
    /// Parsed from `repository_url` or set explicitly at link time.
    #[umbral(string, max_length = 200)]
    pub github_repo: Option<String>,
    /// Whose `SocialAccount` token is the project's tracking key (creates
    /// issues). `set_null`: if this user leaves the project the key goes null
    /// and issue creation disables until any member re-links.
    #[umbral(on_delete = "set_null")]
    pub github_linked_by: Option<ForeignKey<AuthUser>>,
    /// Default branch for commit/PR references, e.g. "main".
    #[umbral(string, max_length = 120)]
    pub github_default_branch: Option<String>,
```

- [ ] **Step 4: Add the fields to `TaskflowTask`**

In `plugins/taskflow-tasks/src/models.rs`, inside `struct TaskflowTask`, after `due_at` (line ~104) add:

```rust
    /// GitHub issue number once this task is published. `None` = not published.
    pub github_issue_number: Option<i64>,
    /// Convenience: full issue URL, so the UI links out without rebuilding it.
    #[umbral(string, max_length = 400)]
    pub github_issue_url: Option<String>,
```

- [ ] **Step 5: Update every `TaskflowProject { .. }` and `TaskflowTask { .. }` literal**

Adding non-`Default` struct fields breaks existing literal constructions. Find and fix them:

Run: `grep -rn "TaskflowProject {" plugins backend/src | grep -v "//"`
Run: `grep -rn "TaskflowTask {" plugins backend/src | grep -v "//"`

For each hit (notably `plugins/taskflow-projects/tests/support/mod.rs` `seed_project()` and any tasks test support), add the new fields set to `None` in the literal. Example for `seed_project()`:

```rust
            owner: None,
            github_repo: None,
            github_linked_by: None,
            github_default_branch: None,
            created_at: None,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p taskflow-projects --test github_fields`
Expected: PASS. Also run `cargo build -p taskflow-tasks` to confirm the task-model literals compile.

- [ ] **Step 7: Generate AND apply the migrations**

Run: `cd backend && cargo run -- makemigrations && cargo run -- migrate`
Expected: new files `migrations/taskflow_projects/0003_auto.json` and `migrations/taskflow_tasks/0002_auto.json` (or next free id) adding the columns, then `migrate` applies them to the dev DB. Inspect the files: each should be `AddColumn` operations, nullable, no table drop/recreate.

- [ ] **Step 8: Commit**

```bash
git add plugins/taskflow-projects plugins/taskflow-tasks backend/migrations
git commit -m "feat(#25): add github link fields to project and task models"
```

---

## Task 2: `taskflow-github` plugin skeleton + `TaskflowGithubPref` model

**Files:**
- Create: `plugins/taskflow-github/Cargo.toml`
- Create: `plugins/taskflow-github/src/lib.rs`
- Create: `plugins/taskflow-github/src/models.rs`
- Create: `plugins/taskflow-github/src/urls.rs` (empty router for now)
- Create: `plugins/taskflow-github/src/views.rs` (empty for now)
- Create: `plugins/taskflow-github/tests/support/mod.rs`
- Create: `plugins/taskflow-github/tests/prefs.rs`

**Interfaces:**
- Produces: `TaskflowGithubPlugin` (impl `Plugin`, name `"taskflow_github"`, deps `["auth", "taskflow_projects"]`). `TaskflowGithubPref { id, user: ForeignKey<AuthUser>, project: ForeignKey<TaskflowProject>, post_as_me: bool, created_at, updated_at }` with `unique_together [["user","project"]]`. Accessor module `taskflow_github_pref`.

- [ ] **Step 1: Create the crate manifest**

`plugins/taskflow-github/Cargo.toml`:

```toml
[package]
name = "taskflow-github"
version = "0.1.0"
edition = "2024"

[dependencies]
umbral = "0.0.10"
umbral-auth = "0.0.10"
taskflow-projects = { path = "../taskflow-projects" }
taskflow-tasks = { path = "../taskflow-tasks" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["sqlite", "postgres", "runtime-tokio", "chrono"] }
chrono = { version = "0.4", features = ["serde"] }
async-trait = "0.1"

[dev-dependencies]
umbral-testing = "0.0.10"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
http = "1"
```

(The crate is picked up automatically — `backend/Cargo.toml` has `members = ["plugins/*"]`.)

- [ ] **Step 2: Write the failing test** — a pref defaults to `post_as_me = false` and is unique per (user, project).

`plugins/taskflow-github/tests/prefs.rs`:

```rust
mod support;
use support::TestApp;

use taskflow_github::models::{TaskflowGithubPref, taskflow_github_pref};
use umbral::orm::ForeignKey;

#[tokio::test]
async fn pref_row_roundtrips_and_defaults_false() {
    let app = TestApp::new().await;
    let user = app.create_user().await;
    let project = support::seed_project().await;

    let pref = TaskflowGithubPref::objects()
        .create(TaskflowGithubPref {
            id: 0,
            user: ForeignKey::new(user.id),
            project: ForeignKey::new(project),
            post_as_me: false,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create pref");

    let loaded = TaskflowGithubPref::objects()
        .filter(taskflow_github_pref::ID.eq(pref.id))
        .first()
        .await
        .expect("query")
        .expect("exists");
    assert!(!loaded.post_as_me);
}
```

- [ ] **Step 3: Write the model**

`plugins/taskflow-github/src/models.rs`:

```rust
//! Models for the `taskflow-github` plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use taskflow_projects::models::TaskflowProject;
use umbral::orm::ForeignKey;
use umbral_auth::AuthUser;

/// Per-user, per-project opt-in: may the agent post to GitHub attributed to
/// this user, in this project? Default false — nothing goes out under someone's
/// name until they turn it on. Per-project because acting is repo-scoped.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["user", "project"]])]
pub struct TaskflowGithubPref {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub user: ForeignKey<AuthUser>,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(default = "false")]
    pub post_as_me: bool,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}
```

- [ ] **Step 4: Write the plugin impl + empty routing**

`plugins/taskflow-github/src/lib.rs`:

```rust
//! TaskflowGithubPlugin — GitHub linking, publish-as-issue, comment-as-actor.

pub mod api;
pub mod models;
pub mod tokens;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowGithubPlugin;

impl Plugin for TaskflowGithubPlugin {
    fn name(&self) -> &'static str {
        "taskflow_github"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![umbral::migrate::ModelMeta::for_::<models::TaskflowGithubPref>()]
    }

    fn routes(&self) -> Router {
        urls::router()
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        Ok(())
    }
}
```

Create placeholder module files so `lib.rs` compiles. `plugins/taskflow-github/src/urls.rs`:

```rust
//! URL conf for the taskflow-github plugin.
use umbral::web::Router;

pub fn router() -> Router {
    Router::new()
}
```

`plugins/taskflow-github/src/views.rs`:

```rust
//! HTTP handlers for the taskflow-github plugin.
```

`plugins/taskflow-github/src/api.rs`: `//! GitHub API boundary. (populated in Task 3)`
`plugins/taskflow-github/src/tokens.rs`: `//! Token selection. (populated in Task 4)`

- [ ] **Step 5: Write the test harness** — mirror the projects harness.

`plugins/taskflow-github/tests/support/mod.rs`:

```rust
#![allow(dead_code)]
//! Test harness for the taskflow-github plugin.

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::Utc;
use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot, seq};

use taskflow_github::TaskflowGithubPlugin;
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{TaskflowProject, TaskflowProjectStatus};

#[derive(Clone)]
pub struct TestUser {
    pub id: i64,
    pub email: String,
}

pub struct TestResponse {
    inner: umbral_testing::TestResponse,
}
impl TestResponse {
    pub fn status(&self) -> u16 {
        self.inner.status().as_u16()
    }
    pub fn json(&self) -> Value {
        self.inner.body_json()
    }
}

pub struct TestApp {
    client: TestClient,
    tokens: Mutex<HashMap<i64, String>>,
}

impl TestApp {
    pub async fn new() -> Self {
        boot(|b| {
            b.plugin(AuthPlugin::<AuthUser>::default())
                .plugin(TaskflowProjectsPlugin)
                .plugin(TaskflowGithubPlugin)
        })
        .await;
        Self {
            client: TestClient::new(taskflow_github::urls::router()),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    pub async fn create_user(&self) -> TestUser {
        let n = seq();
        let email = format!("user-{n}@example.test");
        let user = AuthUser::objects()
            .create(AuthUser {
                id: 0,
                username: format!("user-{n}"),
                email: email.clone(),
                password_hash: "unused".into(),
                is_active: true,
                is_staff: false,
                is_superuser: false,
                date_joined: Utc::now(),
                last_login: None,
                email_verified_at: None,
            })
            .await
            .expect("create user");
        let (_, plaintext) = AuthToken::create_for(&user, "test").await.expect("token");
        self.tokens.lock().unwrap().insert(user.id, plaintext.0);
        TestUser { id: user.id, email }
    }

    fn set_auth(&self, user_id: i64) {
        let token = self.tokens.lock().unwrap().get(&user_id).cloned().unwrap();
        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
    }

    pub async fn post_body_as(&self, user_id: i64, path: &str, body: Value) -> TestResponse {
        self.set_auth(user_id);
        TestResponse { inner: self.client.post_json(path, &body).await }
    }

    pub async fn get_as(&self, user_id: i64, path: &str) -> TestResponse {
        self.set_auth(user_id);
        TestResponse { inner: self.client.get(path).await }
    }
}

pub async fn seed_project() -> i64 {
    let n = seq();
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: format!("Project {n}"),
            slug: format!("project-{n}"),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: None,
            github_repo: None,
            github_linked_by: None,
            github_default_branch: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p taskflow-github --test prefs`
Expected: PASS.

- [ ] **Step 7: Generate the migration**

Run: `cd backend && cargo run -- makemigrations`
Expected: new `migrations/taskflow_github/0001_auto.json` creating `taskflow_github_pref`. (Requires the plugin be registered in `main.rs`; if `makemigrations` reports it doesn't see the model, do Task 8 Step 1–2's registration first, then return here. Registration is inert until routes are added.)

- [ ] **Step 8: Commit**

```bash
git add plugins/taskflow-github backend/migrations/taskflow_github
git commit -m "feat(#25): taskflow-github plugin skeleton + per-project opt-in pref"
```

---

## Task 3: `GithubApi` trait + fake, `IssueRef` type

**Files:**
- Modify: `plugins/taskflow-github/src/api.rs`
- Test: `plugins/taskflow-github/tests/api_fake.rs` (new)

**Interfaces:**
- Produces:
  - `struct NewIssue { pub title: String, pub body: String }`
  - `struct IssueRef { pub number: i64, pub url: String }`
  - `#[async_trait] trait GithubApi: Send + Sync { async fn create_issue(&self, token: &str, repo: &str, issue: NewIssue) -> Result<IssueRef, GithubError>; async fn add_comment(&self, token: &str, repo: &str, issue_number: i64, body: &str) -> Result<(), GithubError>; }`
  - `enum GithubError { Unauthorized, NotFound, Other(String) }`
  - `struct FakeGithubApi` recording calls, returning a scripted `IssueRef`.
- Consumed by: Task 5 (`publish_issue`), Task 6 (`comment_on_issue`), Task 8 (real adapter).

- [ ] **Step 1: Write the failing test**

`plugins/taskflow-github/tests/api_fake.rs`:

```rust
use taskflow_github::api::{FakeGithubApi, GithubApi, NewIssue};

#[tokio::test]
async fn fake_records_issue_creation_and_returns_scripted_ref() {
    let api = FakeGithubApi::returning(42, "https://github.com/acme/widgets/issues/42");
    let issue = api
        .create_issue("tok", "acme/widgets", NewIssue { title: "T".into(), body: "B".into() })
        .await
        .expect("create");
    assert_eq!(issue.number, 42);
    let calls = api.created_issues();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "tok");
    assert_eq!(calls[0].1, "acme/widgets");
    assert_eq!(calls[0].2.title, "T");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p taskflow-github --test api_fake`
Expected: FAIL — `taskflow_github::api::FakeGithubApi` not found.

- [ ] **Step 3: Implement the trait + fake**

Replace `plugins/taskflow-github/src/api.rs`:

```rust
//! The GitHub API boundary. Everything outbound goes through `GithubApi`, so
//! handlers are testable against `FakeGithubApi` with no network.

use std::sync::Mutex;

use async_trait::async_trait;

#[derive(Debug, Clone)]
pub struct NewIssue {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct IssueRef {
    pub number: i64,
    pub url: String,
}

#[derive(Debug)]
pub enum GithubError {
    Unauthorized,
    NotFound,
    Other(String),
}

#[async_trait]
pub trait GithubApi: Send + Sync {
    async fn create_issue(
        &self,
        token: &str,
        repo: &str,
        issue: NewIssue,
    ) -> Result<IssueRef, GithubError>;

    async fn add_comment(
        &self,
        token: &str,
        repo: &str,
        issue_number: i64,
        body: &str,
    ) -> Result<(), GithubError>;
}

/// In-memory test double: records every call, returns a scripted issue ref.
pub struct FakeGithubApi {
    ref_number: i64,
    ref_url: String,
    created: Mutex<Vec<(String, String, NewIssue)>>,
    comments: Mutex<Vec<(String, String, i64, String)>>,
}

impl FakeGithubApi {
    pub fn returning(number: i64, url: &str) -> Self {
        Self {
            ref_number: number,
            ref_url: url.to_string(),
            created: Mutex::new(Vec::new()),
            comments: Mutex::new(Vec::new()),
        }
    }
    pub fn created_issues(&self) -> Vec<(String, String, NewIssue)> {
        self.created.lock().unwrap().clone()
    }
    pub fn comments(&self) -> Vec<(String, String, i64, String)> {
        self.comments.lock().unwrap().clone()
    }
}

#[async_trait]
impl GithubApi for FakeGithubApi {
    async fn create_issue(
        &self,
        token: &str,
        repo: &str,
        issue: NewIssue,
    ) -> Result<IssueRef, GithubError> {
        self.created
            .lock()
            .unwrap()
            .push((token.to_string(), repo.to_string(), issue));
        Ok(IssueRef { number: self.ref_number, url: self.ref_url.clone() })
    }

    async fn add_comment(
        &self,
        token: &str,
        repo: &str,
        issue_number: i64,
        body: &str,
    ) -> Result<(), GithubError> {
        self.comments.lock().unwrap().push((
            token.to_string(),
            repo.to_string(),
            issue_number,
            body.to_string(),
        ));
        Ok(())
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p taskflow-github --test api_fake`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/taskflow-github/src/api.rs plugins/taskflow-github/tests/api_fake.rs
git commit -m "feat(#25): GithubApi trait + in-memory fake"
```

---

## Task 4: Token selection logic (`GithubTokenSource` + `resolve_*`)

**Files:**
- Modify: `plugins/taskflow-github/src/tokens.rs`
- Test: `plugins/taskflow-github/tests/token_resolution.rs` (new)

**Interfaces:**
- Produces:
  - `#[async_trait] trait GithubTokenSource: Send + Sync { async fn token_for_user(&self, user_id: i64) -> Option<String>; }` — returns the revealed GitHub access token for a user, or `None` if they have no linked `SocialAccount`.
  - `enum TokenOutcome { Ready(String), NeedsConnect }`
  - `async fn resolve_owner_token(src: &dyn GithubTokenSource, github_linked_by: Option<i64>) -> TokenOutcome` — `NeedsConnect` if linker is `None` or unlinked.
  - `async fn resolve_actor_token(src: &dyn GithubTokenSource, user_id: i64, post_as_me: bool) -> TokenOutcome` — `NeedsConnect` unless `post_as_me` AND a token exists.
  - `struct FakeTokenSource` mapping `user_id -> token`.
- Consumed by: Task 5, Task 6.

- [ ] **Step 1: Write the failing test**

`plugins/taskflow-github/tests/token_resolution.rs`:

```rust
use taskflow_github::tokens::{
    resolve_actor_token, resolve_owner_token, FakeTokenSource, TokenOutcome,
};

fn ready(o: TokenOutcome) -> Option<String> {
    match o {
        TokenOutcome::Ready(t) => Some(t),
        TokenOutcome::NeedsConnect => None,
    }
}

#[tokio::test]
async fn owner_token_needs_connect_when_no_linker() {
    let src = FakeTokenSource::new();
    assert!(matches!(resolve_owner_token(&src, None).await, TokenOutcome::NeedsConnect));
}

#[tokio::test]
async fn owner_token_ready_when_linker_has_token() {
    let src = FakeTokenSource::new().with(7, "owner-tok");
    assert_eq!(ready(resolve_owner_token(&src, Some(7)).await), Some("owner-tok".into()));
}

#[tokio::test]
async fn owner_token_needs_connect_when_linker_unlinked() {
    let src = FakeTokenSource::new(); // user 7 has no SocialAccount
    assert!(matches!(resolve_owner_token(&src, Some(7)).await, TokenOutcome::NeedsConnect));
}

#[tokio::test]
async fn actor_token_needs_connect_when_opted_out() {
    let src = FakeTokenSource::new().with(3, "actor-tok");
    assert!(matches!(resolve_actor_token(&src, 3, false).await, TokenOutcome::NeedsConnect));
}

#[tokio::test]
async fn actor_token_needs_connect_when_opted_in_but_unlinked() {
    let src = FakeTokenSource::new();
    assert!(matches!(resolve_actor_token(&src, 3, true).await, TokenOutcome::NeedsConnect));
}

#[tokio::test]
async fn actor_token_ready_when_opted_in_and_linked() {
    let src = FakeTokenSource::new().with(3, "actor-tok");
    assert_eq!(ready(resolve_actor_token(&src, 3, true).await), Some("actor-tok".into()));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p taskflow-github --test token_resolution`
Expected: FAIL — `tokens` items not found.

- [ ] **Step 3: Implement the logic**

Replace `plugins/taskflow-github/src/tokens.rs`:

```rust
//! Key-selection: which GitHub token (if any) may perform an action.
//!
//! owner key = system/tracking (create issue); actor key = attributed-to-a-
//! person actions, only when opted in. Absent token => NeedsConnect, NEVER a
//! fallback to another user's key.

use std::collections::HashMap;

use async_trait::async_trait;

#[async_trait]
pub trait GithubTokenSource: Send + Sync {
    /// The revealed GitHub access token for this user, or `None` if unlinked.
    async fn token_for_user(&self, user_id: i64) -> Option<String>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenOutcome {
    Ready(String),
    NeedsConnect,
}

pub async fn resolve_owner_token(
    src: &dyn GithubTokenSource,
    github_linked_by: Option<i64>,
) -> TokenOutcome {
    match github_linked_by {
        None => TokenOutcome::NeedsConnect,
        Some(uid) => match src.token_for_user(uid).await {
            Some(tok) => TokenOutcome::Ready(tok),
            None => TokenOutcome::NeedsConnect,
        },
    }
}

pub async fn resolve_actor_token(
    src: &dyn GithubTokenSource,
    user_id: i64,
    post_as_me: bool,
) -> TokenOutcome {
    if !post_as_me {
        return TokenOutcome::NeedsConnect;
    }
    match src.token_for_user(user_id).await {
        Some(tok) => TokenOutcome::Ready(tok),
        None => TokenOutcome::NeedsConnect,
    }
}

pub struct FakeTokenSource {
    tokens: HashMap<i64, String>,
}
impl FakeTokenSource {
    pub fn new() -> Self {
        Self { tokens: HashMap::new() }
    }
    pub fn with(mut self, user_id: i64, token: &str) -> Self {
        self.tokens.insert(user_id, token.to_string());
        self
    }
}
impl Default for FakeTokenSource {
    fn default() -> Self {
        Self::new()
    }
}
#[async_trait]
impl GithubTokenSource for FakeTokenSource {
    async fn token_for_user(&self, user_id: i64) -> Option<String> {
        self.tokens.get(&user_id).cloned()
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p taskflow-github --test token_resolution`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add plugins/taskflow-github/src/tokens.rs plugins/taskflow-github/tests/token_resolution.rs
git commit -m "feat(#25): GitHub key-selection logic (owner vs actor, needs-connect)"
```

---

## Task 5: `publish_issue` endpoint

Publish a task as an issue with the owner key; store `github_issue_number`/`url`.

**Files:**
- Modify: `plugins/taskflow-github/src/views.rs`
- Modify: `plugins/taskflow-github/src/urls.rs`
- Modify: `plugins/taskflow-github/src/lib.rs` (hold injected deps — see Step 3)
- Test: `plugins/taskflow-github/tests/publish_issue.rs` (new)

**Interfaces:**
- Consumes: `GithubApi` (Task 3), `GithubTokenSource`/`resolve_owner_token` (Task 4), `TaskflowProject.github_repo`/`github_linked_by` (Task 1), `TaskflowTask.github_issue_number`/`github_issue_url` (Task 1).
- Produces: `POST /api/taskflow/github/projects/{project}/tasks/{task}/publish` → `200 { "issue_number": i64, "issue_url": String }` on success; `409 { "error": "needs_connect", "connect_url": "/oauth/github/connect" }` when the owner key is absent; `404` if the project isn't GitHub-linked (`github_repo` null). Injected deps live in `GithubDeps { api: Arc<dyn GithubApi>, tokens: Arc<dyn GithubTokenSource> }` provided as axum state.

The handler reads its collaborators from axum `State<GithubDeps>`. Tests build a router with fakes; `main.rs` (Task 8) builds it with real adapters.

- [ ] **Step 1: Add the shared deps struct + a router builder that takes them**

In `plugins/taskflow-github/src/lib.rs` add near the top (after imports):

```rust
use std::sync::Arc;

/// Collaborators the handlers need, injected as axum state so tests supply
/// fakes and `main.rs` supplies real adapters.
#[derive(Clone)]
pub struct GithubDeps {
    pub api: Arc<dyn api::GithubApi>,
    pub tokens: Arc<dyn tokens::GithubTokenSource>,
}
```

Change `urls.rs` to accept deps:

```rust
use umbral::web::{Router, post};
use crate::{views, GithubDeps};

pub fn router(deps: GithubDeps) -> Router {
    Router::new()
        .route(
            "/api/taskflow/github/projects/{project}/tasks/{task}/publish",
            post(views::publish_issue),
        )
        .with_state(deps)
}
```

Update `Plugin::routes()` in `lib.rs` — the plugin needs real deps, so it constructs them from `adapters` (Task 8). Until Task 8, keep the plugin compiling with a `todo!()`-free stub by having `routes()` build from `adapters::default_deps()`; create that now returning fakes-in-release is wrong, so instead: **defer wiring `routes()` to real deps to Task 8** and for now have `Plugin::routes()` return `Router::new()`. Add a doc note:

```rust
    fn routes(&self) -> Router {
        // Wired to real adapters in Task 8. Tests call `urls::router(deps)`
        // directly with fakes.
        Router::new()
    }
```

- [ ] **Step 2: Write the failing test**

`plugins/taskflow-github/tests/publish_issue.rs`:

```rust
mod support;
use support::{TestApp, seed_task, seed_project_linked};

use serde_json::json;

#[tokio::test]
async fn publish_creates_issue_with_owner_key_and_stores_number() {
    let app = TestApp::with_owner_token("owner-tok").await; // fake api returns #7
    let owner = app.owner_user();                            // github_linked_by
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    let task = seed_task(project, "Fix the bug").await;

    let res = app
        .post_body_as(owner.id, &format!(
            "/api/taskflow/github/projects/{project}/tasks/{task}/publish"), json!({}))
        .await;

    assert_eq!(res.status(), 200);
    assert_eq!(res.json()["issue_number"], 7);

    // stored back on the task
    let stored = app.task_issue_number(task).await;
    assert_eq!(stored, Some(7));

    // used the OWNER token, once
    let calls = app.api_created_issues();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "owner-tok");
    assert_eq!(calls[0].1, "acme/widgets");
}

#[tokio::test]
async fn publish_needs_connect_when_linker_unlinked() {
    let app = TestApp::with_no_tokens().await; // token source returns None
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    let task = seed_task(project, "Fix the bug").await;

    let res = app
        .post_body_as(owner.id, &format!(
            "/api/taskflow/github/projects/{project}/tasks/{task}/publish"), json!({}))
        .await;

    assert_eq!(res.status(), 409);
    assert_eq!(res.json()["error"], "needs_connect");
    assert_eq!(app.task_issue_number(task).await, None);
}
```

Extend `tests/support/mod.rs` with: `with_owner_token`/`with_no_tokens` constructors that build the client via `taskflow_github::urls::router(GithubDeps { api, tokens })` using `FakeGithubApi::returning(7, "...issues/7")` and a `FakeTokenSource`; `owner_user()`; `seed_project_linked(linked_by, repo)` (sets `github_repo`, `github_linked_by`); `seed_task(project, title)`; `task_issue_number(task)` (queries `taskflow_task::GITHUB_ISSUE_NUMBER`); `api_created_issues()` (exposes the fake's recorded calls — keep an `Arc<FakeGithubApi>` clone on `TestApp`).

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p taskflow-github --test publish_issue`
Expected: FAIL — `views::publish_issue` not found.

- [ ] **Step 4: Implement the handler**

In `plugins/taskflow-github/src/views.rs`:

```rust
//! HTTP handlers for the taskflow-github plugin.

use serde_json::json;

use umbral::web::{Json, Path, State, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_projects::models::{TaskflowProject, taskflow_project};
use taskflow_tasks::models::{TaskflowTask, taskflow_task};

use crate::api::NewIssue;
use crate::tokens::{resolve_owner_token, TokenOutcome};
use crate::GithubDeps;

fn needs_connect() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": "needs_connect", "connect_url": "/oauth/github/connect" })),
    )
}

/// `POST /api/taskflow/github/projects/{project}/tasks/{task}/publish`
pub async fn publish_issue(
    State(deps): State<GithubDeps>,
    RequireAuth(_user_id): RequireAuth<i64>,
    Path((project_id, task_id)): Path<(i64, i64)>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let project = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"db"}))))?
        .ok_or((StatusCode::NOT_FOUND, Json(json!({"error":"project"}))))?;

    // Project must be GitHub-linked.
    let repo = project
        .github_repo
        .clone()
        .ok_or((StatusCode::NOT_FOUND, Json(json!({"error":"not_linked"}))))?;

    let linked_by = project.github_linked_by.as_ref().map(|fk| fk.id());
    let token = match resolve_owner_token(deps.tokens.as_ref(), linked_by).await {
        TokenOutcome::Ready(t) => t,
        TokenOutcome::NeedsConnect => return Err(needs_connect()),
    };

    let task = TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id) & taskflow_task::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"db"}))))?
        .ok_or((StatusCode::NOT_FOUND, Json(json!({"error":"task"}))))?;

    let issue = deps
        .api
        .create_issue(
            &token,
            &repo,
            NewIssue { title: task.title.clone(), body: task.description_markdown.clone() },
        )
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, Json(json!({"error":"github"}))))?;

    TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id))
        .update_values(
            json!({ "github_issue_number": issue.number, "github_issue_url": issue.url })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        )
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"store"}))))?;

    Ok(Json(json!({ "issue_number": issue.number, "issue_url": issue.url })))
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p taskflow-github --test publish_issue`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add plugins/taskflow-github
git commit -m "feat(#25): publish-task-as-issue endpoint (owner key, stores issue number)"
```

---

## Task 6: `comment_on_issue` endpoint (comment as the acting user)

**Files:**
- Modify: `plugins/taskflow-github/src/views.rs`, `src/urls.rs`
- Test: `plugins/taskflow-github/tests/comment.rs` (new)

**Interfaces:**
- Consumes: `GithubApi::add_comment`, `resolve_actor_token`, `TaskflowGithubPref.post_as_me`, `TaskflowTask.github_issue_number`.
- Produces: `POST /api/taskflow/github/projects/{project}/tasks/{task}/comment` with body `{ "body": String }` → `204` on success (comment posted under the caller's token); `409 needs_connect` when the caller is opted out or unlinked; `409 { "error": "not_published" }` if the task has no issue number.

- [ ] **Step 1: Add the route**

In `urls.rs` add inside `router`:

```rust
        .route(
            "/api/taskflow/github/projects/{project}/tasks/{task}/comment",
            post(views::comment_on_issue),
        )
```

- [ ] **Step 2: Write the failing test**

`plugins/taskflow-github/tests/comment.rs`:

```rust
mod support;
use support::{TestApp, seed_task_with_issue, seed_project_linked, seed_pref};
use serde_json::json;

#[tokio::test]
async fn comment_posts_under_actor_token_when_opted_in() {
    let app = TestApp::with_user_token("alice", "alice-tok").await;
    let alice = app.user("alice");
    let project = seed_project_linked(alice.id, "acme/widgets").await;
    let task = seed_task_with_issue(project, "Fix", 7).await;
    seed_pref(alice.id, project, true).await; // opted in

    let res = app
        .post_body_as(alice.id, &format!(
            "/api/taskflow/github/projects/{project}/tasks/{task}/comment"),
            json!({ "body": "on it" }))
        .await;

    assert_eq!(res.status(), 204);
    let comments = app.api_comments();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].0, "alice-tok"); // actor's token, not owner's
    assert_eq!(comments[0].2, 7);           // issue number
    assert_eq!(comments[0].3, "on it");
}

#[tokio::test]
async fn comment_needs_connect_when_opted_out() {
    let app = TestApp::with_user_token("alice", "alice-tok").await;
    let alice = app.user("alice");
    let project = seed_project_linked(alice.id, "acme/widgets").await;
    let task = seed_task_with_issue(project, "Fix", 7).await;
    seed_pref(alice.id, project, false).await; // opted OUT

    let res = app
        .post_body_as(alice.id, &format!(
            "/api/taskflow/github/projects/{project}/tasks/{task}/comment"),
            json!({ "body": "on it" }))
        .await;

    assert_eq!(res.status(), 409);
    assert_eq!(res.json()["error"], "needs_connect");
    assert!(app.api_comments().is_empty());
}
```

Add to support: `with_user_token(name, token)`, `user(name)`, `seed_task_with_issue(project, title, number)`, `seed_pref(user, project, post_as_me)`, `api_comments()`.

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p taskflow-github --test comment`
Expected: FAIL — `views::comment_on_issue` not found.

- [ ] **Step 4: Implement the handler**

Append to `plugins/taskflow-github/src/views.rs`:

```rust
use serde::Deserialize;
use taskflow_github_pref_import::*; // see note below

use crate::models::{TaskflowGithubPref, taskflow_github_pref};
use crate::tokens::resolve_actor_token;

#[derive(Deserialize)]
pub struct CommentBody {
    pub body: String,
}

/// `POST /api/taskflow/github/projects/{project}/tasks/{task}/comment`
pub async fn comment_on_issue(
    State(deps): State<GithubDeps>,
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, task_id)): Path<(i64, i64)>,
    Json(input): Json<CommentBody>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let project = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"db"}))))?
        .ok_or((StatusCode::NOT_FOUND, Json(json!({"error":"project"}))))?;
    let repo = project
        .github_repo
        .clone()
        .ok_or((StatusCode::NOT_FOUND, Json(json!({"error":"not_linked"}))))?;

    let task = TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id) & taskflow_task::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"db"}))))?
        .ok_or((StatusCode::NOT_FOUND, Json(json!({"error":"task"}))))?;
    let issue_number = task
        .github_issue_number
        .ok_or((StatusCode::CONFLICT, Json(json!({"error":"not_published"}))))?;

    // Opt-in: default false when no pref row exists.
    let post_as_me = TaskflowGithubPref::objects()
        .filter(
            taskflow_github_pref::USER.eq(user_id)
                & taskflow_github_pref::PROJECT.eq(project_id),
        )
        .first()
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"db"}))))?
        .map(|p| p.post_as_me)
        .unwrap_or(false);

    let token = match resolve_actor_token(deps.tokens.as_ref(), user_id, post_as_me).await {
        TokenOutcome::Ready(t) => t,
        TokenOutcome::NeedsConnect => return Err(needs_connect()),
    };

    deps.api
        .add_comment(&token, &repo, issue_number, &input.body)
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, Json(json!({"error":"github"}))))?;

    Ok(StatusCode::NO_CONTENT)
}
```

Note: delete the bogus `taskflow_github_pref_import::*` line — it is a marker to remind you the model imports (`TaskflowGithubPref`, `taskflow_github_pref`) must be added to the existing `use` block at the top of `views.rs`. Keep only the real `use crate::models::{...}` and `use crate::tokens::resolve_actor_token;` lines.

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p taskflow-github --test comment`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add plugins/taskflow-github
git commit -m "feat(#25): comment-on-issue endpoint (actor key, opt-in gated)"
```

---

## Task 7: Read/write the opt-in pref

**Files:**
- Modify: `plugins/taskflow-github/src/views.rs`, `src/urls.rs`
- Test: `plugins/taskflow-github/tests/prefs_api.rs` (new)

**Interfaces:**
- Produces:
  - `GET /api/taskflow/github/projects/{project}/pref` → `200 { "post_as_me": bool }` (get-or-default-false; never creates a row on read).
  - `POST /api/taskflow/github/projects/{project}/pref` body `{ "post_as_me": bool }` → `200 { "post_as_me": bool }` (upsert on `(user, project)`).
- Both derive `user` from `RequireAuth`, never the body.

- [ ] **Step 1: Add routes**

```rust
        .route(
            "/api/taskflow/github/projects/{project}/pref",
            umbral::web::get(views::get_pref).post(views::set_pref),
        )
```

- [ ] **Step 2: Write the failing test**

`plugins/taskflow-github/tests/prefs_api.rs`:

```rust
mod support;
use support::{TestApp, seed_project};
use serde_json::json;

#[tokio::test]
async fn pref_defaults_false_then_toggles_on() {
    let app = TestApp::with_user_token("alice", "t").await;
    let alice = app.user("alice");
    let project = seed_project().await;

    let got = app.get_as(alice.id, &format!("/api/taskflow/github/projects/{project}/pref")).await;
    assert_eq!(got.status(), 200);
    assert_eq!(got.json()["post_as_me"], false);

    let set = app.post_body_as(alice.id,
        &format!("/api/taskflow/github/projects/{project}/pref"),
        json!({ "post_as_me": true })).await;
    assert_eq!(set.status(), 200);
    assert_eq!(set.json()["post_as_me"], true);

    let again = app.get_as(alice.id, &format!("/api/taskflow/github/projects/{project}/pref")).await;
    assert_eq!(again.json()["post_as_me"], true);
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p taskflow-github --test prefs_api`
Expected: FAIL — `views::get_pref` not found.

- [ ] **Step 4: Implement the handlers**

Append to `views.rs`:

```rust
/// `GET /api/taskflow/github/projects/{project}/pref`
pub async fn get_pref(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let post_as_me = TaskflowGithubPref::objects()
        .filter(
            taskflow_github_pref::USER.eq(user_id)
                & taskflow_github_pref::PROJECT.eq(project_id),
        )
        .first()
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"db"}))))?
        .map(|p| p.post_as_me)
        .unwrap_or(false);
    Ok(Json(json!({ "post_as_me": post_as_me })))
}

#[derive(serde::Deserialize)]
pub struct PrefBody {
    pub post_as_me: bool,
}

/// `POST /api/taskflow/github/projects/{project}/pref` — upsert.
pub async fn set_pref(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<PrefBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use umbral::orm::ForeignKey;
    let existing = TaskflowGithubPref::objects()
        .filter(
            taskflow_github_pref::USER.eq(user_id)
                & taskflow_github_pref::PROJECT.eq(project_id),
        )
        .first()
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"db"}))))?;

    match existing {
        Some(p) => {
            TaskflowGithubPref::objects()
                .filter(taskflow_github_pref::ID.eq(p.id))
                .update_values(
                    json!({ "post_as_me": input.post_as_me })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                )
                .await
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"db"}))))?;
        }
        None => {
            TaskflowGithubPref::objects()
                .create(TaskflowGithubPref {
                    id: 0,
                    user: ForeignKey::new(user_id),
                    project: ForeignKey::new(project_id),
                    post_as_me: input.post_as_me,
                    created_at: None,
                    updated_at: None,
                })
                .await
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"db"}))))?;
        }
    }
    Ok(Json(json!({ "post_as_me": input.post_as_me })))
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p taskflow-github --test prefs_api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/taskflow-github
git commit -m "feat(#25): get/set per-project post_as_me opt-in pref"
```

---

## Task 8: Real adapters (`reqwest` + `umbral-oauth`) + wire into the app

This is the ONLY task that touches `umbral-oauth` and the network. Confirm the crate's real API against the installed version before writing — the signatures below follow the published docs (`umbral_oauth::models::{SocialAccount, social_account}`, `.access_token.reveal()`), but pin them to the actual `0.0.10` API.

**Files:**
- Create: `plugins/taskflow-github/src/adapters.rs`
- Modify: `plugins/taskflow-github/Cargo.toml` (add `umbral-oauth`, `reqwest`)
- Modify: `plugins/taskflow-github/src/lib.rs` (`Plugin::routes()` builds real deps; export `adapters`)
- Modify: `backend/Cargo.toml` (add `taskflow-github`, `umbral-oauth`)
- Modify: `backend/src/main.rs` (register `OAuthPlugin`, `TaskflowGithubPlugin`)

**Interfaces:**
- Consumes: `GithubApi` (Task 3), `GithubTokenSource` (Task 4).
- Produces: `ReqwestGithubApi` (impl `GithubApi` via GitHub REST v3), `OauthTokenSource` (impl `GithubTokenSource` via `SocialAccount`), and `TaskflowGithubPlugin::routes()` now returns the real router. The OAuth `connect`/`login`/`callback` routes come from `OAuthPlugin` in `main.rs`, not this plugin.

- [ ] **Step 1: Add deps to the plugin manifest**

In `plugins/taskflow-github/Cargo.toml` `[dependencies]` add:

```toml
umbral-oauth = "0.0.10"
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```

- [ ] **Step 2: Register the plugins in the app (do this early so `makemigrations` sees the model)**

In `backend/Cargo.toml` `[dependencies]` add:

```toml
taskflow-github = { path = "plugins/taskflow-github" }
umbral-oauth = "0.0.10"
```

In `backend/src/main.rs`:
- add `use taskflow_github::TaskflowGithubPlugin;` and `use umbral_oauth::OAuthPlugin;` and `use umbral_oauth::providers::GitHubProvider;`
- after `.plugin(TaskflowAgentsPlugin::default())` add:

```rust
        // GitHub OAuth: social login + account-linking. Requires SessionsPlugin
        // (already wired above) for the single-use `state` + PKCE.
        .plugin({
            let mut oauth = OAuthPlugin::new("http://localhost:8100");
            if let Some(gh) = GitHubProvider::from_env() {
                oauth = oauth.provider(gh);
            }
            oauth
        })
        // TaskFlow GitHub linking (publish-as-issue, comment-as-actor).
        .plugin(TaskflowGithubPlugin::default())
```

- [ ] **Step 3: Write the `reqwest` GitHub client**

`plugins/taskflow-github/src/adapters.rs`:

```rust
//! Real adapters: GitHub REST via reqwest, tokens via umbral-oauth.

use async_trait::async_trait;
use serde_json::json;

use crate::api::{GithubApi, GithubError, IssueRef, NewIssue};
use crate::tokens::GithubTokenSource;

pub struct ReqwestGithubApi {
    client: reqwest::Client,
}
impl ReqwestGithubApi {
    pub fn new() -> Self {
        Self { client: reqwest::Client::new() }
    }
}
impl Default for ReqwestGithubApi {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl GithubApi for ReqwestGithubApi {
    async fn create_issue(
        &self,
        token: &str,
        repo: &str,
        issue: NewIssue,
    ) -> Result<IssueRef, GithubError> {
        let resp = self
            .client
            .post(format!("https://api.github.com/repos/{repo}/issues"))
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "taskflow")
            .json(&json!({ "title": issue.title, "body": issue.body }))
            .send()
            .await
            .map_err(|e| GithubError::Other(e.to_string()))?;
        match resp.status().as_u16() {
            201 => {
                let v: serde_json::Value =
                    resp.json().await.map_err(|e| GithubError::Other(e.to_string()))?;
                Ok(IssueRef {
                    number: v["number"].as_i64().ok_or(GithubError::Other("no number".into()))?,
                    url: v["html_url"].as_str().unwrap_or_default().to_string(),
                })
            }
            401 => Err(GithubError::Unauthorized),
            404 => Err(GithubError::NotFound),
            s => Err(GithubError::Other(format!("github {s}"))),
        }
    }

    async fn add_comment(
        &self,
        token: &str,
        repo: &str,
        issue_number: i64,
        body: &str,
    ) -> Result<(), GithubError> {
        let resp = self
            .client
            .post(format!(
                "https://api.github.com/repos/{repo}/issues/{issue_number}/comments"
            ))
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "taskflow")
            .json(&json!({ "body": body }))
            .send()
            .await
            .map_err(|e| GithubError::Other(e.to_string()))?;
        match resp.status().as_u16() {
            201 => Ok(()),
            401 => Err(GithubError::Unauthorized),
            404 => Err(GithubError::NotFound),
            s => Err(GithubError::Other(format!("github {s}"))),
        }
    }
}

/// Reads a user's linked GitHub token from their `SocialAccount`.
pub struct OauthTokenSource;

#[async_trait]
impl GithubTokenSource for OauthTokenSource {
    async fn token_for_user(&self, user_id: i64) -> Option<String> {
        use umbral_oauth::models::{SocialAccount, social_account};
        let account = SocialAccount::objects()
            .filter(social_account::USER.eq(user_id) & social_account::PROVIDER.eq("github"))
            .first()
            .await
            .ok()??;
        // Expiry check: an expired token is treated as "not linked" so the UI
        // routes the user back through connect instead of hitting a 401.
        if let Some(expires_at) = account.expires_at {
            if expires_at < chrono::Utc::now() {
                return None;
            }
        }
        account.access_token.reveal().ok()
    }
}
```

- [ ] **Step 4: Wire real deps into `Plugin::routes()`**

In `plugins/taskflow-github/src/lib.rs`:
- add `pub mod adapters;`
- replace the stub `routes()`:

```rust
    fn routes(&self) -> Router {
        let deps = GithubDeps {
            api: Arc::new(adapters::ReqwestGithubApi::new()),
            tokens: Arc::new(adapters::OauthTokenSource),
        };
        urls::router(deps)
    }
```

- [ ] **Step 5: Build the whole workspace**

Run: `cd backend && cargo build`
Expected: PASS. If `umbral-oauth`'s real API differs (module path, `reveal()` signature, `from_env`/`provider` builder), adjust `adapters.rs` and the `main.rs` OAuth block to match the installed `0.0.10` — these are the only two files that name the crate.

- [ ] **Step 6: Run the full plugin test suite (fakes still green)**

Run: `cargo test -p taskflow-github`
Expected: PASS — the adapter task changes no behavior the fakes cover.

- [ ] **Step 7: Generate + apply migrations, smoke the routes**

Run: `cd backend && cargo run -- makemigrations` (ensures `taskflow_github/0001_auto.json` exists if Task 2 Step 7 was deferred), then `cargo run -- migrate`.
Run: `cargo run -- serve` and, in another shell, `curl -sS -X POST localhost:8100/api/taskflow/github/projects/1/tasks/1/publish` — expect `401` (unauthenticated) rather than `404`, proving the route is mounted.

- [ ] **Step 8: Commit**

```bash
git add plugins/taskflow-github backend/Cargo.toml backend/src/main.rs backend/migrations
git commit -m "feat(#25): real GitHub/OAuth adapters + wire OAuthPlugin & github plugin into app"
```

---

## Environment / config note (not a code task)

For the connect flow to function at runtime, these env vars must be set (document in the repo's env template, not committed with secrets):

```
UMBRAL_OAUTH_GITHUB_CLIENT_ID=Ov23…
UMBRAL_OAUTH_GITHUB_CLIENT_SECRET=…
UMBRAL_OAUTH_REDIRECT_BASE=http://localhost:8100   # optional; matches OAuthPlugin::new base
```

The GitHub OAuth app's callback URL must be `<base>/oauth/github/callback`, and the app must request the `repo` scope.

---

## Out of scope for this plan (follow-up: frontend plan)

The `v2_fe` UI — the "Publish as issue" button, the "Post to issue #N as me" button with its disabled/connect-prompt state, the per-project opt-in toggle, and surfacing `#N` with copy-to-clipboard on the task header — is a separate plan (`planning/plan-github-linking-frontend.md`). This backend plan delivers and API-tests every server behavior those controls call, including the `409 needs_connect { connect_url }` contract the disabled state keys on.

---

## Self-Review

**Spec coverage:**
- Spec §1 new plugin → Task 2. ✓
- Spec §2 schema deltas (project fields, task issue_number/url, per-project pref) → Task 1 + Task 2. ✓
- Spec §3 OAuth wiring (OAuthPlugin, GitHubProvider, sessions already present, `repo` scope) → Task 8. ✓
- Spec §4 key-selection table (owner vs actor, null-key disabled) → Task 4 (logic) + Task 5/6 (enforcement). ✓
- Spec §5 flow (publish with owner key + store number; comment opt-in with actor key) → Task 5 + Task 6. ✓
- Spec §6 GitHub API surface (create issue, add comment) → Task 3 (trait) + Task 8 (reqwest). ✓
- Spec acceptance criteria: owner-key publish (T5), actor-key comment (T6), disabled/needs_connect on unlinked/opted-out (T5/T6), token never serialized (Global Constraints + handlers return no token; adapter reveals server-side), expired token → needs-connect (T8 `OauthTokenSource` expiry check → `None` → `resolve_*` → NeedsConnect), null `github_linked_by` disabled (T5 second test), e2e link→publish→comment→disabled (covered across T5/T6 integration tests). ✓
- Frontend acceptance (button disabled state UI) → explicitly deferred to the frontend plan; backend contract it needs is delivered. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The one intentional marker (`taskflow_github_pref_import::*` in Task 6 Step 4) is called out in-step as a delete-me reminder with the exact real imports to use. ✓

**Type consistency:** `GithubApi::{create_issue,add_comment}`, `IssueRef{number,url}`, `NewIssue{title,body}`, `TokenOutcome::{Ready,NeedsConnect}`, `GithubTokenSource::token_for_user`, `GithubDeps{api,tokens}`, `resolve_owner_token`/`resolve_actor_token`, and field names `github_repo`/`github_linked_by`/`github_issue_number`/`post_as_me` are used identically in the tasks that define and consume them. ✓
