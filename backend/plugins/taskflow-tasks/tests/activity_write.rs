//! #1138: people write task activity only through
//! `POST /api/taskflow/tasks/{task}/activity`. What must hold:
//! 1. The actor is the caller: `actor_kind: user`, `actor_user`, the label;
//!    nothing about the actor or `metadata_json` comes from the body.
//! 2. `action` is an allowlist (comments, timer events); anything else 400.
//! 3. A non-member (or a missing task) gets 404 and nothing is written.

mod support;

use serde_json::json;
use support::{TestApp, seed_active_member, seed_project, seed_task};
use taskflow_tasks::models::{TaskflowTaskActivity, taskflow_task_activity};

async fn rows(task: i64) -> Vec<TaskflowTaskActivity> {
    TaskflowTaskActivity::objects().filter(taskflow_task_activity::TASK.eq(task)).fetch().await.unwrap()
}

#[tokio::test]
async fn the_actor_is_always_the_caller() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let task = seed_task(project).await;
    let me = app.create_user().await;
    seed_active_member(project, me).await;
    let path = format!("/api/taskflow/tasks/{task}/activity");

    let r = app.post_as(me, &path, json!({ "action": "commented", "body_markdown": " Looks good " })).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    let b = r.json().await;
    assert_eq!(b["actor_kind"], "user");
    assert_eq!(b["actor_user"], me);
    assert_eq!(b["project"], project);
    assert_eq!(b["body_markdown"], "Looks good");

    // Trying to set the actor, the project or metadata is refused, not ignored.
    for extra in [
        json!({ "action": "commented", "body_markdown": "x", "actor_kind": "agent" }),
        json!({ "action": "commented", "body_markdown": "x", "actor_label": "TaskFlow" }),
        json!({ "action": "commented", "body_markdown": "x", "actor_user": 1 }),
        json!({ "action": "commented", "body_markdown": "x", "metadata_json": "{}" }),
        json!({ "action": "commented", "body_markdown": "x", "project": project }),
    ] {
        assert_eq!(app.post_as(me, &path, extra.clone()).await.status(), 422, "{extra}");
    }
    // Only person actions.
    for action in ["claim_released", "agent_key_rotated", "review_approved", "member_removed"] {
        let r = app.post_as(me, &path, json!({ "action": action, "body_markdown": "x" })).await;
        assert_eq!(r.status(), 400, "{action}: {}", r.text());
    }
    for action in ["timer_started", "timer_paused", "timer_stopped"] {
        assert_eq!(app.post_as(me, &path, json!({ "action": action })).await.status(), 201, "{action}");
    }
    assert_eq!(app.post_as(me, &path, json!({ "action": "commented", "body_markdown": "  " })).await.status(), 400);
    let all = rows(task).await;
    assert_eq!(all.len(), 4);
    assert!(all.iter().all(|r| r.actor_user.as_ref().map(|u| u.id()) == Some(me) && r.metadata_json.is_none()));
}

#[tokio::test]
async fn outsiders_get_404_and_write_nothing() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let task = seed_task(project).await;
    let outsider = app.create_user().await;
    let r = app.post_as(outsider, &format!("/api/taskflow/tasks/{task}/activity"), json!({ "action": "commented", "body_markdown": "hi" })).await;
    assert_eq!(r.status(), 404, "{}", r.text());
    assert_eq!(app.post_as(outsider, "/api/taskflow/tasks/999999999/activity", json!({ "action": "commented", "body_markdown": "hi" })).await.status(), 404);
    assert!(rows(task).await.is_empty());
}
