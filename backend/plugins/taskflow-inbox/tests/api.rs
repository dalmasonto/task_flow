//! #1116: the inbox.
//!
//! What must hold: it shows what needs THIS person (a prompt aimed at someone
//! else does not), a DM they are not on never leaks in, an answered question
//! leaves, and "mark all read" changes the unread count without touching the
//! items.

mod support;

use chrono::Utc;
use serde_json::{Value, json};
use support::{TestApp, seed_agent_key, seed_member, seed_project};

use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentMessage, TaskflowAgentPrompt, TaskflowAgentSession, TaskflowAgentSessionStatus,
    TaskflowChannelKind, TaskflowChannelMemberKind, TaskflowMessageAnswer, TaskflowMessagePriority, TaskflowPromptStatus,
};
use umbral::orm::ForeignKey;

async fn channel(project: i64, kind: TaskflowChannelKind) -> i64 {
    TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0, project: ForeignKey::new(project), title: "room".into(), topic: None, kind, task: None,
            created_by_user: None, created_by_agent: None, archived: false, is_public: false, is_design: false, created_at: None,
        })
        .await
        .unwrap()
        .id
}

async fn message(project: i64, channel: i64, agent: i64, body: &str, targets: Option<Value>, questions: Option<Value>) -> i64 {
    TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            thread_root: None,
            in_channel: true,
            id: 0, project: ForeignKey::new(project), channel: ForeignKey::new(channel), task: None,
            sender_kind: TaskflowChannelMemberKind::Agent, sender_user: None, sender_agent: Some(ForeignKey::new(agent)),
            target_agent: None, targets: targets.map(|t| t.to_string()), sender_label: "Agent".into(),
            body_markdown: body.into(), priority: TaskflowMessagePriority::Normal, is_design: false, client_nonce: None,
            edited_at: None, reply_to: None, questions: questions.map(|q| q.to_string()), created_at: None,
        })
        .await
        .unwrap()
        .id
}

async fn prompt(project: i64, agent: i64, target: Option<i64>, status: TaskflowPromptStatus) -> i64 {
    let session = TaskflowAgentSession::objects()
        .create(TaskflowAgentSession {
            id: 0, project: ForeignKey::new(project), agent: ForeignKey::new(agent), connected_by: None,
            session_identifier: format!("s-{}", umbral_testing::seq()), host: None, pid: None, cwd: None, transport: None,
            status: TaskflowAgentSessionStatus::Connected, connected_at: Utc::now(), last_seen_at: Some(Utc::now()),
            disconnected_at: None, created_at: None,
        })
        .await
        .unwrap();
    TaskflowAgentPrompt::objects()
        .create(TaskflowAgentPrompt {
            id: 0, project: ForeignKey::new(project), agent: ForeignKey::new(agent), session: ForeignKey::new(session.id),
            target_user: target.map(ForeignKey::new), question: "Run npm run build?".into(),
            options_json: json!(["Yes", "No"]).to_string(), kind: "single".into(),
            fingerprint: format!("f-{}", umbral_testing::seq()), status, answer: None, answer_json: None,
            answer_text_json: None, answered_by: None, answered_at: None, created_at: None,
        })
        .await
        .unwrap()
        .id
}

fn kinds(v: &Value) -> Vec<String> {
    v["items"].as_array().unwrap().iter().map(|i| i["kind"].as_str().unwrap().to_string()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_inbox_gathers_what_needs_this_person_and_nothing_else() {
    let app = TestApp::new().await;
    let (me, project) = seed_project(&app).await;
    seed_member(project, me.id, "owner").await;
    let other = app.create_user().await;
    seed_member(project, other, "developer").await;
    let (_, agent) = seed_agent_key(project, &[]).await;
    let room = channel(project, TaskflowChannelKind::Project).await;
    let dm = channel(project, TaskflowChannelKind::Direct).await; // I am NOT on its roster

    let mine = prompt(project, agent, Some(me.id), TaskflowPromptStatus::Pending).await;
    let _theirs = prompt(project, agent, Some(other), TaskflowPromptStatus::Pending).await;
    let _withdrawn = prompt(project, agent, None, TaskflowPromptStatus::Cancelled).await;
    let q = json!({ "questions": [ { "key": "ship", "label": "Ship?", "type": "yes_no" } ] });
    let asked = message(project, room, agent, "One call.", None, Some(q.clone())).await;
    let _secret = message(project, dm, agent, "in a DM", None, Some(q)).await;
    let _mention = message(project, room, agent, &format!("[@me](user:{}) look", me.id), None, None).await;
    let _not_me = message(project, room, agent, &format!("[@them](user:{other}) look"), None, None).await;
    let d = taskflow_decisions::service::ask(
        project,
        &taskflow_decisions::service::Actor::Agent { id: agent, label: "Agent".into() },
        taskflow_decisions::service::AskInput {
            key: "pick-palette".into(), question: "Palette?".into(), context_markdown: None, options: vec![],
            ruler_user: None, task_ids: vec![], channel: None,
        },
    )
    .await;
    assert!(d.is_ok());

    let needs = app.get_as(me.id, "/api/taskflow/inbox").await.json().await;
    let mut k = kinds(&needs);
    k.sort();
    assert_eq!(k, vec!["decision", "prompt", "question"], "{needs}");
    let p = needs["items"].as_array().unwrap().iter().find(|i| i["kind"] == "prompt").unwrap();
    assert_eq!(p["prompt"], mine, "only the prompt aimed at me");
    assert_eq!(p["answer_path"], format!("/api/taskflow/prompts/{mine}/answer"));
    let qi = needs["items"].as_array().unwrap().iter().find(|i| i["kind"] == "question").unwrap();
    assert_eq!(qi["message"], asked, "the DM question never appears");
    assert_eq!(needs["counts"]["needs_you"], 3);
    assert_eq!(needs["counts"]["mentions"], 1);

    let mentions = app.get_as(me.id, "/api/taskflow/inbox?tab=mentions").await.json().await;
    assert_eq!(kinds(&mentions), vec!["mention"]);
    let everything = app.get_as(me.id, "/api/taskflow/inbox?tab=everything").await.json().await;
    assert!(kinds(&everything).contains(&"prompt_withdrawn".to_string()));

    // An answered question leaves the inbox.
    TaskflowMessageAnswer::objects()
        .create(TaskflowMessageAnswer {
            id: 0, project: ForeignKey::new(project), channel: ForeignKey::new(room), message: ForeignKey::new(asked),
            key: "ship".into(), value_json: "true".into(), answered_by_kind: TaskflowChannelMemberKind::User,
            answered_by_user: Some(ForeignKey::new(other)), answered_by_agent: None, answered_by_label: "them".into(),
            reply_message_id: None, created_at: None,
        })
        .await
        .unwrap();
    let after = app.get_as(me.id, "/api/taskflow/inbox").await.json().await;
    assert!(!kinds(&after).contains(&"question".to_string()));
}

#[tokio::test(flavor = "multi_thread")]
async fn mark_all_read_clears_the_unread_count_but_keeps_the_items() {
    let app = TestApp::new().await;
    let (me, project) = seed_project(&app).await;
    seed_member(project, me.id, "owner").await;
    let (_, agent) = seed_agent_key(project, &[]).await;
    prompt(project, agent, None, TaskflowPromptStatus::Pending).await;

    let before = app.get_as(me.id, "/api/taskflow/inbox").await.json().await;
    assert_eq!(before["unread"], 1);
    assert_eq!(app.post_json_as(me.id, "/api/taskflow/inbox/read", json!({})).await.status(), 200);
    let after = app.get_as(me.id, "/api/taskflow/inbox").await.json().await;
    assert_eq!(after["unread"], 0);
    assert_eq!(after["items"].as_array().unwrap().len(), 1, "read, not removed");
    assert_eq!(after["items"][0]["unread"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn another_projects_items_never_appear() {
    let app = TestApp::new().await;
    let (me, mine) = seed_project(&app).await;
    seed_member(mine, me.id, "owner").await;
    let (_, theirs) = seed_project(&app).await; // I am not a member
    let (_, agent) = seed_agent_key(theirs, &[]).await;
    prompt(theirs, agent, None, TaskflowPromptStatus::Pending).await;
    let inbox = app.get_as(me.id, "/api/taskflow/inbox?tab=everything").await.json().await;
    assert_eq!(inbox["items"], json!([]));
    assert_eq!(app.get_as(me.id, "/api/taskflow/inbox?tab=nope").await.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_open_review_request_naming_me_is_in_needs_you_and_leaves_when_closed() {
    use taskflow_agents::models::{TaskflowReviewRequest, TaskflowReviewRequestStatus};
    use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};
    let app = TestApp::new().await;
    let (me, project) = seed_project(&app).await;
    seed_member(project, me.id, "owner").await;
    let other = app.create_user().await;
    seed_member(project, other, "member").await;
    let (_, agent) = seed_agent_key(project, &[]).await;
    let task = TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0, project: ForeignKey::new(project), title: "t".into(), description_markdown: None, notes_markdown: None,
            status: TaskflowTaskStatus::PartialDone, priority: TaskflowTaskPriority::Normal, sort_order: 0, created_by: None, assigned_user: None,
            assigned_agent_id: None, review_gate: None, estimate_minutes: None, operator_user: None, operator_agent_id: None,
            created_by_agent_id: None, assignee_label: None, due_at: None, closed_at: None, github_issue_number: None,
            github_issue_url: None, github_repo: None, created_at: None, updated_at: None,
        })
        .await
        .unwrap();
    let ask = |reviewer: i64, status: TaskflowReviewRequestStatus| TaskflowReviewRequest {
        id: 0, project: ForeignKey::new(project), task: ForeignKey::new(task.id),
        requester_kind: TaskflowChannelMemberKind::Agent, requester_user: None, requester_agent: Some(ForeignKey::new(agent)),
        requester_label: "bot".into(), reviewer_kind: TaskflowChannelMemberKind::User, reviewer_user: Some(ForeignKey::new(reviewer)),
        reviewer_agent: None, reviewer_label: "r".into(), reviewer_key: format!("user:{reviewer}:{}", status as u8),
        link: Some("https://example.com/pr/1".into()), focus_markdown: None, status, review: None, closed_at: None, created_at: None,
    };
    let open = TaskflowReviewRequest::objects().create(ask(me.id, TaskflowReviewRequestStatus::Open)).await.unwrap();
    TaskflowReviewRequest::objects().create(ask(me.id, TaskflowReviewRequestStatus::Cancelled)).await.unwrap();
    TaskflowReviewRequest::objects().create(ask(other, TaskflowReviewRequestStatus::Open)).await.unwrap();

    let items = app.get_as(me.id, "/api/taskflow/inbox").await.json().await["items"].clone();
    let reqs: Vec<&Value> = items.as_array().unwrap().iter().filter(|i| i["kind"] == "review_request").collect();
    assert_eq!(reqs.len(), 1, "only the open one naming me: {items}");
    assert_eq!(reqs[0]["review_request"], open.id);
    assert_eq!(reqs[0]["link"], "https://example.com/pr/1");

    let mut open = open;
    open.status = TaskflowReviewRequestStatus::Answered;
    TaskflowReviewRequest::objects().save(open).await.unwrap();
    let items = app.get_as(me.id, "/api/taskflow/inbox").await.json().await["items"].clone();
    assert!(!items.as_array().unwrap().iter().any(|i| i["kind"] == "review_request"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daily_update_draft_asks_owners_and_admins_only() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let dev = app.create_user().await;
    seed_member(project, dev, "developer").await;
    let today = Utc::now().date_naive();
    let (draft, _) = taskflow_daily::service::ensure_draft(project, today).await.unwrap();

    let mine = app.get_as(owner.id, "/api/taskflow/inbox").await.json().await["items"].clone();
    let hit: Vec<&Value> = mine.as_array().unwrap().iter().filter(|i| i["kind"] == "daily_update").collect();
    assert_eq!(hit.len(), 1, "{mine}");
    assert_eq!(hit[0]["daily_update"], draft.id);
    let theirs = app.get_as(dev, "/api/taskflow/inbox").await.json().await["items"].clone();
    assert!(!theirs.as_array().unwrap().iter().any(|i| i["kind"] == "daily_update"), "a developer cannot post it, so is not asked");
}

/// #1127: each prompt says whether THIS person may answer it, by the same rule
/// the answer route enforces, so the card doesn't offer buttons that 403.
#[tokio::test]
async fn prompt_items_say_whether_you_can_answer() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let dev = app.create_user().await;
    seed_member(project, dev, "developer").await;
    let (_, agent) = seed_agent_key(project, &[]).await;
    let p = prompt(project, agent, None, TaskflowPromptStatus::Pending).await;

    let find = |v: &serde_json::Value| v["items"].as_array().unwrap().iter().find(|i| i["prompt"] == p).cloned().unwrap();
    let as_owner = app.get_as(owner.id, "/api/taskflow/inbox").await.json().await;
    assert_eq!(find(&as_owner)["can_answer"], true, "{as_owner}");
    let as_dev = app.get_as(dev, "/api/taskflow/inbox").await.json().await;
    assert_eq!(find(&as_dev)["can_answer"], false, "a developer who didn't link it can't: {as_dev}");
}
