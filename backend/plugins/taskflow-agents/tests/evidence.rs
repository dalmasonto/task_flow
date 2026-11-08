//! #1117: evidence for review. What must hold: the author comes from the auth
//! gate; an attachment must be on the SAME task; only the author withdraws it;
//! an agent cannot touch another project's task; and handing work over quotes
//! the evidence in the status activity.

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, seed_project};
use taskflow_tasks::models::{
    TaskflowTask, TaskflowTaskActivity, TaskflowTaskAttachment, TaskflowTaskPriority, TaskflowTaskStatus,
    taskflow_task_activity,
};
use umbral::orm::{FileField, ForeignKey};

async fn mint_agent(app: &TestApp, project: i64, label: &str) -> (String, i64) {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(human, "/api/taskflow/agents/link", json!({ "project": project, "display_name": label, "profile": label }))
        .await;
    assert_eq!(resp.status(), 200, "{}", resp.text());
    let body = resp.json().await;
    (body["key"].as_str().unwrap().to_string(), body["agent_id"].as_i64().unwrap())
}

async fn seed_task(project: i64) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0, project: ForeignKey::new(project), title: "ship it".into(), description_markdown: None, notes_markdown: None,
            status: TaskflowTaskStatus::InProgress, priority: TaskflowTaskPriority::Normal, sort_order: 0, created_by: None, assigned_user: None,
            assigned_agent_id: None, review_gate: None, estimate_minutes: None, operator_user: None, operator_agent_id: None,
            created_by_agent_id: None, assignee_label: None, due_at: None, closed_at: None, github_issue_number: None,
            github_issue_url: None, github_repo: None, created_at: None, updated_at: None,
        })
        .await
        .unwrap()
        .id
}

async fn seed_attachment(project: i64, task: i64, name: &str) -> i64 {
    TaskflowTaskAttachment::objects()
        .create(TaskflowTaskAttachment {
            id: 0, project: ForeignKey::new(project), task: ForeignKey::new(task),
            file: FileField::from(format!("seed-{task}-{name}")), name: name.into(),
            content_type: "image/png".into(), size_bytes: 96_000, created_at: None,
        })
        .await
        .unwrap()
        .id
}

#[tokio::test(flavor = "multi_thread")]
async fn evidence_is_added_listed_quoted_on_handover_and_withdrawn_by_its_author() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (key, agent) = mint_agent(&app, project, "author").await;
    let (other_key, _) = mint_agent(&app, project, "other").await;
    let task = seed_task(project).await;
    let other_task = seed_task(project).await;
    let png = seed_attachment(project, task, "pane-capture-tests.png").await;
    let elsewhere = seed_attachment(project, other_task, "not-yours.png").await;
    let path = format!("/api/taskflow/tasks/{task}/agent/evidence");

    let run = app
        .post_as_agent(&key, &path, json!({ "kind": "test_run", "label": "cargo test,\n218 passed", "passed": true, "stats": { "passed": 218, "failed": 0, "duration_ms": 190000 } }))
        .await;
    assert_eq!(run.status(), 201, "{}", run.text());
    let run = run.json().await;
    assert_eq!(run["label"], "cargo test, 218 passed", "whitespace collapsed to one line");
    assert_eq!(run["author_agent"], agent);
    assert_eq!(run["self_reported"], true);
    assert_eq!(run["stats"]["passed"], 218);

    let cap = app.post_as_agent(&key, &path, json!({ "kind": "attachment", "label": "pane capture", "attachment": png })).await;
    assert_eq!(cap.status(), 201, "{}", cap.text());
    let cap = cap.json().await;
    assert_eq!(cap["attachment"], json!({ "id": png, "filename": "pane-capture-tests.png", "content_type": "image/png", "size": 96000 }));

    // Shape checks: another task's attachment, a missing one, a bad URL, an
    // unknown field, a negative count, an empty label.
    for bad in [
        json!({ "kind": "attachment", "label": "x", "attachment": elsewhere }),
        json!({ "kind": "attachment", "label": "x" }),
        json!({ "kind": "pull_request", "label": "x", "url": "javascript:alert(1)" }),
        json!({ "kind": "note", "label": "x", "author_agent": 99 }),
        json!({ "kind": "test_run", "label": "x", "stats": { "failed": -1 } }),
        json!({ "kind": "note", "label": "   " }),
    ] {
        let r = app.post_as_agent(&key, &path, bad.clone()).await;
        assert!(matches!(r.status(), 400 | 422), "{bad} → {}", r.status());
    }

    let list = app.get_as_agent(&other_key, &path).await.json().await;
    assert_eq!(list["evidence"].as_array().unwrap().len(), 2);
    assert_eq!(list["evidence"][0]["id"], cap["id"], "newest first");

    // Handing the task over quotes the evidence in the status activity.
    let moved = app.post_as_agent(&key, &format!("/api/taskflow/agents/tasks/{task}/status"), json!({ "status": "partial_done" })).await;
    assert_eq!(moved.status(), 200, "{}", moved.text());
    let acts = TaskflowTaskActivity::objects().filter(taskflow_task_activity::TASK.eq(task)).fetch().await.unwrap();
    let body = acts.iter().filter(|a| a.action == "status_changed").filter_map(|a| a.body_markdown.clone()).last().unwrap();
    assert!(body.contains("evidence: pane capture, cargo test, 218 passed"), "{body}");

    // Only the author withdraws.
    let id = run["id"].as_i64().unwrap();
    assert_eq!(app.delete_as_agent(&other_key, &format!("/api/taskflow/agents/evidence/{id}")).await.status(), 403);
    assert_eq!(app.delete_as_agent(&key, &format!("/api/taskflow/agents/evidence/{id}")).await.status(), 204);
    let list = app.get_as_agent(&key, &path).await.json().await;
    assert_eq!(list["evidence"].as_array().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn people_add_evidence_as_themselves_and_projects_stay_apart() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let elsewhere = seed_project().await;
    let member = app.create_user().await;
    make_active_project_member(project, member).await;
    let outsider = app.create_user().await;
    make_active_project_member(elsewhere, outsider).await;
    let (foreign_key, _) = mint_agent(&app, elsewhere, "foreign").await;
    let task = seed_task(project).await;
    let path = format!("/api/taskflow/tasks/{task}/evidence");

    let r = app.post_as(member, &path, json!({ "kind": "pull_request", "label": "PR #44, 6 files", "url": "https://github.com/x/y/pull/44", "stats": { "files": 6, "additions": 412, "deletions": 37 } })).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    let r = r.json().await;
    assert_eq!(r["author_user"], member);
    assert_eq!(r["author_kind"], "user");

    assert_eq!(app.post_as(outsider, &path, json!({ "kind": "note", "label": "x" })).await.status(), 403);
    assert_eq!(app.get_as(outsider, &path).await.status(), 403);
    let agent_path = format!("/api/taskflow/tasks/{task}/agent/evidence");
    assert_eq!(app.post_as_agent(&foreign_key, &agent_path, json!({ "kind": "note", "label": "x" })).await.status(), 403);
    assert_eq!(app.get_as_agent(&foreign_key, &agent_path).await.status(), 403);
    let id = r["id"].as_i64().unwrap();
    assert_eq!(app.delete_as_agent(&foreign_key, &format!("/api/taskflow/agents/evidence/{id}")).await.status(), 404);
    assert_eq!(app.delete_as(outsider, &format!("/api/taskflow/evidence/{id}")).await.status(), 403);
    assert_eq!(app.delete_as(member, &format!("/api/taskflow/evidence/{id}")).await.status(), 204);
}
