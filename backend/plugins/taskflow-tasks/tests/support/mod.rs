//! Minimal test harness for the taskflow-tasks plugin, modeled on
//! `taskflow-agents/tests/support/mod.rs`.
//!
//! Most of this crate's tests exercise the ORM directly — the same way the
//! reconciler itself is triggered (a plain `Manager::save` or `update_values`
//! fires the signal `session_timer::register` subscribes to) — and never need
//! HTTP. `project_stats.rs` is the exception: it drives the real
//! `/api/taskflow/projects/{project}/stats` route (auth + project scoping +
//! query parsing all matter there), so this module also provides the
//! `TestApp`/`TestClient` wiring `taskflow-agents`'s harness pioneered, scoped
//! to `taskflow_tasks::urls::router()`.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::Value;
use umbral::orm::ForeignKey;
use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::storage::{Storage, StorageError, StoredFile, set_storage};
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot, seq};

use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};
use taskflow_tasks::TaskflowTasksPlugin;
use taskflow_tasks::models::{
    TaskflowActorKind, TaskflowSessionState, TaskflowTask, TaskflowTaskActivity,
    TaskflowTaskPriority, TaskflowTaskSession, TaskflowTaskStatus, taskflow_task,
};

/// An in-memory `Storage` backend for the test harness. `TaskflowTaskAttachment`
/// carries a `FileField`, so `App::build()`'s `field.storage_backend` system
/// check fails unless *some* plugin provides a backend — this is that plugin.
/// Copied from the taskflow-agents harness; nothing in these tests reads the
/// bytes back.
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
        let url = format!("/media/{key}");
        Ok(StoredFile {
            key,
            url,
            size: bytes.len() as u64,
        })
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

/// Boot the app once per test binary (idempotent, see `umbral_testing::boot`).
/// Registers exactly the plugins `TaskflowTasksPlugin` depends on, so
/// `session_timer::register()` runs via `on_ready` and the signal subscriptions
/// are live before any test writes a task.
pub async fn init() {
    boot(|b| {
        b.plugin(AuthPlugin::<AuthUser>::default())
            .plugin(TaskflowProjectsPlugin)
            .plugin(TaskflowTasksPlugin)
            .plugin(MediaTestPlugin)
    })
    .await;
    taskflow_tasks::session_timer::install_open_session_guard(umbral::db::pool_dispatched())
        .await
        .expect("install task session guard");
}

/// Seed a project, returning its id.
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
            github_auto_mirror: false,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

/// Seed a `not_started` task in `project`, returning its id.
pub async fn seed_task(project: i64) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: "Reconcile task".to_string(),
            description_markdown: String::new(),
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
            github_issue_number: None,
            github_issue_url: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task")
        .id
}

/// Seed a `not_started` task with an operator set — either a user (pass
/// `operator_user: Some(id)`) or an agent (`operator_agent_id: Some(id)`), or
/// neither for a task that is genuinely un-operated. `project_stats`'s
/// `task_operators` map reads exactly these two fields to decide who a
/// `system` session's time gets credited to.
///
/// Status is `not_started`, deliberately NOT `in_progress` — the latter would
/// fire the `session_timer` reconciler and auto-open its own (unwanted,
/// still-running) System session on this task, on top of whatever the test
/// seeds explicitly.
pub async fn seed_task_with_operator(
    project: i64,
    operator_user: Option<i64>,
    operator_agent_id: Option<i64>,
) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: "Operated task".to_string(),
            description_markdown: String::new(),
            notes_markdown: None,
            status: TaskflowTaskStatus::NotStarted,
            priority: TaskflowTaskPriority::Normal,
            sort_order: 0,
            created_by: None,
            assigned_user: None,
            assigned_agent_id: None,
            review_gate: None,
            estimate_minutes: None,
            operator_user: operator_user.map(ForeignKey::new),
            operator_agent_id,
            created_by_agent_id: None,
            assignee_label: None,
            due_at: None,
            closed_at: None,
            github_issue_number: None,
            github_issue_url: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create operated task")
        .id
}

/// Load a task fresh by id.
pub async fn load_task(task_id: i64) -> TaskflowTask {
    TaskflowTask::objects()
        .get(taskflow_task::ID.eq(task_id))
        .await
        .expect("load task")
}

/// Move a task's status via `Manager::save` — the write path that fires
/// `post_save:taskflow_task`, which `session_timer::register` subscribes to.
/// Reloads first so callers can chain status moves without hand-tracking the
/// row's other fields.
pub async fn set_status(task_id: i64, status: TaskflowTaskStatus) {
    let mut task = load_task(task_id).await;
    task.status = status;
    TaskflowTask::objects()
        .save(task)
        .await
        .expect("save status");
}

/// Create a task that is ALREADY `done` with `closed_at` pinned to an exact
/// timestamp, for tests that need to control which day a task lands in.
///
/// Going through `set_status` would stamp `closed_at = Utc::now()` (that's
/// the reconciler's job) with no way to backdate it. Creating the row
/// directly with `closed_at` already `Some(..)` sidesteps that: `.create()`
/// still fires `post_save:taskflow_task` (see `session_timer::reconcile`'s
/// `is_terminal && closed_at.is_none()` guard), but since `closed_at` is
/// already set, the reconciler's guard is false and it leaves the value
/// alone — the row keeps exactly the timestamp this function supplies.
pub async fn seed_closed_task(project: i64, closed_at: chrono::DateTime<chrono::Utc>) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: "Closed task".to_string(),
            description_markdown: String::new(),
            notes_markdown: None,
            status: TaskflowTaskStatus::Done,
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
            closed_at: Some(closed_at),
            github_issue_number: None,
            github_issue_url: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create closed task")
        .id
}

/// Seed a `TaskflowTaskSession` directly (bypassing the session-timer
/// reconciler entirely — `project_stats` only cares about the row itself,
/// not how it came to exist). `started_at` and `duration_seconds` are the
/// two fields the stats endpoint's `worked_per_member`/`active_members`
/// aggregation reads, so both are caller-controlled.
#[allow(clippy::too_many_arguments)]
pub async fn seed_session(
    project: i64,
    task: i64,
    actor_kind: TaskflowActorKind,
    actor_user: Option<i64>,
    actor_agent_id: Option<i64>,
    actor_label: &str,
    started_at: chrono::DateTime<chrono::Utc>,
    duration_seconds: Option<i64>,
) -> i64 {
    TaskflowTaskSession::objects()
        .create(TaskflowTaskSession {
            id: 0,
            project: ForeignKey::new(project),
            task: ForeignKey::new(task),
            state: TaskflowSessionState::Stopped,
            actor_kind,
            actor_user: actor_user.map(ForeignKey::new),
            actor_agent_id,
            actor_label: actor_label.to_string(),
            started_at,
            ended_at: duration_seconds.map(|d| started_at + chrono::Duration::seconds(d)),
            duration_seconds,
            summary_markdown: None,
            created_at: None,
        })
        .await
        .expect("create session")
        .id
}

/// Seed a `TaskflowTaskActivity` row directly. `created_at` is `auto_now_add`
/// (server-stamped to "now" regardless of what's supplied), which is fine for
/// `project_stats`: every range cutoff this endpoint supports is in the past,
/// so a freshly-created activity row is always in range.
pub async fn seed_activity(
    project: i64,
    task: i64,
    actor_kind: TaskflowActorKind,
    actor_user: Option<i64>,
    actor_agent_id: Option<i64>,
    actor_label: &str,
    action: &str,
) -> i64 {
    TaskflowTaskActivity::objects()
        .create(TaskflowTaskActivity {
            id: 0,
            project: ForeignKey::new(project),
            task: Some(ForeignKey::new(task)),
            actor_kind,
            actor_user: actor_user.map(ForeignKey::new),
            actor_agent_id,
            actor_label: actor_label.to_string(),
            action: action.to_string(),
            body_markdown: None,
            metadata_json: None,
            created_at: None,
        })
        .await
        .expect("create activity")
        .id
}

/// Make `user` an ACTIVE `TaskflowProjectMember` of `project` — the row
/// `can_access_project` checks. Without this, `GET .../stats` 404s the
/// caller exactly like a real non-member.
pub async fn seed_active_member(project: i64, user: i64) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user}"),
            user: Some(ForeignKey::new(user)),
            display_name: format!("Member {user}"),
            email: None,
            role: TaskflowProjectRole::Developer,
            status: TaskflowMembershipStatus::Active,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create active project member");
}

/// One round trip against the plugin's own router. Thin wrapper over
/// `umbral_testing::TestResponse`, mirroring the agents harness's
/// `TestResponse` shape.
pub struct TestResponse {
    inner: umbral_testing::TestResponse,
}

impl TestResponse {
    pub fn status(&self) -> u16 {
        self.inner.status().as_u16()
    }

    /// Parse the body as JSON. Panics with the raw body on a parse error,
    /// which is what you want to read when a handler 500s.
    pub async fn json(&self) -> Value {
        self.inner.body_json()
    }
}

/// Drives `taskflow_tasks::urls::router()` in-process, authenticating GETs
/// with a real bearer token the way `taskflow-agents`'s `TestApp` does for
/// POSTs — so `project_stats.rs` exercises the framework's genuine auth
/// chain (`RequireAuth`) rather than a stub identity.
pub struct TestApp {
    client: TestClient,
    tokens: Mutex<HashMap<i64, String>>,
}

impl TestApp {
    /// Boots the app (idempotent, safe alongside a prior/later `init()` call)
    /// and wraps this plugin's router in a `TestClient`.
    pub async fn new() -> Self {
        init().await;
        Self {
            client: TestClient::new(taskflow_tasks::urls::router()),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Create a real `AuthUser` and mint a real bearer token for it.
    pub async fn create_user(&self) -> i64 {
        let n = seq();
        let user = AuthUser::objects()
            .create(AuthUser {
                id: 0,
                username: format!("user-{n}"),
                email: format!("user-{n}@example.test"),
                password_hash: "unused-tests-authenticate-by-token".to_string(),
                is_active: true,
                is_staff: false,
                is_superuser: false,
                date_joined: chrono::Utc::now(),
                last_login: None,
                email_verified_at: None,
            })
            .await
            .expect("create AuthUser");

        let (_, plaintext) = AuthToken::create_for(&user, "test")
            .await
            .expect("mint bearer token");
        self.tokens
            .lock()
            .expect("tokens poisoned")
            .insert(user.id, plaintext.0);

        user.id
    }

    /// GET `path` authenticated as `user_id`.
    pub async fn get_as(&self, user_id: i64, path: &str) -> TestResponse {
        let token = self
            .tokens
            .lock()
            .expect("tokens poisoned")
            .get(&user_id)
            .cloned()
            .unwrap_or_else(|| panic!("no bearer token seeded for user {user_id}"));

        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
        );

        TestResponse {
            inner: self.client.get(path).await,
        }
    }
}
