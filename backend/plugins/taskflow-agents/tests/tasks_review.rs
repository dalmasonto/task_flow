//! Stage 4 of the agent identity system: agent-authored tasks + the review
//! workflow. Agents create/claim/advance tasks AS THEMSELVES; a review (by a
//! human OR an agent reviewer) records a decision, transitions the task, and
//! reports back to the assigned agent via a message in the project room so it
//! surfaces in the agent's tmux. Every write is scoped to the caller's project —
//! a foreign-project agent, or a non-member human, is rejected.

use serde_json::json;

mod support;
use support::{
    TestApp, make_active_project_member, seed_channel_of_kind, seed_project,
};
use taskflow_agents::models::{
    TaskflowAgentMessage, TaskflowChannelKind, TaskflowTaskReview, taskflow_agent_message,
    taskflow_task_review,
};
use taskflow_tasks::models::{
    TaskflowTask, TaskflowTaskActivity, TaskflowTaskPriority, TaskflowTaskStatus, taskflow_task,
    taskflow_task_activity,
};
use umbral::orm::ForeignKey;

/// Mint a fresh agent key for `(project, display_name, profile)` as `user`,
/// returning `(key, agent_id)`.
async fn mint_agent(
    app: &TestApp,
    user: i64,
    project: i64,
    display_name: &str,
    profile: &str,
) -> (String, i64) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": display_name, "profile": profile }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    let body = resp.json().await;
    (
        body["key"].as_str().unwrap().to_string(),
        body["agent_id"].as_i64().unwrap(),
    )
}

/// Count reviews recorded for a task.
async fn count_reviews(task_id: i64) -> i64 {
    TaskflowTaskReview::objects()
        .filter(taskflow_task_review::TASK.eq(task_id))
        .count()
        .await
        .expect("count reviews")
}

/// Count messages referencing a task (the report-back messages).
async fn count_task_messages(task_id: i64) -> i64 {
    TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::TASK.eq(task_id))
        .count()
        .await
        .expect("count task messages")
}

/// Count `reviewed` activity rows on a task.
async fn count_reviewed_activity(task_id: i64) -> i64 {
    TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::TASK.eq(task_id) & taskflow_task_activity::ACTION.eq("reviewed"))
        .count()
        .await
        .expect("count reviewed activity")
}

/// Load a task's stored status straight from the DB (there is no read endpoint).
async fn task_status(task_id: i64) -> TaskflowTaskStatus {
    taskflow_tasks::models::TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id))
        .first()
        .await
        .expect("load task")
        .expect("task exists")
        .status
}

// An agent creates a task in its own project (self-claiming it), then advances
// its status to partial_done to request review. A DIFFERENT-project agent cannot
// touch that task (403), and an unknown task is a 404.
#[tokio::test]
async fn agent_creates_and_claims_task() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // Create + self-claim.
    let resp = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "Ship the thing", "description_markdown": "do it", "claim": true }),
        )
        .await;
    assert_eq!(resp.status(), 200, "body: {:?}", resp.json().await);
    let task = resp.json().await;
    let task_id = task["id"].as_i64().expect("task id");
    assert_eq!(task["project"], json!(project));
    assert_eq!(task["assigned_agent_id"], json!(agent_id), "claim self-assigns");
    assert_eq!(task["assignee_label"], json!("Builder"));
    assert_eq!(task["created_by"], json!(null), "no human author");
    assert_eq!(task["status"], json!("not_started"));

    // A created_task activity was logged as the agent.
    let created_activity = TaskflowTaskActivity::objects()
        .filter(
            taskflow_task_activity::TASK.eq(task_id)
                & taskflow_task_activity::ACTION.eq("created_task"),
        )
        .count()
        .await
        .expect("count created activity");
    assert_eq!(created_activity, 1, "created_task activity logged");

    // Advance status to partial_done (request review).
    let status = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/agents/tasks/{task_id}/status"),
            json!({ "status": "partial_done" }),
        )
        .await;
    assert_eq!(status.status(), 200, "body: {:?}", status.json().await);
    assert_eq!(status.json().await["status"], json!("partial_done"));
    assert_eq!(task_status(task_id).await, TaskflowTaskStatus::PartialDone);

    // A foreign-project agent cannot advance or claim this task → 403.
    let other_project = seed_project().await;
    make_active_project_member(other_project, user).await;
    let (foreign_key, _foreign_id) =
        mint_agent(&app, user, other_project, "Outsider", "main").await;

    let foreign_status = app
        .post_as_agent(
            &foreign_key,
            &format!("/api/taskflow/agents/tasks/{task_id}/status"),
            json!({ "status": "done" }),
        )
        .await;
    assert_eq!(foreign_status.status(), 403, "foreign project cannot touch the task");

    let foreign_claim = app
        .post_as_agent(
            &foreign_key,
            &format!("/api/taskflow/agents/tasks/{task_id}/claim"),
            json!({}),
        )
        .await;
    assert_eq!(foreign_claim.status(), 403);

    // The task is untouched by the rejected calls.
    assert_eq!(task_status(task_id).await, TaskflowTaskStatus::PartialDone);

    // An unknown task id is a 404.
    let missing = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/tasks/999999/status",
            json!({ "status": "done" }),
        )
        .await;
    assert_eq!(missing.status(), 404);
}

// A human reviewer approves a task: the review row records the human identity,
// the task moves to done, a `reviewed` activity is logged, and a report-back
// message referencing the task lands in the project room for the assigned agent.
#[tokio::test]
async fn human_review_approves_transitions_and_reports() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    let member_label = make_active_project_member(project, user).await;
    // The project room the report-back message lands in.
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // Agent authors + claims a task, then moves it to partial_done for review.
    let task_id = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "Add the endpoint", "claim": true }),
        )
        .await
        .json()
        .await["id"]
        .as_i64()
        .unwrap();
    app.post_as_agent(
        &key,
        &format!("/api/taskflow/agents/tasks/{task_id}/status"),
        json!({ "status": "partial_done" }),
    )
    .await;

    // Human approves.
    let review = app
        .post_as(
            user,
            &format!("/api/taskflow/tasks/{task_id}/review"),
            json!({ "decision": "approved", "body_markdown": "LGTM, nice work." }),
        )
        .await;
    assert_eq!(review.status(), 200, "body: {:?}", review.json().await);
    let review_body = review.json().await;
    assert_eq!(review_body["decision"], json!("approved"));
    assert_eq!(review_body["reviewer_kind"], json!("user"));
    assert_eq!(review_body["reviewer_user"], json!(user));
    assert_eq!(review_body["reviewer_agent"], json!(null));
    assert_eq!(review_body["reviewer_label"], json!(member_label));
    assert_eq!(review_body["task"], json!(task_id));

    // The review row exists, the task transitioned to done, an activity landed.
    assert_eq!(count_reviews(task_id).await, 1);
    assert_eq!(task_status(task_id).await, TaskflowTaskStatus::Done, "approved → done");
    assert_eq!(count_reviewed_activity(task_id).await, 1);

    // A report-back message referencing the task landed in the project room, sent
    // as the human reviewer, so the assigned agent surfaces it.
    assert_eq!(count_task_messages(task_id).await, 1, "one report-back message");
    let msg = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::TASK.eq(task_id))
        .first()
        .await
        .expect("load message")
        .expect("message exists");
    assert_eq!(msg.channel.id(), room, "posted into the project room");
    assert_eq!(msg.sender_label, member_label, "sent as the reviewer");
    assert!(msg.body_markdown.contains("approved"), "body names the decision");
    assert!(msg.body_markdown.contains("LGTM"), "body carries the review note");
    // The message references the task, so the assigned agent surfaces it.
    assert_eq!(msg.task.as_ref().map(|fk| fk.id()), Some(task_id));
    let _ = agent_id;
}

// An agent reviewer requests changes: the review row records the agent identity,
// the task moves back to in_progress, and a report-back message is created.
#[tokio::test]
async fn agent_review_changes_requested() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    seed_channel_of_kind(project, TaskflowChannelKind::Project).await;

    // The assignee agent authors + claims the task and requests review.
    let (assignee_key, assignee_id) = mint_agent(&app, user, project, "Builder", "main").await;
    let task_id = app
        .post_as_agent(
            &assignee_key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "Refactor module", "claim": true }),
        )
        .await
        .json()
        .await["id"]
        .as_i64()
        .unwrap();
    app.post_as_agent(
        &assignee_key,
        &format!("/api/taskflow/agents/tasks/{task_id}/status"),
        json!({ "status": "partial_done" }),
    )
    .await;

    // A DIFFERENT agent reviews it and requests changes.
    let (reviewer_key, reviewer_id) = mint_agent(&app, user, project, "Reviewer", "main").await;
    let review = app
        .post_as_agent(
            &reviewer_key,
            &format!("/api/taskflow/tasks/{task_id}/agent/review"),
            json!({ "decision": "changes_requested", "body_markdown": "Please add tests." }),
        )
        .await;
    assert_eq!(review.status(), 200, "body: {:?}", review.json().await);
    let review_body = review.json().await;
    assert_eq!(review_body["decision"], json!("changes_requested"));
    assert_eq!(review_body["reviewer_kind"], json!("agent"));
    assert_eq!(review_body["reviewer_agent"], json!(reviewer_id));
    assert_eq!(review_body["reviewer_user"], json!(null));
    assert_eq!(review_body["reviewer_label"], json!("Reviewer"));

    assert_ne!(reviewer_id, assignee_id, "reviewer is a distinct agent");
    assert_eq!(count_reviews(task_id).await, 1);
    assert_eq!(
        task_status(task_id).await,
        TaskflowTaskStatus::InProgress,
        "changes_requested → in_progress"
    );
    assert_eq!(count_reviewed_activity(task_id).await, 1);

    // The report-back message referencing the task was created (the task has an
    // assigned agent — the original assignee).
    assert_eq!(count_task_messages(task_id).await, 1);
    let msg = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::TASK.eq(task_id))
        .first()
        .await
        .expect("load message")
        .expect("message exists");
    assert!(msg.body_markdown.contains("changes requested"));
    assert!(msg.body_markdown.contains("Please add tests."));
}

// Reviewing requires access to the task's project: a non-member human and a
// foreign-project agent are both rejected with 403, and neither writes a review.
#[tokio::test]
async fn review_requires_access() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_active_project_member(project, owner).await;
    seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (owner_key, _owner_agent) = mint_agent(&app, owner, project, "Builder", "main").await;

    let task_id = app
        .post_as_agent(
            &owner_key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "Guarded task", "claim": true }),
        )
        .await
        .json()
        .await["id"]
        .as_i64()
        .unwrap();

    // A logged-in human who is NOT a member of the project cannot review → 403.
    let outsider = app.create_user().await;
    let human = app
        .post_as(
            outsider,
            &format!("/api/taskflow/tasks/{task_id}/review"),
            json!({ "decision": "approved" }),
        )
        .await;
    assert_eq!(human.status(), 403, "non-member human is rejected");

    // A foreign-project agent cannot review → 403.
    let other_project = seed_project().await;
    make_active_project_member(other_project, owner).await;
    let (foreign_key, _foreign_agent) =
        mint_agent(&app, owner, other_project, "Outsider", "main").await;
    let agent = app
        .post_as_agent(
            &foreign_key,
            &format!("/api/taskflow/tasks/{task_id}/agent/review"),
            json!({ "decision": "approved" }),
        )
        .await;
    assert_eq!(agent.status(), 403, "foreign-project agent is rejected");

    // Neither rejected review wrote a row, and the task is untouched.
    assert_eq!(count_reviews(task_id).await, 0);
    assert_eq!(task_status(task_id).await, TaskflowTaskStatus::NotStarted);
}

// #37: a task the agent OPERATES but was never assigned (assigned_agent_id null,
// operator_agent_id set) must still notify that agent on review — the report-back
// used to gate on assigned_agent_id alone and silently notified nobody.
#[tokio::test]
async fn human_review_notifies_the_operator_agent_when_not_assigned() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (_key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // Operator-only task: no assigned_agent_id, operator_agent_id = the agent.
    let task_id = TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: "Operator task".to_string(),
            description_markdown: "do it".to_string(),
            notes_markdown: None,
            status: TaskflowTaskStatus::PartialDone,
            priority: TaskflowTaskPriority::Normal,
            sort_order: 0,
            created_by: None,
            assigned_user: None,
            assigned_agent_id: None,
            review_gate: None,
            estimate_minutes: None,
            operator_user: None,
            operator_agent_id: Some(agent_id),
            created_by_agent_id: None,
            assignee_label: None,
            due_at: None,
            closed_at: None,
            github_issue_number: None,
            github_issue_url: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task")
        .id;

    let review = app
        .post_as(
            user,
            &format!("/api/taskflow/tasks/{task_id}/review"),
            json!({ "decision": "changes_requested", "body_markdown": "tweak X" }),
        )
        .await;
    assert_eq!(review.status(), 200, "body: {:?}", review.json().await);

    // The report-back exists and is directed at the OPERATOR agent.
    assert_eq!(count_task_messages(task_id).await, 1, "operator-only task still notifies");
    let msg = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::TASK.eq(task_id))
        .first()
        .await
        .expect("load message")
        .expect("message exists");
    assert_eq!(msg.channel.id(), room);
    assert_eq!(
        msg.target_agent.as_ref().map(|fk| fk.id()),
        Some(agent_id),
        "directed at the operator agent"
    );
    assert!(msg.body_markdown.contains("changes requested"));
    assert!(msg.body_markdown.contains("tweak X"));
}
