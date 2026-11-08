//! #1078 / group 9: an owner or admin changes an existing agent's
//! capabilities without a new key; it takes effect on the agent's next call.
//! A plain member can't (403), an outsider sees nothing (404), and unknown
//! names are refused (400).

mod support;

use serde_json::json;
use support::{TestApp, make_project_member_with_role, seed_project};
use taskflow_projects::models::TaskflowProjectRole;
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};
use umbral::orm::ForeignKey;
use taskflow_tasks::models::{TaskflowTaskActivity, taskflow_task_activity};

async fn audit(project: i64) -> Vec<String> {
    TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::PROJECT.eq(project) & taskflow_task_activity::ACTION.eq("agent_capabilities_changed"))
        .fetch()
        .await
        .unwrap()
        .into_iter()
        .map(|a| a.body_markdown.unwrap_or_default())
        .collect()
}

async fn seed_task(project: i64) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0, project: ForeignKey::new(project), title: "build it".into(), description_markdown: None, notes_markdown: None,
            status: TaskflowTaskStatus::NotStarted, priority: TaskflowTaskPriority::Normal, sort_order: 0, created_by: None,
            assigned_user: None, assigned_agent_id: None, review_gate: None, estimate_minutes: None, operator_user: None,
            operator_agent_id: None, created_by_agent_id: None, assignee_label: None, due_at: None, closed_at: None,
            github_issue_number: None, github_issue_url: None, github_repo: None, created_at: None, updated_at: None,
        })
        .await
        .unwrap()
        .id
}


#[tokio::test(flavor = "multi_thread")]
async fn an_owner_changes_capabilities_and_the_next_call_obeys() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;
    let member = app.create_user().await;
    make_project_member_with_role(project, member, TaskflowProjectRole::Developer).await;
    let outsider = app.create_user().await;
    let link = app
        .post_as(owner, "/api/taskflow/agents/link", json!({ "project": project, "display_name": "Builder", "profile": "b" }))
        .await;
    let link = link.json().await;
    let (agent, key) = (link["agent_id"].as_i64().unwrap(), link["key"].as_str().unwrap().to_string());
    let path = format!("/api/taskflow/agents/{agent}/scopes");

    let task = seed_task(project).await;
    let r = app.post_as_agent(&key, &format!("/api/taskflow/agents/tasks/{task}/claim"), json!({})).await;
    assert_eq!(r.status(), 200, "allowed before");

    // Who may: member 403, outsider 404, bad names 400.
    assert_eq!(app.patch_as(member, &path, json!({ "denied_scopes": ["tasks:write"] })).await.status(), 403);
    assert_eq!(app.patch_as(outsider, &path, json!({ "denied_scopes": ["tasks:write"] })).await.status(), 404);
    assert_eq!(app.patch_as(owner, &path, json!({ "denied_scopes": ["tasks:nope"] })).await.status(), 400);
    assert_eq!(app.patch_as(owner, &path, json!({ "scopes": ["root"] })).await.status(), 400);

    // The owner switches tasks:write off: the same key's next claim is refused.
    let r = app.patch_as(owner, &path, json!({ "denied_scopes": ["tasks:write"] })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let body = r.json().await;
    assert_eq!(body["denied_scopes"], json!(["tasks:write"]));
    assert!(!body["capabilities"].as_array().unwrap().iter().any(|c| c == "tasks:write"));
    let other = seed_task(project).await;
    let r = app.post_as_agent(&key, &format!("/api/taskflow/agents/tasks/{other}/claim"), json!({})).await;
    assert_eq!(r.status(), 403, "denied on the very next call, no new key");
    assert_eq!(r.json().await["error"], "capability_denied");
    let me = app.get_as_agent(&key, "/api/taskflow/agents/whoami").await.json().await;
    assert_eq!(me["denied_scopes"], json!(["tasks:write"]));

    // #1078 review: one audit row naming who, and before -> after.
    let rows = audit(project).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].contains("removed tasks:write") && rows[0].contains("added none"), "{}", rows[0]);
    // Saving the same state again changes nothing, so no second row.
    assert_eq!(app.patch_as(owner, &path, json!({ "denied_scopes": ["tasks:write"] })).await.status(), 200);
    assert_eq!(audit(project).await.len(), 1);

    // And back on.
    assert_eq!(app.patch_as(owner, &path, json!({ "denied_scopes": [] })).await.status(), 200);
    assert_eq!(audit(project).await.len(), 2);
    assert_eq!(app.post_as_agent(&key, &format!("/api/taskflow/agents/tasks/{other}/claim"), json!({})).await.status(), 200);
}
