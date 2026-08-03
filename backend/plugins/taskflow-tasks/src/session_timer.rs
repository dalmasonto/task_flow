//! System-driven task session timer (#23).
//!
//! A task's work session (`taskflow_task_session`) should track time spent in
//! `in_progress` WITHOUT anyone remembering to press start/stop. Instead of
//! trusting the agent or the dashboard to open and close sessions, the system
//! reconciles them from the task's status on every write.
//!
//! ## Why two signals
//!
//! Task status is written through two different ORM paths that emit DIFFERENT
//! signals, so a single-signal hook would miss half the traffic:
//!
//! - `Manager::save` — the MCP agent status handler and `apply_review` — fires
//!   `post_save:taskflow_task` (payload carries the full `instance`).
//! - a queryset `update_values` — what umbral-rest's dashboard PATCH runs, i.e.
//!   every board drag / edit — fires `bulk_post_save:taskflow_task` (payload
//!   carries only `ids`).
//!
//! Both are subscribed here and funnel into one idempotent [`reconcile`].
//!
//! ## Reconcile rule
//!
//! - `in_progress` and no open session → open one (attributed to the System).
//! - `in_progress` and a session already open → do nothing.
//! - any other status → close every open session (stamp `ended_at`, duration).
//!
//! Stateless: it never needs the previous status, so a repeated `in_progress`
//! write opens no duplicate and a status write is safe to replay.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use umbral::db::DbPool;
use umbral::orm::ForeignKey;

use crate::models::{
    TaskflowActorKind, TaskflowSessionState, TaskflowTask, TaskflowTaskSession, TaskflowTaskStatus,
    taskflow_task, taskflow_task_session,
};

const ONE_OPEN_SESSION_INDEX: &str = "taskflow_task_session_one_open_per_task";
const ONE_OPEN_SESSION_INDEX_SQL: &str = "CREATE UNIQUE INDEX IF NOT EXISTS taskflow_task_session_one_open_per_task ON taskflow_task_session (task) WHERE ended_at IS NULL";
const CLOSE_DUPLICATE_OPEN_SESSIONS_SQL: &str = r#"
WITH ranked_open_sessions AS (
    SELECT
        id,
        ROW_NUMBER() OVER (PARTITION BY task ORDER BY started_at ASC, id ASC) AS rn
    FROM taskflow_task_session
    WHERE ended_at IS NULL
)
UPDATE taskflow_task_session
SET
    ended_at = started_at,
    duration_seconds = 0,
    state = 'stopped',
    summary_markdown = 'Closed automatically because another session was already open for this task.'
WHERE id IN (SELECT id FROM ranked_open_sessions WHERE rn > 1)
"#;

/// Process-local serialization for task timer reconciliation. The database
/// index below is the durable guard; this lock keeps this backend process from
/// producing an avoidable unique-constraint race when two task-write signals for
/// the same task arrive together.
static RECONCILE_LOCKS: LazyLock<Mutex<HashMap<i64, Arc<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn reconcile_lock(task_id: i64) -> OwnedMutexGuard<()> {
    let lock = {
        let mut locks = RECONCILE_LOCKS
            .lock()
            .expect("task session reconcile lock poisoned");
        locks
            .entry(task_id)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    lock.lock_owned().await
}

/// Install the durable database invariant for focused-work sessions.
///
/// The ORM cannot express a partial unique index, but both supported backends
/// accept this syntax. Cleanup runs first so an existing duplicate-open state
/// from an older build cannot make startup fail.
pub async fn install_open_session_guard(pool: &DbPool) -> Result<(), sqlx::Error> {
    match pool {
        DbPool::Sqlite(pool) => {
            if let Err(err) = sqlx::query(CLOSE_DUPLICATE_OPEN_SESSIONS_SQL)
                .execute(pool)
                .await
            {
                if is_missing_session_table(&err) {
                    tracing::debug!("task session guard deferred until schema exists");
                    return Ok(());
                }
                return Err(err);
            }
            sqlx::query(ONE_OPEN_SESSION_INDEX_SQL)
                .execute(pool)
                .await?;
        }
        DbPool::Postgres(pool) => {
            if let Err(err) = sqlx::query(CLOSE_DUPLICATE_OPEN_SESSIONS_SQL)
                .execute(pool)
                .await
            {
                if is_missing_session_table(&err) {
                    tracing::debug!("task session guard deferred until schema exists");
                    return Ok(());
                }
                return Err(err);
            }
            sqlx::query(ONE_OPEN_SESSION_INDEX_SQL)
                .execute(pool)
                .await?;
        }
    }
    tracing::info!(
        index = ONE_OPEN_SESSION_INDEX,
        "task session guard installed"
    );
    Ok(())
}

fn is_missing_session_table(err: &sqlx::Error) -> bool {
    let sqlx::Error::Database(db) = err else {
        return false;
    };
    let message = db.message();
    message.contains("no such table: taskflow_task_session")
        || message.contains("relation \"taskflow_task_session\" does not exist")
}

/// Register the task-session reconciler on both task write signals. Called once
/// from `TaskflowTasksPlugin::on_ready`.
pub fn register() {
    // Manager::save path: MCP status handler, apply_review.
    umbral::signals::subscribe_async("post_save:taskflow_task", |payload| {
        let id = payload["instance"]["id"].as_i64();
        async move {
            if let Some(id) = id {
                reconcile(id).await;
            }
        }
    });

    // Queryset update / create path: umbral-rest dashboard PATCH and POST.
    umbral::signals::subscribe_async("bulk_post_save:taskflow_task", |payload| {
        let ids: Vec<i64> = payload["ids"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect())
            .unwrap_or_default();
        async move {
            for id in ids {
                reconcile(id).await;
            }
        }
    });
}

/// Bring a single task's sessions in line with its current status. Loads the
/// task fresh (both signals fire after the write commits), so it reads the new
/// status regardless of which path triggered it.
async fn reconcile(task_id: i64) {
    let task = match TaskflowTask::objects()
        .get(taskflow_task::ID.eq(task_id))
        .await
    {
        Ok(task) => task,
        // Row gone between the write and this handler — nothing to reconcile.
        Err(_) => return,
    };

    // Keep `closed_at` in lockstep with terminal status, idempotently. Setting
    // it re-fires post_save → reconcile, but the guards below make the second
    // pass a no-op, so it terminates. Done as its own task write so it is
    // independent of the session bookkeeping below.
    reconcile_closed_at(&task).await;

    let _guard = reconcile_lock(task_id).await;

    // Reload after the optional closed_at write above. That write fires its own
    // reconcile and may already have completed the session work before this
    // outer call gets the lock.
    let task = match TaskflowTask::objects()
        .get(taskflow_task::ID.eq(task_id))
        .await
    {
        Ok(task) => task,
        Err(_) => return,
    };

    let mut open: Vec<TaskflowTaskSession> = match TaskflowTaskSession::objects()
        .filter(taskflow_task_session::TASK.eq(task_id))
        .fetch()
        .await
    {
        Ok(rows) => rows.into_iter().filter(|s| s.ended_at.is_none()).collect(),
        Err(_) => return,
    };
    open.sort_by_key(|s| (s.started_at, s.id));

    if task.status == TaskflowTaskStatus::InProgress {
        // Defensive repair for historical/manual duplicate-open rows. Keep the
        // oldest session active and close the rest quickly; the DB partial
        // unique index prevents new duplicates from being inserted.
        if open.len() > 1 {
            let duplicates = open.split_off(1);
            for session in duplicates {
                close_session(
                    session,
                    TaskflowSessionState::Stopped,
                    duplicate_session_summary(),
                )
                .await;
            }
        }
        // Only open a session when none is already running (covers a manually
        // started one too — it counts as open, so we don't stack a second).
        if open.is_empty() {
            let now = chrono::Utc::now();
            if let Err(err) = TaskflowTaskSession::objects()
                .create(TaskflowTaskSession {
                    id: 0,
                    project: task.project.clone(),
                    task: ForeignKey::new(task_id),
                    state: TaskflowSessionState::Running,
                    actor_kind: TaskflowActorKind::System,
                    actor_user: None,
                    actor_agent_id: None,
                    actor_label: "System".to_string(),
                    started_at: now,
                    ended_at: None,
                    duration_seconds: None,
                    summary_markdown: Some(
                        "Auto-started when the task entered in progress.".to_string(),
                    ),
                    created_at: None,
                })
                .await
            {
                // The partial unique index is the final authority. If another
                // backend instance inserted first, the next reconcile pass will
                // observe it; do not panic the signal handler.
                tracing::debug!(
                    task_id,
                    ?err,
                    "task session auto-open skipped after concurrent insert"
                );
            }
        }
    } else {
        // Left in_progress: close whatever is open (system- or human-started).
        let summary = close_summary_for(task.status);
        for session in open {
            close_session(session, TaskflowSessionState::Stopped, summary.clone()).await;
        }
    }
}

async fn reconcile_closed_at(task: &TaskflowTask) {
    let is_terminal = matches!(
        task.status,
        TaskflowTaskStatus::Done | TaskflowTaskStatus::Archived
    );
    if is_terminal && task.closed_at.is_none() {
        let mut t = task.clone();
        t.closed_at = Some(chrono::Utc::now());
        if let Err(err) = TaskflowTask::objects().save(t).await {
            tracing::warn!(task_id = task.id, ?err, "failed to stamp closed_at on task");
        }
    } else if !is_terminal && task.closed_at.is_some() {
        let mut t = task.clone();
        t.closed_at = None;
        if let Err(err) = TaskflowTask::objects().save(t).await {
            tracing::warn!(task_id = task.id, ?err, "failed to clear closed_at on task");
        }
    }
}

fn close_summary_for(status: TaskflowTaskStatus) -> String {
    match status {
        TaskflowTaskStatus::Paused => {
            "Paused focused work because the task left in progress.".to_string()
        }
        TaskflowTaskStatus::Blocked => {
            "Stopped focused work because the task was marked blocked.".to_string()
        }
        TaskflowTaskStatus::PartialDone => {
            "Stopped focused work because the task was marked ready for review.".to_string()
        }
        TaskflowTaskStatus::Done => {
            "Stopped focused work because the task was marked done.".to_string()
        }
        TaskflowTaskStatus::Archived => {
            "Stopped focused work because the task was archived.".to_string()
        }
        TaskflowTaskStatus::NotStarted => {
            "Stopped focused work because the task returned to not started.".to_string()
        }
        TaskflowTaskStatus::InProgress => "Stopped duplicate focused work session.".to_string(),
    }
}

fn duplicate_session_summary() -> String {
    "Stopped duplicate focused work session; another session remained active for this task."
        .to_string()
}

async fn close_session(
    mut session: TaskflowTaskSession,
    state: TaskflowSessionState,
    summary_markdown: String,
) {
    let now = chrono::Utc::now();
    session.duration_seconds = Some((now - session.started_at).num_seconds().max(0));
    session.ended_at = Some(now);
    session.state = state;
    session.summary_markdown = Some(summary_markdown);
    if let Err(err) = TaskflowTaskSession::objects().save(session).await {
        tracing::warn!(?err, "failed to close task session during reconcile");
    }
}
