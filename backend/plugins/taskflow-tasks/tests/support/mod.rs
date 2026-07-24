//! Minimal test harness for the taskflow-tasks plugin, modeled on
//! `taskflow-agents/tests/support/mod.rs`.
//!
//! Unlike the agents harness this crate's tests don't need to drive HTTP
//! (no `TestClient`/`TestApp` router calls) — they exercise the ORM directly,
//! the same way the reconciler itself is triggered (a plain `Manager::save`
//! or `update_values` fires the signal `session_timer::register` subscribes
//! to). What this module provides is just `boot()` wiring and fixture seeds.
#![allow(dead_code)]

use std::sync::Arc;

use umbral::orm::ForeignKey;
use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::storage::{Storage, StorageError, StoredFile, set_storage};
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_testing::{boot, seq};

use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{TaskflowProject, TaskflowProjectStatus};
use taskflow_tasks::TaskflowTasksPlugin;
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus, taskflow_task};

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
