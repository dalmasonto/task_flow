//! #5907 1b: per-project board columns. What must hold:
//! 1. No rows: the 7 defaults (keys = kind names, archived hidden), with task
//!    counts. A member reads; an outsider 404s.
//! 2. PUT is owner/admin only (a developer 403), validated (every kind kept,
//!    keys unique and slug-shaped, colors #rrggbb, unknown fields refused),
//!    and versioned (a stale `base_version` 409s).
//! 3. Invariant: after any task write, `status_column` is a column of the
//!    task's status kind. Writing only `status` lands in the first column of
//!    the kind; writing a column of the wrong kind is corrected (status wins).
//! 4. Editing the columns never changes a task's status: a task in a removed
//!    column moves to the first column of its own kind.

mod support;

use serde_json::{Value, json};
use support::{TestApp, load_task, seed_active_member, seed_member_as, seed_project, seed_task, set_status};
use taskflow_projects::models::TaskflowProjectRole;
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskStatus, taskflow_task};

fn url(project: i64) -> String {
    format!("/api/taskflow/projects/{project}/statuses")
}

fn col(key: &str, label: &str, kind: &str) -> Value {
    json!({ "key": key, "label": label, "kind": kind })
}

/// The defaults plus a second in-progress column, "review".
fn with_review() -> Vec<Value> {
    vec![
        col("todo", "To do", "not_started"),
        col("doing", "Doing", "in_progress"),
        col("review", "In review", "in_progress"),
        col("paused", "Paused", "paused"),
        col("blocked", "Blocked", "blocked"),
        col("partial", "Partly done", "partial_done"),
        col("done", "Done", "done"),
        json!({ "key": "archived", "label": "Archived", "kind": "archived", "hidden": true }),
    ]
}

async fn column_of(task: i64) -> Option<String> {
    load_task(task).await.status_column
}

/// Move a task the way the board does: REST-style column update of both fields.
async fn move_to(task: i64, status: &str, column: &str) {
    let mut v = serde_json::Map::new();
    v.insert("status".into(), json!(status));
    v.insert("status_column".into(), json!(column));
    TaskflowTask::objects().filter(taskflow_task::ID.eq(task)).update_values(v).await.unwrap();
}

#[tokio::test]
async fn defaults_are_served_with_counts_and_outsiders_404() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let member = app.create_user().await;
    seed_active_member(project, member).await;
    let outsider = app.create_user().await;
    let t = seed_task(project).await;
    // The reconciler gave the new task its default column.
    assert_eq!(column_of(t).await.as_deref(), Some("not_started"));
    set_status(t, TaskflowTaskStatus::Paused).await;
    assert_eq!(column_of(t).await.as_deref(), Some("paused"));

    let r = app.get_as(member, &url(project)).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let b = r.json().await;
    assert_eq!(b["version"], 0);
    assert_eq!(b["custom"], false);
    let cols = b["columns"].as_array().unwrap();
    let keys: Vec<&str> = cols.iter().map(|c| c["key"].as_str().unwrap()).collect();
    assert_eq!(keys, ["not_started", "in_progress", "paused", "blocked", "partial_done", "done", "archived"]);
    assert_eq!(cols[6]["hidden"], true);
    assert_eq!(cols[2]["task_count"], 1);
    assert_eq!(cols[0]["task_count"], 0);

    assert_eq!(app.get_as(outsider, &url(project)).await.status(), 404);
}

#[tokio::test]
async fn only_managers_replace_and_input_is_validated() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let dev = app.create_user().await;
    seed_active_member(project, dev).await;
    let admin = app.create_user().await;
    seed_member_as(project, admin, TaskflowProjectRole::Admin).await;
    let outsider = app.create_user().await;
    let good = json!({ "columns": with_review(), "base_version": 0 });

    assert_eq!(app.put_as(dev, &url(project), good.clone()).await.status(), 403);
    assert_eq!(app.put_as(outsider, &url(project), good.clone()).await.status(), 404);

    // A kind with no column.
    let mut missing = with_review();
    missing.retain(|c| c["kind"] != "blocked");
    let r = app.put_as(admin, &url(project), json!({ "columns": missing, "base_version": 0 })).await;
    assert_eq!(r.status(), 400);
    assert_eq!(r.json().await["missing"], json!(["blocked"]));
    // Duplicate key, bad key, bad color, unknown field, unknown kind.
    let mut dup = with_review();
    dup[1]["key"] = json!("todo");
    assert_eq!(app.put_as(admin, &url(project), json!({ "columns": dup, "base_version": 0 })).await.status(), 400);
    let mut bad_key = with_review();
    bad_key[1]["key"] = json!("Doing Now");
    assert_eq!(app.put_as(admin, &url(project), json!({ "columns": bad_key, "base_version": 0 })).await.status(), 400);
    let mut bad_color = with_review();
    bad_color[1]["color"] = json!("red");
    assert_eq!(app.put_as(admin, &url(project), json!({ "columns": bad_color, "base_version": 0 })).await.status(), 400);
    let mut extra = with_review();
    extra[1]["task_count"] = json!(3);
    assert_eq!(app.put_as(admin, &url(project), json!({ "columns": extra, "base_version": 0 })).await.status(), 422);
    let mut kind = with_review();
    kind[1]["kind"] = json!("review");
    assert_eq!(app.put_as(admin, &url(project), json!({ "columns": kind, "base_version": 0 })).await.status(), 422);
    assert_eq!(app.put_as(admin, &url(project), json!({ "columns": [], "base_version": 0 })).await.status(), 400);

    let r = app.put_as(admin, &url(project), good.clone()).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let b = r.json().await;
    assert_eq!(b["version"], 1);
    assert_eq!(b["custom"], true);
    assert_eq!(b["columns"][2]["key"], "review");
    assert_eq!(b["columns"][2]["position"], 2);
    // The same base again is stale.
    let r = app.put_as(admin, &url(project), good).await;
    assert_eq!(r.status(), 409);
    assert_eq!(r.json().await["error"], "stale");
}

#[tokio::test]
async fn status_wins_and_every_task_stays_in_a_column_of_its_kind() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    seed_member_as(project, owner, TaskflowProjectRole::Owner).await;
    let t = seed_task(project).await;
    let r = app.put_as(owner, &url(project), json!({ "columns": with_review(), "base_version": 0 })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    // The PUT re-homed the task from the default key to its kind's first column.
    assert_eq!(column_of(t).await.as_deref(), Some("todo"));

    // Status only (the MCP path): the first column of the kind.
    set_status(t, TaskflowTaskStatus::InProgress).await;
    assert_eq!(column_of(t).await.as_deref(), Some("doing"));
    // Both (the board): kept.
    move_to(t, "in_progress", "review").await;
    assert_eq!(column_of(t).await.as_deref(), Some("review"));
    // A column of another kind: status wins.
    move_to(t, "blocked", "review").await;
    let task = load_task(t).await;
    assert_eq!(task.status, TaskflowTaskStatus::Blocked);
    assert_eq!(task.status_column.as_deref(), Some("blocked"));
    // An unknown key: the kind's first column.
    move_to(t, "in_progress", "nope").await;
    assert_eq!(column_of(t).await.as_deref(), Some("doing"));

    let b = app.get_as(owner, &url(project)).await.json().await;
    let count = |k: &str| b["columns"].as_array().unwrap().iter().find(|c| c["key"] == k).unwrap()["task_count"].clone();
    assert_eq!(count("doing"), 1);
    assert_eq!(count("review"), 0);
}

#[tokio::test]
async fn editing_columns_never_changes_a_status() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    seed_member_as(project, owner, TaskflowProjectRole::Owner).await;
    let t = seed_task(project).await;
    app.put_as(owner, &url(project), json!({ "columns": with_review(), "base_version": 0 })).await;
    move_to(t, "in_progress", "review").await;

    // Drop "review": the task moves to "doing", still in progress.
    let mut cols = with_review();
    cols.retain(|c| c["key"] != "review");
    let r = app.put_as(owner, &url(project), json!({ "columns": cols, "base_version": 1 })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let task = load_task(t).await;
    assert_eq!(task.status, TaskflowTaskStatus::InProgress);
    assert_eq!(task.status_column.as_deref(), Some("doing"));

    // Re-kind "doing" to blocked (adding a new in-progress column first in
    // order): the task follows its own kind, not the column.
    let mut cols: Vec<Value> = with_review();
    cols.retain(|c| c["key"] != "review");
    cols[1]["kind"] = json!("blocked");
    cols.insert(1, col("wip", "WIP", "in_progress"));
    let r = app.put_as(owner, &url(project), json!({ "columns": cols, "base_version": 2 })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let task = load_task(t).await;
    assert_eq!(task.status, TaskflowTaskStatus::InProgress);
    assert_eq!(task.status_column.as_deref(), Some("wip"));
}
