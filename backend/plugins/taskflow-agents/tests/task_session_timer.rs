//! System-driven task session timer (#23). Moving a task INTO `in_progress`
//! opens exactly one work session; moving it to any other status closes the
//! active session. The logic is an ORM-signal reconciler registered in
//! `TaskflowTasksPlugin::on_ready`, so it must fire on BOTH write paths:
//!
//! - `Manager::save` (the agent status handler, `apply_review`) → `post_save`.
//! - a queryset `update_values` (what umbral-rest's dashboard PATCH does) →
//!   `bulk_post_save`.
//!
//! A `post_save`-only hook would miss every human board move, so both paths are
//! tested explicitly.

use serde_json::{Map, Value};

mod support;
use support::{TestApp, seed_project};

use taskflow_tasks::models::{
    TaskflowActorKind, TaskflowSessionState, TaskflowTask, TaskflowTaskSession, TaskflowTaskStatus,
    taskflow_task, taskflow_task_session,
};

/// Seed a `not_started` task in `project`, returning its id.
async fn seed_task(project: i64) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: umbral::orm::ForeignKey::new(project),
            title: "Timer task".to_string(),
            description_markdown: String::new(),
            notes_markdown: None,
            status: TaskflowTaskStatus::NotStarted,
            priority: taskflow_tasks::models::TaskflowTaskPriority::Normal,
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
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task")
        .id
}

/// Move a task's status via `Manager::save` — the agent / apply_review path
/// that fires `post_save:taskflow_task`.
async fn save_status(task_id: i64, status: TaskflowTaskStatus) {
    let mut task = TaskflowTask::objects()
        .get(taskflow_task::ID.eq(task_id))
        .await
        .expect("load task");
    task.status = status;
    TaskflowTask::objects().save(task).await.expect("save status");
}

/// Move a task's status via a queryset `update_values` — the dashboard REST
/// PATCH path that fires `bulk_post_save:taskflow_task`.
async fn bulk_update_status(task_id: i64, status: &str) {
    let mut patch = Map::new();
    patch.insert("status".to_string(), Value::String(status.to_string()));
    TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id))
        .update_values(patch)
        .await
        .expect("bulk update status");
}

/// All sessions recorded for a task, newest id first.
async fn sessions_for(task_id: i64) -> Vec<TaskflowTaskSession> {
    let mut rows = TaskflowTaskSession::objects()
        .filter(taskflow_task_session::TASK.eq(task_id))
        .fetch()
        .await
        .expect("fetch sessions");
    rows.sort_by_key(|s| std::cmp::Reverse(s.id));
    rows
}

/// The sessions that are still open (no `ended_at`).
async fn active_sessions(task_id: i64) -> Vec<TaskflowTaskSession> {
    sessions_for(task_id)
        .await
        .into_iter()
        .filter(|s| s.ended_at.is_none())
        .collect()
}

#[tokio::test]
async fn manager_save_into_in_progress_opens_one_running_session() {
    let _app = TestApp::new().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    save_status(task, TaskflowTaskStatus::InProgress).await;

    let active = active_sessions(task).await;
    assert_eq!(active.len(), 1, "one session opens on entering in_progress");
    assert_eq!(active[0].state, TaskflowSessionState::Running);
    assert_eq!(active[0].actor_kind, TaskflowActorKind::System);
    assert_eq!(active[0].actor_label, "System");
}

#[tokio::test]
async fn bulk_update_into_in_progress_opens_one_running_session() {
    // The dashboard board-drag path: a queryset update, NOT Manager::save.
    let _app = TestApp::new().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    bulk_update_status(task, "in_progress").await;

    let active = active_sessions(task).await;
    assert_eq!(active.len(), 1, "bulk_post_save path also opens a session");
    assert_eq!(active[0].state, TaskflowSessionState::Running);
}

#[tokio::test]
async fn repeated_in_progress_write_opens_no_duplicate_session() {
    let _app = TestApp::new().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    save_status(task, TaskflowTaskStatus::InProgress).await;
    // A second write while already in_progress (e.g. an edit) must not stack a
    // second timer.
    save_status(task, TaskflowTaskStatus::InProgress).await;

    assert_eq!(
        active_sessions(task).await.len(),
        1,
        "still exactly one active session"
    );
}

#[tokio::test]
async fn leaving_in_progress_closes_the_session_with_a_duration() {
    let _app = TestApp::new().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    save_status(task, TaskflowTaskStatus::InProgress).await;
    assert_eq!(active_sessions(task).await.len(), 1, "opened");

    save_status(task, TaskflowTaskStatus::Done).await;

    assert!(
        active_sessions(task).await.is_empty(),
        "no active session after leaving in_progress"
    );
    let closed = sessions_for(task).await;
    assert_eq!(closed.len(), 1, "the same session, now closed");
    assert_eq!(closed[0].state, TaskflowSessionState::Stopped);
    assert!(closed[0].ended_at.is_some(), "ended_at populated");
    assert!(
        closed[0].duration_seconds.is_some(),
        "duration_seconds populated"
    );
    assert!(closed[0].duration_seconds.unwrap() >= 0);
}

#[tokio::test]
async fn blocked_then_back_to_in_progress_opens_a_fresh_session() {
    // Review-gate scenario: a task bounced blocked → in_progress should time again.
    let _app = TestApp::new().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    save_status(task, TaskflowTaskStatus::InProgress).await;
    save_status(task, TaskflowTaskStatus::Blocked).await;
    assert!(active_sessions(task).await.is_empty(), "closed on blocked");

    save_status(task, TaskflowTaskStatus::InProgress).await;
    assert_eq!(
        active_sessions(task).await.len(),
        1,
        "a fresh session on re-entering in_progress"
    );
    // Two sessions total: the first (closed) and the new (open).
    assert_eq!(sessions_for(task).await.len(), 2);
}
