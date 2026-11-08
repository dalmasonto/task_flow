//! #1098: review requests. What must hold: only the NAMED reviewer's review
//! answers a request (and links it); one open request per (task, reviewer);
//! the reviewer agent is told at once; only the requester may cancel; the
//! reviewer must belong to the task's project.

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, seed_project};
use taskflow_agents::models::{TaskflowAgentMessage, TaskflowReviewRequest, taskflow_agent_message, taskflow_review_request};
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};
use umbral::orm::ForeignKey;

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

async fn seed_task(project: i64, assigned_agent: Option<i64>) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0, project: ForeignKey::new(project), title: "ship it".into(), description_markdown: String::new(), notes_markdown: None,
            status: TaskflowTaskStatus::PartialDone, priority: TaskflowTaskPriority::Normal, sort_order: 0, created_by: None, assigned_user: None,
            assigned_agent_id: assigned_agent, review_gate: None, estimate_minutes: None, operator_user: None, operator_agent_id: None,
            created_by_agent_id: None, assignee_label: None, due_at: None, closed_at: None, github_issue_number: None,
            github_issue_url: None, github_repo: None, created_at: None, updated_at: None,
        })
        .await
        .unwrap()
        .id
}

async fn notices(project: i64, agent: i64) -> Vec<String> {
    TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::PROJECT.eq(project) & taskflow_agent_message::TARGET_AGENT.eq(agent))
        .fetch()
        .await
        .unwrap()
        .into_iter()
        .filter(|m| m.sender_label == taskflow_agents::wakeups::SENDER_LABEL)
        .map(|m| m.body_markdown)
        .collect()
}

async fn request(id: i64) -> TaskflowReviewRequest {
    TaskflowReviewRequest::objects().filter(taskflow_review_request::ID.eq(id)).first().await.unwrap().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_named_reviewers_review_answers_the_request() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (author_key, author) = mint_agent(&app, project, "author").await;
    let (reviewer_key, reviewer) = mint_agent(&app, project, "reviewer").await;
    let (bystander_key, _) = mint_agent(&app, project, "bystander").await;
    // Assigned to someone else, so the requester's "answered" notice is the
    // only thing that reaches the author.
    let task = seed_task(project, None).await;
    let path = format!("/api/taskflow/tasks/{task}/agent/review-requests");

    let res = app
        .post_as_agent(&author_key, &path, json!({ "reviewer": { "kind": "agent", "id": reviewer }, "link": "https://github.com/x/y/pull/1", "focus_markdown": "the CAS in close()" }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    let id = res.json().await["id"].as_i64().unwrap();
    let told = notices(project, reviewer).await;
    assert!(told.iter().any(|b| b.contains("Review requested by author") && b.contains("pull/1") && b.contains("the CAS")), "{told:?}");

    // One open request per (task, reviewer); never yourself; a bad link.
    let again = app.post_as_agent(&author_key, &path, json!({ "reviewer": { "kind": "agent", "id": reviewer } })).await;
    assert_eq!(again.status(), 409);
    assert_eq!(again.json().await["request"]["id"], id);
    assert_eq!(app.post_as_agent(&author_key, &path, json!({ "reviewer": { "kind": "agent", "id": author } })).await.status(), 400);
    assert_eq!(
        app.post_as_agent(&author_key, &path, json!({ "reviewer": { "kind": "agent", "id": reviewer }, "link": "javascript:alert(1)" })).await.status(),
        400
    );

    // A review by someone else leaves it open.
    let other = app.post_as_agent(&bystander_key, &format!("/api/taskflow/tasks/{task}/agent/review"), json!({ "decision": "changes_requested" })).await;
    assert_eq!(other.status(), 200, "{}", other.text());
    assert_eq!(serde_json::to_value(request(id).await.status).unwrap(), "open");

    // The named reviewer's review answers it and is linked.
    let mine = app.post_as_agent(&reviewer_key, &format!("/api/taskflow/tasks/{task}/agent/review"), json!({ "decision": "approved" })).await;
    assert_eq!(mine.status(), 200, "{}", mine.text());
    let review_id = mine.json().await["id"].as_i64().unwrap();
    let r = request(id).await;
    assert_eq!(serde_json::to_value(r.status).unwrap(), "answered");
    assert_eq!(r.review.map(|v| v.id()), Some(review_id));
    assert!(notices(project, author).await.iter().any(|b| b.contains("answered your review request") && b.contains("approved")));

    // Answered, so it can be asked again; and the lists see both sides.
    assert_eq!(app.post_as_agent(&author_key, &path, json!({ "reviewer": { "kind": "agent", "id": reviewer } })).await.status(), 201);
    let list = app.get_as_agent(&reviewer_key, "/api/taskflow/agents/review-requests").await.json().await;
    assert_eq!(list["for_me"].as_array().unwrap().len(), 1);
    assert_eq!(list["mine"].as_array().unwrap().len(), 0);
    let all = app.get_as_agent(&author_key, "/api/taskflow/agents/review-requests?status=all").await.json().await;
    assert_eq!(all["mine"].as_array().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_requester_cancels_and_the_reviewer_must_be_in_the_project() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let elsewhere = seed_project().await;
    let asker = app.create_user().await;
    make_active_project_member(project, asker).await;
    let reviewer_user = app.create_user().await;
    make_active_project_member(project, reviewer_user).await;
    let outsider = app.create_user().await;
    make_active_project_member(elsewhere, outsider).await;
    let (_, foreign_agent) = mint_agent(&app, elsewhere, "foreign").await;
    let (reviewer_agent_key, reviewer_agent) = mint_agent(&app, project, "rev").await;
    let task = seed_task(project, None).await;
    let path = format!("/api/taskflow/tasks/{task}/review-requests");

    // Not a member of the task's project → 403; reviewers from another project → 400.
    assert_eq!(app.post_as(outsider, &path, json!({ "reviewer": { "kind": "user", "id": reviewer_user } })).await.status(), 403);
    assert_eq!(app.post_as(asker, &path, json!({ "reviewer": { "kind": "user", "id": outsider } })).await.status(), 400);
    assert_eq!(app.post_as(asker, &path, json!({ "reviewer": { "kind": "agent", "id": foreign_agent } })).await.status(), 400);
    // An agent cannot ask about a task in another project.
    let foreign_task = seed_task(elsewhere, None).await;
    assert_eq!(
        app.post_as_agent(&reviewer_agent_key, &format!("/api/taskflow/tasks/{foreign_task}/agent/review-requests"), json!({ "reviewer": { "kind": "user", "id": asker } })).await.status(),
        403
    );

    let to_user = app.post_as(asker, &path, json!({ "reviewer": { "kind": "user", "id": reviewer_user } })).await;
    assert_eq!(to_user.status(), 201, "{}", to_user.text());
    let to_agent = app.post_as(asker, &path, json!({ "reviewer": { "kind": "agent", "id": reviewer_agent } })).await;
    assert_eq!(to_agent.status(), 201);
    let id = to_agent.json().await["id"].as_i64().unwrap();

    // Only the requester cancels; the reviewer is told; twice is 409.
    assert_eq!(app.post_as(reviewer_user, &format!("/api/taskflow/review-requests/{id}/cancel"), json!({})).await.status(), 403);
    assert_eq!(app.post_as_agent(&reviewer_agent_key, &format!("/api/taskflow/agents/review-requests/{id}/cancel"), json!({})).await.status(), 403);
    assert_eq!(app.post_as(asker, &format!("/api/taskflow/review-requests/{id}/cancel"), json!({})).await.status(), 200);
    assert_eq!(serde_json::to_value(request(id).await.status).unwrap(), "cancelled");
    assert!(notices(project, reviewer_agent).await.iter().any(|b| b.contains("cancelled the review request")));
    assert_eq!(app.post_as(asker, &format!("/api/taskflow/review-requests/{id}/cancel"), json!({})).await.status(), 409);

    // Someone who has left the project can no longer cancel their old request.
    let left = app.post_as(asker, &path, json!({ "reviewer": { "kind": "user", "id": reviewer_user }, "focus_markdown": "x" })).await;
    assert_eq!(left.status(), 409, "the user request is still open");
    let open_id = left.json().await["request"]["id"].as_i64().unwrap();
    {
        use taskflow_projects::models::{TaskflowMembershipStatus, TaskflowProjectMember, taskflow_project_member};
        let mut m = TaskflowProjectMember::objects()
            .filter(taskflow_project_member::PROJECT.eq(project) & taskflow_project_member::USER.eq(asker))
            .first().await.unwrap().unwrap();
        m.status = TaskflowMembershipStatus::Left;
        TaskflowProjectMember::objects().save(m).await.unwrap();
    }
    assert_eq!(app.post_as(asker, &format!("/api/taskflow/review-requests/{open_id}/cancel"), json!({})).await.status(), 403);

    // A cancelled request is not answered by a later review.
    let rev = app.post_as_agent(&reviewer_agent_key, &format!("/api/taskflow/tasks/{task}/agent/review"), json!({ "decision": "approved" })).await;
    assert_eq!(rev.status(), 200);
    assert_eq!(serde_json::to_value(request(id).await.status).unwrap(), "cancelled");
}
