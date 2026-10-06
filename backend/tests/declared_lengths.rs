//! A value longer than a column's declared `max_length` must be rejected
//! **before** it reaches the database.
//!
//! The production bug: pasting a 12,617-character markdown file into a task
//! description (`varchar(12000)`) returned a 500 from `POST /api/taskflow_task/`.
//! Postgres logged `value too long for type character varying(12000)`;
//! `From<sqlx::Error> for ApiError` maps only `Error::Protocol` to a 400, so the
//! SQLSTATE-22001 error landed on the `ApiError::Sqlx` arm — a 500 whose text is
//! deliberately hidden from the client.
//!
//! ## Why this test never sees the 500
//!
//! These tests run on SQLite, which does **not** enforce `varchar(N)` — it is a
//! type affinity, not a constraint. So before the fix, an over-long value was
//! inserted happily and the test failed with "expected an error, got a row" —
//! not with a 500. That is precisely why the bug reached production: the local
//! and CI databases cannot express it.
//!
//! Asserting the *pre-DB* rejection is therefore both the honest test and the
//! stronger one: it holds on SQLite and on Postgres alike, and it pins the error
//! **variant** (`Validator`) that decides 400-vs-500 rather than a string.
//!
//! The write goes through `DynQuerySet::insert_json` — the exact function
//! `umbral-rest` calls for `POST /api/<table>/`, so this exercises the shipped
//! path, not a convenience wrapper.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::OnceCell;
use umbral::migrate::ModelMeta;
use umbral::orm::{DynQuerySet, WriteError};
use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::storage::{Storage, StorageError, StoredFile, set_storage};
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_testing::boot;

use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{TaskflowProject, TaskflowProjectStatus};
use taskflow_tasks::TaskflowTasksPlugin;
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};

/// The column this bug was reported against, and the length the pasted file was.
const DESCRIPTION_CAP: usize = 12_000;
const REPORTED_LENGTH: usize = 12_617;

/// An in-memory `Storage`, only because `TaskflowTaskAttachment` carries a
/// `FileField` and `App::build()`'s `field.storage_backend` system check fails
/// without a registered backend. This test never touches a file.
#[derive(Debug, Default)]
struct MemoryStorage;

#[umbral::async_trait]
impl Storage for MemoryStorage {
    async fn store(
        &self,
        filename: &str,
        _content_type: &str,
        bytes: &[u8],
    ) -> Result<StoredFile, StorageError> {
        let key = format!("{}-{}", umbral_testing::seq(), filename);
        Ok(StoredFile {
            url: format!("/media/{key}"),
            key,
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

struct MemoryStoragePlugin;

impl Plugin for MemoryStoragePlugin {
    fn name(&self) -> &'static str {
        "declared_lengths_memory_storage"
    }
    fn provides_storage(&self) -> bool {
        true
    }
    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        set_storage(Arc::new(MemoryStorage));
        Ok(())
    }
}

/// Boot once per test binary, then install the declared-length rule.
///
/// Guarded by a `OnceCell` of our own on top of `boot()`'s: `boot`'s cell stays
/// uninitialised if its closure panics, so without this wrapper a failing boot
/// lets the other test threads race into a second `settings::init` and report
/// *that* panic instead of the real one.
///
/// `install()` is idempotent, but it is called inside the guard so the rule is
/// registered exactly once against a process-global registry.
static BOOTED: OnceCell<()> = OnceCell::const_new();

async fn app() {
    BOOTED
        .get_or_init(|| async {
            boot(|b| {
                b.plugin(AuthPlugin::<AuthUser>::default())
                    .plugin(TaskflowProjectsPlugin)
                    .plugin(TaskflowTasksPlugin)
                    .plugin(MemoryStoragePlugin)
            })
            .await;
            backend::validation::install();
        })
        .await;
}

/// A project to hang the task off — `project` is a required FK, and the ORM's
/// pre-DB FK check would otherwise reject the insert for the wrong reason.
async fn seed_project() -> i64 {
    let n = umbral_testing::seq();
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: "Paste target".to_string(),
            slug: format!("paste-target-{n}"),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: None,
            github_repo: None,
            github_linked_by: None,
            github_default_branch: None,
            github_auto_mirror: false,
            agent_instructions_markdown: None,
            agent_instructions_updated_at: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("seed project")
        .id
}

/// A task-create body with `description_markdown` of exactly `len` characters.
fn task_body(project: i64, len: usize) -> serde_json::Map<String, serde_json::Value> {
    json!({
        "project": project,
        "title": "Paste a design doc",
        "description_markdown": "x".repeat(len),
        "status": TaskflowTaskStatus::NotStarted,
        "priority": TaskflowTaskPriority::Normal,
        "sort_order": 0,
    })
    .as_object()
    .expect("object body")
    .clone()
}

async fn insert_task(
    body: &serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Map<String, serde_json::Value>, WriteError> {
    let meta = ModelMeta::for_::<TaskflowTask>();
    DynQuerySet::for_meta(&meta).insert_json(body).await
}

/// The reported bug: 617 characters over the cap.
///
/// The assertion that matters is the **variant**: `Validator` is what
/// umbral-rest renders as a 400 with a per-field map. `Sqlx` is the 500 arm.
/// Asserting on the message alone would pass even if the error still came back
/// from the database.
#[tokio::test]
async fn a_too_long_description_is_rejected_before_the_database() {
    app().await;
    let project = seed_project().await;

    let err = insert_task(&task_body(project, REPORTED_LENGTH))
        .await
        .expect_err("12,617 characters must not reach the database");

    let WriteError::Validator { field, message } = &err else {
        panic!("must be a Validator (renders 400), got: {err:?}");
    };
    assert_eq!(field, "description_markdown");
    // The client should learn the limit and how far over it went — the same
    // wording `umbral::validate::check_max_length` uses for DTOs.
    assert!(
        message.contains(&DESCRIPTION_CAP.to_string())
            && message.contains(&REPORTED_LENGTH.to_string()),
        "message should name the limit and the actual length, got: {message}"
    );

    // And it surfaces on the field key REST clients read.
    assert!(
        err.field_errors().contains_key("description_markdown"),
        "field_errors() should key the error under the column, got: {:?}",
        err.field_errors()
    );

    // Nothing was written — the rejection happened before the INSERT, which is
    // the whole point (a post-DB rejection would have rolled back, but on
    // Postgres it would first have raised the 500 that started this).
    let rows = TaskflowTask::objects()
        .filter(taskflow_tasks::models::taskflow_task::PROJECT.eq(project))
        .count()
        .await
        .expect("count tasks");
    assert_eq!(rows, 0, "the rejected task must not exist");
}

/// The boundary: exactly at the cap is legal.
///
/// `varchar(12000)` holds 12,000 characters, so an off-by-one here would reject
/// a value Postgres accepts. Also guards the character-vs-byte question —
/// `max_length` counts characters, and so must the check.
#[tokio::test]
async fn a_description_exactly_at_the_cap_is_accepted() {
    app().await;
    let project = seed_project().await;

    let row = insert_task(&task_body(project, DESCRIPTION_CAP))
        .await
        .expect("exactly 12,000 characters is within the cap");
    assert_eq!(
        row.get("description_markdown")
            .and_then(|v| v.as_str())
            .map(str::chars)
            .map(Iterator::count),
        Some(DESCRIPTION_CAP)
    );
}

/// One character over is rejected — the other half of the boundary.
#[tokio::test]
async fn a_description_one_character_over_the_cap_is_rejected() {
    app().await;
    let project = seed_project().await;

    let err = insert_task(&task_body(project, DESCRIPTION_CAP + 1))
        .await
        .expect_err("12,001 characters is one over the cap");
    assert!(
        matches!(err, WriteError::Validator { .. }),
        "must be a Validator (renders 400), got: {err:?}"
    );
}

/// Each field is held to **its own** declared cap.
///
/// This is the test that pins the design decision: the cap comes from the
/// field's metadata, not from one global constant. `TaskflowTask` declares
/// `description_markdown` at 12,000 and `review_gate` at 4,000 — a rule that
/// used a single number would pass the 12,000 case by accident and let a
/// 4,001-character review gate through to a `varchar(4000)` column.
#[tokio::test]
async fn each_field_uses_its_own_declared_cap() {
    app().await;
    let project = seed_project().await;

    // 4,000 characters in the review gate: fine.
    let mut body = task_body(project, 32);
    body.insert("review_gate".to_string(), json!("r".repeat(4_000)));
    insert_task(&body)
        .await
        .expect("4,000 characters is exactly the review_gate cap");

    // 4,001: over the review gate's cap, and well under the description's.
    let mut body = task_body(project, 32);
    body.insert("review_gate".to_string(), json!("r".repeat(4_001)));
    let err = insert_task(&body)
        .await
        .expect_err("4,001 characters is over the review_gate cap");
    assert_eq!(
        err.field_errors().keys().collect::<Vec<_>>(),
        vec!["review_gate"],
        "the error must name review_gate, not description_markdown"
    );

    // An absent optional field is not a failure — adding a cleaner must not
    // turn "not sent" into an error. (`description_markdown` is NOT NULL on this
    // model, so it is the wrong field to prove that with.)
    let mut body = task_body(project, 32);
    body.remove("review_gate");
    insert_task(&body)
        .await
        .expect("an absent review_gate is legal");
}
