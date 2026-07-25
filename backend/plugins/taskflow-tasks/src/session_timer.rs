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

use umbral::orm::ForeignKey;

use crate::models::{
    TaskflowActorKind, TaskflowSessionState, TaskflowTask, TaskflowTaskSession, TaskflowTaskStatus,
    taskflow_task, taskflow_task_session,
};

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

    let open: Vec<TaskflowTaskSession> = match TaskflowTaskSession::objects()
        .filter(taskflow_task_session::TASK.eq(task_id))
        .fetch()
        .await
    {
        Ok(rows) => rows.into_iter().filter(|s| s.ended_at.is_none()).collect(),
        Err(_) => return,
    };

    // Keep `closed_at` in lockstep with terminal status, idempotently. Setting
    // it re-fires post_save → reconcile, but the guards below make the second
    // pass a no-op, so it terminates. Done as its own task write so it is
    // independent of the session bookkeeping below.
    let is_terminal = matches!(
        task.status,
        TaskflowTaskStatus::Done | TaskflowTaskStatus::Archived
    );
    if is_terminal && task.closed_at.is_none() {
        let mut t = task.clone();
        t.closed_at = Some(chrono::Utc::now());
        if let Err(err) = TaskflowTask::objects().save(t).await {
            tracing::warn!(task_id, ?err, "failed to stamp closed_at on task");
        }
    } else if !is_terminal && task.closed_at.is_some() {
        let mut t = task.clone();
        t.closed_at = None;
        if let Err(err) = TaskflowTask::objects().save(t).await {
            tracing::warn!(task_id, ?err, "failed to clear closed_at on task");
        }
    }

    if task.status == TaskflowTaskStatus::InProgress {
        // Only open a session when none is already running (covers a manually
        // started one too — it counts as open, so we don't stack a second).
        if open.is_empty() {
            let now = chrono::Utc::now();
            let _ = TaskflowTaskSession::objects()
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
                .await;
        }
    } else {
        // Left in_progress: close whatever is open (system- or human-started).
        for mut session in open {
            let now = chrono::Utc::now();
            session.duration_seconds = Some((now - session.started_at).num_seconds());
            session.ended_at = Some(now);
            session.state = TaskflowSessionState::Stopped;
            let _ = TaskflowTaskSession::objects().save(session).await;
        }
    }
}
