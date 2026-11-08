//! #5955: a person's Resolve / Reopen, Reassign, and a comment's task.
//! What must hold:
//! 1. Resolve: open/sent/addressed → resolved with who and when; again is 409
//!    `changed`; a missing comment 404 `not_found`; an outsider 404.
//! 2. Reopen: resolved/dismissed → sent if it went to an agent, else open,
//!    clearing the resolution; an open one is 409.
//! 3. An agent's resolve can't touch a resolved comment (409).
//! 4. Dispatch re-sends a sent comment only with `reassign: true`.
//! 5. PATCH `{task}` links a task of the same project (another project's 400),
//!    `null` unlinks; a PATCH to `resolved` records the resolver too.

mod support;

use serde_json::{Value, json};
use support::{TestApp, seed_agent};
use taskflow_design::models::{DesignComment, design_comment};

async fn comment(app: &TestApp, user: i64, project: i64) -> i64 {
    let res = app
        .post_json_as(user, &format!("/api/design/{project}/comments"), &json!({
            "page_path": "/settings",
            "element_path": "main > section",
            "viewport": "laptop",
            "rect": {"x": 1, "y": 2, "w": 3, "h": 4},
            "body": "Make it bigger"
        }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    res.json()["id"].as_i64().unwrap()
}

async fn row(id: i64) -> DesignComment {
    DesignComment::objects().filter(design_comment::ID.eq(id)).first().await.unwrap().unwrap()
}

fn status(c: &DesignComment) -> Value {
    serde_json::to_value(c.status).unwrap()
}

async fn seed_task(project: i64) -> i64 {
    use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: umbral::orm::ForeignKey::new(project),
            title: "From a comment".into(),
            description_markdown: None,
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
            github_repo: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .unwrap()
        .id
}

#[tokio::test(flavor = "multi_thread")]
async fn resolve_and_reopen() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (outsider, _) = app.create_member_with_project().await;
    let (agent, key) = seed_agent(project, "Builder").await;
    let base = format!("/api/design/{project}/comments");

    // Open → resolved, with who and when.
    let a = comment(&app, user.id, project).await;
    let r = app.post_json_as(user.id, &format!("{base}/{a}/resolve"), &json!({})).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["status"], "resolved");
    assert!(r.json()["resolved_by_label"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(r.json()["resolved_at"].is_string());
    let again = app.post_json_as(user.id, &format!("{base}/{a}/resolve"), &json!({})).await;
    assert_eq!(again.status(), 409);
    assert_eq!(again.json()["error"], "changed");
    // An agent's resolve can't undo a person's.
    let r = app
        .post_json_as_agent(&key, &format!("/api/taskflow/agents/design/comments/{a}/resolve"), &json!({ "project": project, "note": "done" }))
        .await;
    assert_eq!(r.status(), 409, "{}", r.text());
    assert_eq!(status(&row(a).await), "resolved");
    // Reopen, never sent: back to open, resolution cleared.
    let r = app.post_json_as(user.id, &format!("{base}/{a}/reopen"), &json!({})).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["status"], "open");
    assert_eq!(r.json()["resolved_by_label"], Value::Null);
    assert_eq!(r.json()["resolved_at"], Value::Null);
    assert_eq!(app.post_json_as(user.id, &format!("{base}/{a}/reopen"), &json!({})).await.status(), 409);

    // Sent to an agent, addressed, resolved, reopened: back to sent.
    let b = comment(&app, user.id, project).await;
    let d = app.post_json_as(user.id, &format!("/api/design/{project}/dispatch"), &json!({ "comment_ids": [b], "agent_id": agent })).await;
    assert_eq!(d.status(), 201, "{}", d.text());
    let r = app
        .post_json_as_agent(&key, &format!("/api/taskflow/agents/design/comments/{b}/resolve"), &json!({ "project": project, "note": "bigger" }))
        .await;
    assert_eq!(r.status() / 100, 2, "{}", r.text());
    assert_eq!(status(&row(b).await), "addressed");
    assert_eq!(app.post_json_as(user.id, &format!("{base}/{b}/resolve"), &json!({})).await.status(), 200);
    assert_eq!(app.post_json_as(user.id, &format!("{base}/{b}/reopen"), &json!({})).await.json()["status"], "sent");

    // Dismissed reopens too; missing and outsiders 404.
    let c = comment(&app, user.id, project).await;
    assert_eq!(app.patch_json_as(user.id, &format!("{base}/{c}"), &json!({ "status": "dismissed" })).await.status(), 200);
    assert_eq!(app.post_json_as(user.id, &format!("{base}/{c}/reopen"), &json!({})).await.json()["status"], "open");
    let r = app.post_json_as(user.id, &format!("{base}/999999/resolve"), &json!({})).await;
    assert_eq!(r.status(), 404);
    assert_eq!(r.json()["error"], "not_found");
    assert_eq!(app.post_json_as(outsider.id, &format!("{base}/{c}/resolve"), &json!({})).await.status(), 404);
    assert_eq!(status(&row(c).await), "open");
}

#[tokio::test(flavor = "multi_thread")]
async fn reassign_needs_the_flag() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (first, _) = seed_agent(project, "First").await;
    let (second, _) = seed_agent(project, "Second").await;
    let c = comment(&app, user.id, project).await;
    let dispatch = |agent: i64, reassign: Option<bool>| {
        let mut body = json!({ "comment_ids": [c], "agent_id": agent });
        if let Some(r) = reassign {
            body["reassign"] = json!(r);
        }
        body
    };
    let url = format!("/api/design/{project}/dispatch");
    assert_eq!(app.post_json_as(user.id, &url, &dispatch(first, None)).await.status(), 201);
    // Already sent: a plain dispatch finds nothing to send.
    assert_eq!(app.post_json_as(user.id, &url, &dispatch(second, None)).await.status(), 400);
    assert_eq!(row(c).await.sent_to_agent.map(|a| a.id()), Some(first));
    let r = app.post_json_as(user.id, &url, &dispatch(second, Some(true))).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    let fresh = row(c).await;
    assert_eq!(status(&fresh), "sent");
    assert_eq!(fresh.sent_to_agent.map(|a| a.id()), Some(second));
    // A resolved comment isn't reassignable.
    app.post_json_as(user.id, &format!("/api/design/{project}/comments/{c}/resolve"), &json!({})).await;
    assert_eq!(app.post_json_as(user.id, &url, &dispatch(first, Some(true))).await.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_comment_links_a_task_of_its_project() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_, other) = app.create_member_with_project().await;
    let mine = seed_task(project).await;
    let theirs = seed_task(other).await;
    let c = comment(&app, user.id, project).await;
    let url = format!("/api/design/{project}/comments/{c}");

    let r = app.patch_json_as(user.id, &url, &json!({ "task": mine })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["task"], mine);
    assert_eq!(app.patch_json_as(user.id, &url, &json!({ "task": theirs })).await.status(), 400);
    assert_eq!(row(c).await.task.map(|t| t.id()), Some(mine));
    // The thread read carries it.
    let t = app.get_as(user.id, &format!("{url}/thread")).await.json();
    assert_eq!(t["root"]["task"], mine);
    assert_eq!(app.patch_json_as(user.id, &url, &json!({ "task": null })).await.json()["task"], Value::Null);

    // PATCH to resolved records the resolver; to open clears it.
    let r = app.patch_json_as(user.id, &url, &json!({ "status": "resolved" })).await.json();
    assert!(r["resolved_by_label"].is_string());
    let r = app.patch_json_as(user.id, &url, &json!({ "status": "open" })).await.json();
    assert_eq!(r["resolved_by_label"], Value::Null);
}

/// #5974: dispatch posts into the project's design room, targeted at the
/// agent, with the unchanged `[design-review]` body; reassign posts a FRESH
/// message there (never edits the old one, which would re-type it into every
/// pane, #107).
#[tokio::test(flavor = "multi_thread")]
async fn dispatch_lands_in_the_design_room() {
    use taskflow_agents::models::{TaskflowAgentChannel, TaskflowAgentMessage, taskflow_agent_channel, taskflow_agent_message};
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (first, _) = seed_agent(project, "First").await;
    let (second, _) = seed_agent(project, "Second").await;
    let c = comment(&app, user.id, project).await;
    let url = format!("/api/design/{project}/dispatch");

    let r = app.post_json_as(user.id, &url, &json!({ "comment_ids": [c], "agent_id": first })).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    let room = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::PROJECT.eq(project) & taskflow_agent_channel::IS_DESIGN.eq(true))
        .first()
        .await
        .unwrap()
        .expect("the design room");
    assert_eq!(r.json()["channel_id"], room.id);
    let posted = |agent: i64| async move {
        TaskflowAgentMessage::objects()
            .filter(taskflow_agent_message::CHANNEL.eq(room.id) & taskflow_agent_message::TARGET_AGENT.eq(agent))
            .fetch()
            .await
            .unwrap()
    };
    let to_first = posted(first).await;
    assert_eq!(to_first.len(), 1);
    assert!(to_first[0].is_design);
    assert!(to_first[0].body_markdown.starts_with("[design-review]"));
    assert!(to_first[0].body_markdown.contains(&format!("--- design comment cm_{c:04x} ---")));
    assert_eq!(to_first[0].targets.as_deref(), Some(json!([{ "kind": "agent", "id": first }]).to_string().as_str()));

    let r = app.post_json_as(user.id, &url, &json!({ "comment_ids": [c], "agent_id": second, "reassign": true })).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    assert_eq!(posted(second).await.len(), 1, "a fresh message for the new agent");
    let old = posted(first).await;
    assert_eq!(old.len(), 1);
    assert!(old[0].edited_at.is_none(), "the first message is never edited");
}
