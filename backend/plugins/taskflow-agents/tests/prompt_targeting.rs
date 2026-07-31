//! #6: a reported prompt is targeted at the agent's "current DM" user — the
//! sender of the most recent human message in a Direct channel the agent is on —
//! so the dashboard shows the question only to that person. No DM history → the
//! target is null and the prompt stays project-wide.

mod support;
use serde_json::{Value, json};
use support::{TestApp, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::{
    TaskflowAgentMessage, TaskflowChannelKind, TaskflowChannelMemberKind, TaskflowMessagePriority,
};
use umbral::orm::ForeignKey;

const OPTIONS: &str = r#"[{"number":1,"label":"Red"},{"number":2,"label":"Green"}]"#;

async fn mint(app: &TestApp, user: i64, project: i64) -> (i64, String) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Builder", "profile": "main" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    let body = resp.json().await;
    (
        body["agent_id"].as_i64().expect("agent_id"),
        body["key"].as_str().expect("key").to_string(),
    )
}

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

async fn register_session(app: &TestApp, key: &str) -> i64 {
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resp = app
        .post_as_agent(
            key,
            "/api/taskflow/agents/sessions",
            json!({ "session_identifier": format!("target:pane:{n}"), "host": "t", "pid": 1, "cwd": "/tmp" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "register failed");
    resp.json().await["id"].as_i64().expect("session id")
}

/// Report a prompt and return the created row's JSON (which carries target_user).
async fn report_prompt(app: &TestApp, key: &str, session: i64, fingerprint: &str) -> Value {
    let resp = app
        .post_as_agent(
            key,
            &format!("/api/taskflow/agents/sessions/{session}/prompt"),
            json!({ "question": "Which?", "options_json": OPTIONS, "kind": "single", "fingerprint": fingerprint }),
        )
        .await;
    assert_eq!(resp.status(), 200, "report failed: {:?}", resp.json().await);
    resp.json().await
}

/// A human message from `user` in `channel`.
async fn user_message(project: i64, channel: i64, user: i64) {
    TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            task: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: Some(ForeignKey::new(user)),
            sender_agent: None,
            target_agent: None,
            targets: None,
            sender_label: "dalmas".to_string(),
            body_markdown: "please do X".to_string(),
            priority: TaskflowMessagePriority::Normal,
            client_nonce: None,
            edited_at: None,
            created_at: None,
        })
        .await
        .expect("create message");
}

#[tokio::test]
async fn a_prompt_targets_the_user_of_the_agents_current_dm() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (agent_id, key) = mint(&app, user, project).await;
    let session = register_session(&app, &key).await;

    // A DM (a Direct channel the agent is on) with a human message from `user`.
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    app.add_agent_to_channel_roster(project, dm, agent_id).await;
    user_message(project, dm, user).await;

    let prompt = report_prompt(&app, &key, session, "fp-1").await;
    assert_eq!(prompt["target_user"], json!(user), "the prompt targets the DM user");
}

#[tokio::test]
async fn a_prompt_with_no_dm_history_targets_nobody() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_agent_id, key) = mint(&app, user, project).await;
    let session = register_session(&app, &key).await;

    let prompt = report_prompt(&app, &key, session, "fp-2").await;
    assert_eq!(prompt["target_user"], Value::Null, "no DM history → project-wide (null)");
}

#[tokio::test]
async fn a_message_in_a_non_direct_channel_does_not_target() {
    // A project-room message is not a DM and must not target its sender.
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (agent_id, key) = mint(&app, user, project).await;
    let session = register_session(&app, &key).await;

    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    app.add_agent_to_channel_roster(project, room, agent_id).await;
    user_message(project, room, user).await;

    let prompt = report_prompt(&app, &key, session, "fp-3").await;
    assert_eq!(prompt["target_user"], Value::Null, "a project-room message is not a DM");
}
