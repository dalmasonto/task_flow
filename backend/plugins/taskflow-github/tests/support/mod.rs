#![allow(dead_code, unused_imports)]
//! Test harness for the taskflow-github plugin — mirrors the projects harness,
//! plus injected GitHub/OAuth fakes so route tests run with no network.
//!
//! `boot()` stands up one in-process app per test against a throwaway SQLite DB
//! (schema derived from the plugins' models). The token source (which user has
//! which GitHub token) is baked into the router at construction, so each
//! constructor creates its primary user first, then wires that user's id into
//! a `FakeTokenSource` before building the router.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::storage::{Storage, StorageError, StoredFile, set_storage};
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot, seq};

/// In-memory Storage backend: `TaskflowTaskAttachment` carries a `FileField`,
/// so the boot `field.storage_backend` system check fails unless some plugin
/// provides a backend. This is that plugin (mirrors the agents harness).
#[derive(Debug, Default)]
struct MemoryStorage;

#[umbral::storage::async_trait]
impl Storage for MemoryStorage {
    async fn store(
        &self,
        filename: &str,
        _content_type: &str,
        bytes: &[u8],
    ) -> Result<StoredFile, StorageError> {
        let key = format!("{}-{}", seq(), filename);
        Ok(StoredFile { key: key.clone(), url: format!("/media/{key}"), size: bytes.len() as u64 })
    }
    async fn retrieve(&self, _key: &str) -> Result<Vec<u8>, StorageError> {
        Err(StorageError::NotFound)
    }
    async fn delete(&self, _key: &str) -> Result<(), StorageError> {
        Ok(())
    }
    fn url(&self, key: &str) -> String {
        format!("/media/{key}")
    }
}

struct MediaTestPlugin;
impl Plugin for MediaTestPlugin {
    fn name(&self) -> &'static str {
        "mem_media_test"
    }
    fn provides_storage(&self) -> bool {
        true
    }
    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        set_storage(Arc::new(MemoryStorage));
        Ok(())
    }
}

use taskflow_github::api::FakeGithubApi;
use taskflow_github::models::{TaskflowGithubPref, taskflow_github_pref};
use taskflow_github::tokens::FakeTokenSource;
use taskflow_github::{GithubDeps, TaskflowGithubPlugin};
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus, taskflow_project,
};
use taskflow_tasks::TaskflowTasksPlugin;
use taskflow_tasks::models::{
    TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus, taskflow_task,
};

/// The scripted issue number the fake GitHub API returns for `create_issue`.
pub const FAKE_ISSUE_NUMBER: i64 = 7;

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
    bearer: Mutex<HashMap<i64, String>>,
    api: Arc<FakeGithubApi>,
    primary: Option<TestUser>,
}

async fn boot_plugins() {
    boot(|b| {
        b.plugin(AuthPlugin::<AuthUser>::default())
            .plugin(TaskflowProjectsPlugin)
            .plugin(TaskflowTasksPlugin)
            .plugin(TaskflowGithubPlugin)
            .plugin(MediaTestPlugin)
    })
    .await;
}

/// Create a real `AuthUser` + mint a real bearer token. Free helper so a
/// constructor can create the primary user before the `TestApp` exists.
async fn make_user() -> (TestUser, String) {
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
    (TestUser { id: user.id, email }, plaintext.0)
}

impl TestApp {
    fn assemble(client: TestClient, api: Arc<FakeGithubApi>, primary: Option<(TestUser, String)>) -> Self {
        let mut bearer = HashMap::new();
        let primary_user = primary.map(|(u, tok)| {
            bearer.insert(u.id, tok);
            u
        });
        Self { client, bearer: Mutex::new(bearer), api, primary: primary_user }
    }

    /// No GitHub tokens for anyone. Used by pure-ORM / pref tests that never
    /// resolve a token.
    pub async fn new() -> Self {
        boot_plugins().await;
        let api = Arc::new(FakeGithubApi::returning(FAKE_ISSUE_NUMBER, "https://github.com/x/y/issues/7"));
        let deps = GithubDeps { api: api.clone(), tokens: Arc::new(FakeTokenSource::new()) };
        let client = TestClient::new(taskflow_github::urls::router(deps));
        Self::assemble(client, api, None)
    }

    /// A primary "owner" user whose linked GitHub token is `gh_token`.
    pub async fn with_owner_token(gh_token: &str) -> Self {
        Self::with_primary(gh_token, true).await
    }

    /// A primary "owner" user with NO linked GitHub token (owner-key absent).
    pub async fn with_no_tokens() -> Self {
        Self::with_primary("", false).await
    }

    /// A primary user (labelled by the caller via `user(..)`) whose linked
    /// GitHub token is `gh_token`.
    pub async fn with_user_token(_label: &str, gh_token: &str) -> Self {
        Self::with_primary(gh_token, true).await
    }

    async fn with_primary(gh_token: &str, has_token: bool) -> Self {
        boot_plugins().await;
        let (user, bearer) = make_user().await;
        let mut tokens = FakeTokenSource::new();
        if has_token {
            tokens = tokens.with(user.id, gh_token);
        }
        let api = Arc::new(FakeGithubApi::returning(
            FAKE_ISSUE_NUMBER,
            "https://github.com/acme/widgets/issues/7",
        ));
        let deps = GithubDeps { api: api.clone(), tokens: Arc::new(tokens) };
        let client = TestClient::new(taskflow_github::urls::router(deps));
        Self::assemble(client, api, Some((user, bearer)))
    }

    /// The primary user (owner in publish tests).
    pub fn owner_user(&self) -> TestUser {
        self.primary.clone().expect("no primary user")
    }
    /// The primary user (label is illustrative — there is one primary).
    pub fn user(&self, _label: &str) -> TestUser {
        self.primary.clone().expect("no primary user")
    }

    /// General user factory for tests that need an ad-hoc user (pure ORM tests).
    pub async fn create_user(&self) -> TestUser {
        let (user, bearer) = make_user().await;
        self.bearer.lock().unwrap().insert(user.id, bearer);
        user
    }

    fn set_auth(&self, user_id: i64) {
        let token = self.bearer.lock().unwrap().get(&user_id).cloned().unwrap();
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

    pub fn api_created_issues(&self) -> Vec<(String, String, taskflow_github::api::NewIssue)> {
        self.api.created_issues()
    }
    pub fn api_comments(&self) -> Vec<(String, String, i64, String)> {
        self.api.comments()
    }

    /// The stored `github_issue_number` on a task, or `None`.
    pub async fn task_issue_number(&self, task: i64) -> Option<i64> {
        TaskflowTask::objects()
            .filter(taskflow_task::ID.eq(task))
            .first()
            .await
            .expect("load task")
            .expect("task exists")
            .github_issue_number
    }
}

// --- seed helpers ----------------------------------------------------------

pub async fn seed_project() -> i64 {
    seed_project_inner(None, None).await
}

/// A GitHub-linked project: `github_repo` + `github_linked_by` set.
pub async fn seed_project_linked(linked_by: i64, repo: &str) -> i64 {
    seed_project_inner(Some(linked_by), Some(repo.to_string())).await
}

async fn seed_project_inner(linked_by: Option<i64>, repo: Option<String>) -> i64 {
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
            owner: linked_by.map(ForeignKey::new),
            github_repo: repo,
            github_linked_by: linked_by.map(ForeignKey::new),
            github_default_branch: None,
            github_auto_mirror: false,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

pub async fn seed_task(project: i64, title: &str) -> i64 {
    seed_task_inner(project, title, None).await
}

pub async fn seed_task_with_issue(project: i64, title: &str, number: i64) -> i64 {
    seed_task_inner(project, title, Some(number)).await
}

async fn seed_task_inner(project: i64, title: &str, issue_number: Option<i64>) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: title.to_string(),
            description_markdown: "desc".to_string(),
            notes_markdown: None,
            status: TaskflowTaskStatus::NotStarted,
            priority: TaskflowTaskPriority::Normal,
            sort_order: 0,
            created_by: None,
            assigned_user: None,
            assigned_agent_id: None,
            review_gate: None,
            estimate_minutes: None,
            operator_user: None,
            operator_agent_id: None,
            created_by_agent_id: None,
            assignee_label: None,
            due_at: None,
            closed_at: None,
            github_issue_number: issue_number,
            github_issue_url: issue_number.map(|n| format!("https://github.com/acme/widgets/issues/{n}")),
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task")
        .id
}

/// Seed an active project membership at a given role, so the link endpoint's
/// owner/admin authorization can be exercised.
pub async fn seed_member(project: i64, user_id: i64, role: TaskflowProjectRole) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user_id}"),
            user: Some(ForeignKey::new(user_id)),
            display_name: format!("user-{user_id}"),
            email: None,
            role,
            status: TaskflowMembershipStatus::Active,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create member");
}

/// The stored `(github_repo, github_linked_by)` of a project.
pub async fn project_github_link(project: i64) -> (Option<String>, Option<i64>) {
    let p = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .first()
        .await
        .expect("load project")
        .expect("project exists");
    (p.github_repo, p.github_linked_by.map(|fk| fk.id()))
}

pub async fn seed_pref(user: i64, project: i64, post_as_me: bool) {
    TaskflowGithubPref::objects()
        .create(TaskflowGithubPref {
            id: 0,
            user: ForeignKey::new(user),
            project: ForeignKey::new(project),
            post_as_me,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create pref");
}
