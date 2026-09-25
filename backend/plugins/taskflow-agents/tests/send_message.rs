//! The send endpoint is the only trusted write path for messages: it derives
//! the sender from the authenticated identity and refuses non-members.

use serde_json::json;

mod support;
use support::{
    MultipartPart, TestApp, design_room_of, encode_multipart, make_active_project_member,
    seed_channel_of_kind, seed_channel_with_member, seed_channel_without_member, seed_project,
    seed_project_member_off_roster,
};
use taskflow_agents::models::TaskflowChannelKind;
use taskflow_projects::models::TaskflowMembershipStatus;

/// Same idiom as message_attachments.rs's `field` helper: a plain (non-file)
/// multipart part.
fn field(name: &str, value: &str) -> MultipartPart {
    MultipartPart {
        field_name: name.to_string(),
        filename: None,
        content_type: None,
        bytes: value.as_bytes().to_vec(),
    }
}

#[tokio::test]
async fn derives_sender_from_identity_and_ignores_client_claims() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    // The client lies about who it is. The server must not believe it.
    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "hello",
                "sender_label": "Totally The CEO",
                "sender_user": 9999,
                "sender_kind": "agent",
            }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let row = response.json().await;
    assert_eq!(row["sender_user"], json!(user));
    assert_eq!(row["sender_kind"], json!("user"));
    // Pin the actual derived value, not merely "not the client's lie" — the
    // latter would also pass for null, "", or any other wrong value.
    assert_eq!(row["sender_label"], json!(format!("Member {user}")));
}

#[tokio::test]
async fn rejects_non_member_with_403() {
    let app = TestApp::new().await;
    let (channel, outsider) = seed_channel_without_member(&app).await;

    let response = app
        .post_as(
            outsider,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "let me in",
            }),
        )
        .await;

    assert_eq!(response.status(), 403);
}

// A user who joined a project via invite gets a `TaskflowProjectMember` but no
// channel-roster row. They can see and read the project's shared rooms (SP-A
// scoping), so they must be able to POST in them too — this is the reported bug.
#[tokio::test]
async fn active_project_member_off_roster_can_post_in_project_channel() {
    let app = TestApp::new().await;
    let (channel, user, display_name) = seed_project_member_off_roster(
        &app,
        TaskflowChannelKind::Project,
        TaskflowMembershipStatus::Active,
    )
    .await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "posting as a project member",
            }),
        )
        .await;

    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    let row = response.json().await;
    assert_eq!(row["sender_user"], json!(user));
    assert_eq!(row["sender_kind"], json!("user"));
    // The label is the project-member display_name — a real, non-empty value,
    // not "" and not a fabricated one.
    assert_eq!(row["sender_label"], json!(display_name));
}

// DMs stay private to their explicit roster. Project membership must NOT let a
// user into a Direct channel they were never added to.
#[tokio::test]
async fn active_project_member_off_roster_cannot_post_in_direct_channel() {
    let app = TestApp::new().await;
    let (channel, user, _) = seed_project_member_off_roster(
        &app,
        TaskflowChannelKind::Direct,
        TaskflowMembershipStatus::Active,
    )
    .await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "let me into this DM",
            }),
        )
        .await;

    assert_eq!(response.status(), 403);
}

// A non-active (suspended) project member has no live access to the project, so
// the fallback must not authorize them even in a shared room.
#[tokio::test]
async fn suspended_project_member_cannot_post_in_project_channel() {
    let app = TestApp::new().await;
    let (channel, user, _) = seed_project_member_off_roster(
        &app,
        TaskflowChannelKind::Project,
        TaskflowMembershipStatus::Suspended,
    )
    .await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "suspended but trying",
            }),
        )
        .await;

    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn rejects_unknown_channel_with_404() {
    let app = TestApp::new().await;
    let (_, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": 999999,
                "body_markdown": "into the void",
            }),
        )
        .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn rejects_empty_body_with_400() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "   ",
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn rejects_body_over_max_chars_with_400() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                // One past MAX_BODY_CHARS (10 MiB). The old 20_001 tested a
                // 20k cap that was raised long ago, so it green-lit bodies the
                // server actually accepts.
                "body_markdown": "a".repeat(10 * 1024 * 1024 + 1),
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn same_nonce_twice_inserts_once_and_returns_the_stored_row() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;
    let body = json!({
        "channel": channel,
        "body_markdown": "only once",
        "client_nonce": "nonce-abc-123",
    });

    let first = app
        .post_as(user, "/api/taskflow/agents/messages", body.clone())
        .await;
    let second = app
        .post_as(user, "/api/taskflow/agents/messages", body)
        .await;

    assert_eq!(first.status(), 200);
    assert_eq!(second.status(), 200);
    assert_eq!(first.json().await["id"], second.json().await["id"]);
    assert_eq!(app.count_messages(channel).await, 1);
}

#[tokio::test]
async fn derives_project_from_the_channel() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "scoped",
                "project": 4242,          // client-supplied project is ignored
            }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let row = response.json().await;
    assert_eq!(row["project"], json!(app.project_of_channel(channel).await));
}

// The 403 check MUST run before the idempotency lookup. The nonce is scoped
// to (channel, nonce) only — it carries no sender — so an outsider who
// guesses or observes a nonce must not be able to replay it and have the
// idempotency branch hand back the stored message body. If a future
// refactor "tidies" the handler by moving the idempotency check earlier,
// this test must fail.
#[tokio::test]
async fn non_member_replaying_a_nonce_gets_403_not_the_stored_row() {
    let app = TestApp::new().await;
    let (channel, member) = seed_channel_with_member(&app).await;
    let outsider = app.create_user().await;

    app.post_as(
        member,
        "/api/taskflow/agents/messages",
        json!({
            "channel": channel,
            "body_markdown": "secret plans",
            "client_nonce": "n-1",
        }),
    )
    .await;

    let replay = app
        .post_as(
            outsider,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "gimme",
                "client_nonce": "n-1",
            }),
        )
        .await;

    assert_eq!(replay.status(), 403, "leaked: {:?}", replay.json().await);
}

#[tokio::test]
async fn message_defaults_is_design_false() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({ "channel": channel, "body_markdown": "plain chat" }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let row = response.json().await;
    // The column exists and defaults to false for an ordinary message.
    assert_eq!(row["is_design"], json!(false));
}

// The multipart branch reads `is_design` from a form field (a string), not from
// JSON — a distinct parse path from the JSON branch below — and, like it, the
// value is ACCEPTED AND IGNORED: the destination room decides. Send a file
// alongside it so this genuinely exercises the multipart parser rather than
// falling back to JSON.
#[tokio::test]
async fn multipart_send_accepts_but_ignores_the_declared_design_flag() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "design ask via multipart"),
        field("is_design", "true"),
    ]);

    let response = app
        .post_multipart_as(user, "/api/taskflow/agents/messages", &content_type, body)
        .await;

    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    let row = response.json().await;
    assert_eq!(
        row["is_design"],
        json!(false),
        "the request is not rejected, and the flag follows the room it landed in"
    );
}

// The design flag is DERIVED from the destination, not declared. A client that
// still sends `is_design: true` to an ordinary room is neither rejected nor
// obeyed: the message lands where it was addressed and the stored flag tells the
// truth about it. (The other direction — a message in the design room becoming a
// design message with nothing declared — is pinned in `design_room.rs`, which
// also covers the agent path.)
#[tokio::test]
async fn human_send_accepts_but_ignores_the_declared_design_flag() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({ "channel": channel, "body_markdown": "design ask", "is_design": true }),
        )
        .await;

    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json().await["is_design"],
        json!(false),
        "an ordinary room's message is not a design message, whatever was declared"
    );

    // The same declaration sent to the DESIGN room stores true — the flag is a
    // fact about the room, so the two rooms answer differently for one body.
    // (This user is rostered on the ordinary room above but is not a project
    // member yet; the design room is project-wide, so posting there needs the
    // membership the send gate falls back to.)
    let project = app.project_of_channel(channel).await;
    make_active_project_member(project, user).await;
    let design = design_room_of(project).await;
    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({ "channel": design, "body_markdown": "design ask", "is_design": true }),
        )
        .await;
    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    assert_eq!(response.json().await["is_design"], json!(true));
}

// ---------------------------------------------------------------------------
// The AGENT send route (`/api/taskflow/agents/agent/messages`). Same idiom as
// message_attachments.rs's agent-path helpers: an agent-authed key, a project
// room it may post in by project scope alone.
// ---------------------------------------------------------------------------

const AGENT_SEND: &str = "/api/taskflow/agents/agent/messages";

/// Mint a fresh agent key in `project` (the human minting it must be an active
/// project member). Returns the raw `tfk_…` key.
async fn mint_agent_key(app: &TestApp, project: i64, label: &str) -> String {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(
            human,
            "/api/taskflow/agents/link",
            json!({
                "project": project,
                "display_name": label,
                "profile": label,
            }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    resp.json().await["key"]
        .as_str()
        .expect("minted key")
        .to_string()
}

/// A shared project room the agent may post in by project scope alone, plus a
/// key for an agent in that project. Returns `(channel, key)`.
async fn seed_channel_with_agent(app: &TestApp) -> (i64, String) {
    let project = seed_project().await;
    let channel = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let key = mint_agent_key(app, project, "Design Agent").await;
    (channel, key)
}

// The agent path obeys the same rule as the human one: the declared flag is
// accepted and ignored, and the destination decides. An agent that posts to the
// ordinary room with `is_design: true` gets an ordinary message — visibly in the
// room it addressed, rather than silently placed by a declaration.
#[tokio::test]
async fn agent_send_accepts_but_ignores_the_declared_design_flag() {
    let app = TestApp::new().await;
    // Reuse the same seeding the other agent-path tests use to get an agent
    // credential + a channel the agent is a member of.
    let (channel, key) = seed_channel_with_agent(&app).await;

    let response = app
        .post_as_agent(
            &key,
            AGENT_SEND,
            json!({ "channel": channel, "body_markdown": "design reply", "is_design": true }),
        )
        .await;

    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    assert_eq!(response.json().await["is_design"], json!(false));

    // And posting into the DESIGN room makes it a design message with nothing
    // declared at all.
    let design = design_room_of(app.project_of_channel(channel).await).await;
    let response = app
        .post_as_agent(
            &key,
            AGENT_SEND,
            json!({ "channel": design, "body_markdown": "design reply" }),
        )
        .await;
    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    assert_eq!(
        response.json().await["is_design"],
        json!(true),
        "the design room makes an agent's message a design message"
    );
}
