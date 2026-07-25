//! `closed_at` is stamped by the status reconciler in `session_timer.rs`,
//! which already runs on every task write via the `post_save:taskflow_task`
//! / `bulk_post_save:taskflow_task` signals (see `task_session_timer.rs` in
//! the taskflow-agents crate for the two-signal rationale). These tests drive
//! the reconciler the same way production traffic does — a plain
//! `Manager::save` status change — rather than calling a private function
//! directly, so they exercise the real signal wiring registered in
//! `TaskflowTasksPlugin::on_ready`.

mod support;

use support::{init, load_task, seed_project, seed_task, set_status};
use taskflow_tasks::models::TaskflowTaskStatus;

#[tokio::test]
async fn moving_to_done_sets_closed_at() {
    init().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    set_status(task, TaskflowTaskStatus::Done).await;

    let reloaded = load_task(task).await;
    assert!(
        reloaded.closed_at.is_some(),
        "closed_at must be set once the task is done"
    );
}

#[tokio::test]
async fn reconciling_an_already_done_task_leaves_closed_at_unchanged() {
    init().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    set_status(task, TaskflowTaskStatus::Done).await;
    let first = load_task(task).await.closed_at.expect("closed_at set");

    // A second write while already done (e.g. an unrelated field edit) must
    // not re-stamp closed_at. Re-saving with the same status re-fires the
    // signal, exercising the `is_none()` guard directly.
    set_status(task, TaskflowTaskStatus::Done).await;
    let second = load_task(task).await.closed_at.expect("closed_at still set");

    assert_eq!(first, second, "closed_at is idempotent across reconciles");
}

#[tokio::test]
async fn reopening_to_in_progress_clears_closed_at() {
    init().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    set_status(task, TaskflowTaskStatus::Done).await;
    assert!(load_task(task).await.closed_at.is_some(), "closed first");

    set_status(task, TaskflowTaskStatus::InProgress).await;

    let reloaded = load_task(task).await;
    assert!(
        reloaded.closed_at.is_none(),
        "closed_at must clear when the task is reopened"
    );
}

#[tokio::test]
async fn moving_to_partial_done_clears_closed_at() {
    init().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    set_status(task, TaskflowTaskStatus::Done).await;
    assert!(load_task(task).await.closed_at.is_some(), "closed first");

    set_status(task, TaskflowTaskStatus::PartialDone).await;

    let reloaded = load_task(task).await;
    assert!(
        reloaded.closed_at.is_none(),
        "closed_at must clear on a non-in_progress terminal exit too"
    );
}

#[tokio::test]
async fn moving_to_archived_sets_closed_at() {
    init().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    set_status(task, TaskflowTaskStatus::Archived).await;

    let reloaded = load_task(task).await;
    assert!(
        reloaded.closed_at.is_some(),
        "closed_at must be set once the task is archived"
    );
}

#[tokio::test]
async fn partial_done_is_not_terminal_and_leaves_closed_at_none() {
    init().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    set_status(task, TaskflowTaskStatus::PartialDone).await;

    let reloaded = load_task(task).await;
    assert!(
        reloaded.closed_at.is_none(),
        "partial_done is not a terminal status"
    );
}
